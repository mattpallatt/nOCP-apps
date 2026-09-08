// Port of the source app's src/cms-ui-extensions/content-transfer/
// ContentTransfer.sidebar.tsx — mostly verbatim (AxiomProvider, the
// font-size override, the 2-tab Tabs shell). OCP's register() mount is
// swapped for nocp-frontify's createRoot()+window.__NOCP_CONFIG__
// bootstrap (see that app's CLAUDE.md, "Widget: React kept, and Axiom is
// back — this time for real" for the full Axiom integration checklist this
// follows: CSS-splitting via scripts/build-widget.mjs, the Fontsource
// jsDelivr rewrite for the font/CSP trap). The frame token is pushed once
// into invokeAction.ts's module-level holder instead of threaded through
// props/context — every panel calls invokeAction() directly.
import {AxiomProvider, Box, Tabs, TabsContent, TabsList, TabsTrigger} from '@optiaxiom/react';
import {createRoot} from 'react-dom/client';
import type {CSSProperties} from 'react';
import {ModelSyncPanel} from './frontend/ModelSyncPanel';
import {TransferPanel} from './frontend/TransferPanel';
import {setFrameToken} from './frontend/invokeAction';

// Every Text in this app uses only the "xs"/"sm" @optiaxiom/react fontSize
// tokens, which render noticeably smaller (~10px) than the CMS's own
// Settings UI (~14px) — overriding the two CSS custom properties those
// tokens read from, once here, bumps every Text in the app to a consistent
// 14px without touching each individual `fontSize="xs"|"sm"` prop.
const FONT_SIZE_OVERRIDE_STYLE = {
  '--ax-fontSize-xs-fontSize': '14px',
  '--ax-fontSize-xs-lineHeight': '20px',
  '--ax-fontSize-sm-fontSize': '14px',
  '--ax-fontSize-sm-lineHeight': '20px',
} as CSSProperties;

function ContentTransfer() {
  // Zero padding/margin at every level of this widget, full stop — the
  // host (the nOCP Chrome extension's overlay iframe chrome / the CMS
  // sidebar around it) already supplies its own margin around the iframe,
  // so this app's content should sit flush against the iframe's own edges
  // rather than adding a second, redundant inset on top of the host's.
  // (An earlier version of this port kept a single p="12" here, reasoning
  // it should be "one padding, not stacked with each panel's own" — that
  // was still wrong per this rule: the correct count of app-level outer
  // padding for an nOCP widget is zero, not one.)
  return (
    <Box style={FONT_SIZE_OVERRIDE_STYLE} w="full">
      <Tabs defaultValue="transfer">
        <TabsList style={{borderBottom: 'none'}}>
          <TabsTrigger value="transfer">Transfer Content</TabsTrigger>
          <TabsTrigger value="modelSync">Sync Models</TabsTrigger>
        </TabsList>

        <TabsContent style={{paddingTop: 10}} value="transfer">
          <TransferPanel />
        </TabsContent>

        <TabsContent style={{paddingTop: 10}} value="modelSync">
          <ModelSyncPanel />
        </TabsContent>
      </Tabs>
    </Box>
  );
}

function renderBlocked(): void {
  const target = document.getElementById('app');
  if (target) target.textContent = 'This app can only be opened from within the CMS sidebar.';
}

interface NocpConfig {
  frameToken: string;
}

// Client-side backstop only — the server already refuses to serve real
// content outside an iframe (frame-token + Sec-Fetch-Dest gate, see
// lambda.ts). This just avoids a confusing blank state in the rare case
// someone reaches this document some other way.
if (window.top === window.self) {
  renderBlocked();
} else {
  const config: NocpConfig = (window as unknown as {__NOCP_CONFIG__?: NocpConfig}).__NOCP_CONFIG__ ?? {frameToken: ''};
  setFrameToken(config.frameToken);
  const target = document.getElementById('app');
  if (target) {
    createRoot(target).render(<AxiomProvider><ContentTransfer /></AxiomProvider>);
  }
}
