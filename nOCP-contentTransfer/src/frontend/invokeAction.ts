// Port of the source app's src/cms-ui-extensions/content-transfer/
// invokeAction.ts — context.extension.invokeFunction(...) swapped for a
// plain fetch('/content-transfer/api', ...) call carrying
// X-Nocp-Frame-Token, exactly nocp-frontify's widget.tsx's own inline
// callAction() helper (see that app's CLAUDE.md — "the widget itself calls
// back to its own backend... after the initial page load, and those
// follow-up fetch() calls are same-page XHRs, not frame navigations, so
// they never carry Sec-Fetch-Dest: iframe"). Kept as its own module (unlike
// nocp-frontify's inline version) since this app's frontend is 5 separate
// component files that all need to call actions, not one single widget
// file. captureEmbeddingDiagnostics() ports verbatim — plain
// window.location reads, no OCP dependency. The ExtensionContext param is
// dropped entirely; the frame token is set once at bootstrap (see
// widget.tsx) via setFrameToken(), read from window.__NOCP_CONFIG__.
import type {Envelope} from './types';

// Just under the Function URL's own ~30s buffered-response ceiling — a
// transfer's actual work happens across many polled checkpoints (see
// jobStore.ts), not inside any single startTransfer/getTransferProgress
// call, so those calls stay cheap regardless of how big the underlying
// plan is.
const TIMEOUT_MS = 27_000;

const FRIENDLY_ERRORS: Record<string, string> = {
  not_configured: 'This app hasn’t been set up yet — open the app’s Settings and enter your CMAPI credentials for at least one environment.',
  unknown_target: 'That target environment is no longer configured — refresh and pick another.',
  // Fallbacks only — the backend always sends a specific `message` for
  // these (see actions.ts's describeResolveFailure), which
  // describeEnvelopeError prefers over this map.
  hostname_unresolvable: 'Could not determine which CMS environment this sidebar is running on.',
  hostname_not_matched: 'This CMS environment doesn’t match any configured Match Pattern in Settings.',
};

/** Turns an envelope's error code/message into something worth showing a user. */
export function describeEnvelopeError(envelope: Envelope<unknown>): string {
  if (envelope.ok) return '';
  return envelope.message || FRIENDLY_ERRORS[envelope.error] || envelope.error;
}

/** Best-effort snapshot of this sidebar iframe's own embedding — see environments.ts's findEnvironmentForHostname for how the backend uses this to resolve the "source" environment. */
function captureEmbeddingDiagnostics(): Record<string, unknown> {
  try {
    const ancestorOrigins = window.location.ancestorOrigins;
    return {
      referrer: document.referrer || null,
      ancestorOrigins: ancestorOrigins ? Array.from(ancestorOrigins) : null,
      href: window.location.href,
    };
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)};
  }
}

let frameToken = '';

/** Set once at widget bootstrap from window.__NOCP_CONFIG__ (see widget.tsx) — every component calling invokeAction reads the same module-level value rather than each needing it threaded in as a prop. */
export function setFrameToken(token: string): void {
  frameToken = token;
}

/** Wraps the /content-transfer/api fetch() with a hard timeout, so a hung or extremely slow backend call can't leave the UI spinning forever with no explanation. */
export async function invokeAction<T>(
  action: string,
  params: Record<string, unknown>,
): Promise<Envelope<T>> {
  const paramsWithDiag = {...params, _diag: captureEmbeddingDiagnostics()};
  const call = fetch('/content-transfer/api', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Nocp-Frame-Token': frameToken},
    body: JSON.stringify({action, params: paramsWithDiag}),
  }).then((response) => response.json() as Promise<Envelope<T>>);

  const timeout = new Promise<Envelope<T>>((resolve) => {
    setTimeout(() => resolve({
      ok: false,
      error: 'timeout',
      message: 'The CMS took too long to respond. Try again.',
    }), TIMEOUT_MS);
  });

  return Promise.race([call, timeout]);
}
