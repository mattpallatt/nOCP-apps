// The entire app, expressed as one function against the standard Web
// Request/Response objects (the same shapes `fetch()` uses) instead of any
// platform-specific event/context types. This is what makes "hosted
// anywhere" true rather than aspirational: every serverless host and every
// plain Node server can be adapted to call a function shaped
// `(Request) => Promise<Response>` in a handful of lines — see
// src/lambda.ts (AWS) and src/serve-local.ts (plain Node) for the two
// adapters this starter ships, and the README for what a third one needs.
//
// Nothing in this file imports "aws-lambda" or any AWS SDK — that's the
// whole point. Keep it that way; if a route needs something host-specific,
// that's a sign it belongs in an adapter, not here.
import widgetJs from "../dist/widget.txt";
import type { WebhookStore } from "./webhookStore";

export interface AppConfig {
  /** Shared secret the nOCP extension sends as ?token=. Required. */
  frameToken: string;
  /** Browser tab title for the widget page. */
  title: string;
}

const BLOCKED_HTML =
  '<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#444">' +
  "<p>This app can only be opened from within the CMS sidebar.</p></body></html>";

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// The title comes from an env var here (no admin page to edit it live in
// this starter — see README), but escape it anyway: cheap, and it's what
// stops this from becoming a real bug the moment someone wires a settings
// page back in and forgets this line still matters.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// nOCP app spec §6: every app exposes POST /nocp/webhook, deliberately
// open at the route level (the caller is an arbitrary external service
// with its own auth/signing scheme — a shared secret of ours in front
// would just conflict with it). This reference implementation only
// records the event; a real integration validates whatever signature its
// specific sender expects before trusting the payload.
async function processWebhook(request: Request, store: WebhookStore): Promise<Response> {
  await store.record({
    id: crypto.randomUUID(),
    receivedUtc: new Date().toISOString(),
    method: request.method,
    headers: Object.fromEntries(request.headers),
    bodyText: await request.text(),
  });
  return json({ received: true });
}

/**
 * Builds the app's request handler. Call this once per process (each
 * adapter does this exactly once, at module load) and reuse the returned
 * function for every request.
 */
export function createApp(config: AppConfig, store: WebhookStore) {
  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return json({ status: "ok" });
    }

    // nOCP app spec §7 — optional, but free to satisfy here: config.title
    // is already the only piece of this app's identity that exists (no
    // settings page in this starter — see README), so /nocp/meta just
    // echoes it. hasIcon is always false: this minimal template has no
    // persistence to upload one into (nocp-widget's settings-page pattern
    // is what adds that back — see "What's different from nocp-widget"),
    // so it correctly tells the extension to use its own default icon
    // rather than requesting a /nocp/icon route this starter doesn't
    // implement at all. displayMode is hardcoded 'sidebar' — change it if
    // what you build from this is meant to be a full-page app instead.
    // Access-Control-Allow-Origin is required by spec: the extension's
    // Options page reads this via plain cross-origin fetch(), which needs
    // it on every response, this 200 included.
    if (path === "/nocp/meta" && request.method === "GET") {
      return new Response(
        JSON.stringify({ specVersion: 1, name: config.title, displayMode: "sidebar", hasIcon: false }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } },
      );
    }

    if (path === "/nocp/webhook" && request.method === "POST") {
      return processWebhook(request, store);
    }

    // Everything else is the gated widget route. Per nOCP app spec §1: a
    // shared-secret token in the query string (embedded by the nOCP
    // extension when it sets the overlay iframe's src) plus
    // Sec-Fetch-Dest: iframe, which Chrome sets on a frame's own
    // top-level document load and cannot be produced by a direct
    // address-bar navigation. Both required — neither alone is enough.
    const token = url.searchParams.get("token") ?? "";
    const secFetchDest = (request.headers.get("sec-fetch-dest") ?? "").toLowerCase();
    const tokenOk = config.frameToken.length > 0 && token === config.frameToken;
    const frameOk = secFetchDest === "iframe";

    if (!tokenOk || !frameOk) {
      return html(BLOCKED_HTML, 403);
    }

    const page =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
      escapeHtml(config.title) +
      "</title>" +
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">' +
      '<style>html,body{margin:0;padding:0;}body{font-family:\'Inter\',sans-serif;font-size:14px;}</style></head>' +
      '<body><div id="app"></div><script>' +
      widgetJs +
      "</script></body></html>";

    return html(page);
  };
}
