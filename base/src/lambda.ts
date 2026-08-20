import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import widgetJs from "../dist/widget.txt";
import adminJs from "../dist/admin.txt";
import { putWebhookEvent, listRecentWebhookEvents } from "./webhookStore";
import { getSettings, putSettings, regenerateToken } from "./settingsStore";
import { MAX_IMAGE_BYTES, SETTINGS_SCHEMA, type SettingsValues } from "./settingsSchema";

const BLOCKED_HTML =
  '<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#444">' +
  "<p>This app can only be opened from within the CMS sidebar.</p></body></html>";

function html(body: string, statusCode = 200): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
  };
}

function json(data: unknown, statusCode = 200): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(data),
  };
}

function forbidden(): APIGatewayProxyResultV2 {
  return { statusCode: 403, headers: {}, body: "" };
}

// The title is now admin-editable via the settings page (it used to only
// ever be a deploy-time env var an operator controlled directly) — escape
// it before splicing into HTML rather than trusting it just because the
// admin surface is token-gated.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getBodyText(event: APIGatewayProxyEventV2): string | null {
  if (!event.body) return null;
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;
}

function normalizeHeaders(headers: APIGatewayProxyEventV2["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Separate, independent secret gating the /admin* routes — per the nOCP
// app spec, admin access is never the frame-token check with a bypass
// flag. Passed as a header (never a query param) so it doesn't end up in
// browser history/referrers/logs the way the frame token deliberately can.
function adminTokenOk(event: APIGatewayProxyEventV2, settings: SettingsValues): boolean {
  const headers = event.headers ?? {};
  const provided = headers["x-nocp-admin-token"] ?? headers["X-NOCP-Admin-Token"] ?? "";
  return settings.adminToken.length > 0 && provided === settings.adminToken;
}

// The nOCP app spec's processWebhook: deliberately no gate of our own at
// the route level (the caller is an arbitrary external service with its
// own auth/signing scheme — see NOCP_APP_SPEC.md §6). This reference
// implementation just records events for the admin page's webhook list to
// show; a real integration would validate whatever signature/secret its
// specific sender expects before trusting the payload, then act on it.
async function processWebhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  await putWebhookEvent({
    id: crypto.randomUUID(),
    receivedUtc: new Date().toISOString(),
    method: event.requestContext.http.method,
    headers: normalizeHeaders(event.headers),
    bodyText: getBodyText(event),
  });
  return json({ received: true });
}

const ACCEPTED_IMAGE_DATA_URI = /^data:image\/(png|jpeg|webp);base64,/;

function validateSettingsPatch(values: Record<string, unknown>): string | null {
  for (const field of SETTINGS_SCHEMA) {
    if (field.type === "toggle") continue;
    if (!(field.key in values)) continue;
    const value = values[field.key];

    if (field.type === "image") {
      if (typeof value !== "string") return `${field.label} must be a string.`;
      if (!value) continue; // blank = no icon uploaded — allowed, falls back to the extension's default
      if (!ACCEPTED_IMAGE_DATA_URI.test(value)) {
        return `${field.label} must be a PNG, JPEG, or WebP image.`;
      }
      // Rough decode-free size estimate from the base64 payload length —
      // close enough (within ~1%) for a "did the client-side cap get
      // bypassed somehow" server-side backstop, not an exact accounting.
      const approxBytes = Math.floor((value.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) {
        return `${field.label} must be under ${Math.floor(MAX_IMAGE_BYTES / 1024)}KB.`;
      }
      continue;
    }

    if (typeof value !== "string" || !value.trim()) {
      return `${field.label} cannot be empty.`;
    }
  }
  return null;
}

// GET /admin/settings and POST /admin/settings share the same gate and
// both return the current settings (POST returns the state after applying
// the change) — the client always re-syncs its form from the response
// rather than trusting what it sent.
async function handleSettings(
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const settings = await getSettings();
  if (!adminTokenOk(event, settings)) return forbidden();

  if (method === "GET") {
    return json(settings);
  }

  // POST
  let body: { action?: string; key?: string; values?: Record<string, unknown> };
  try {
    body = JSON.parse(getBodyText(event) ?? "{}");
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  if (body.action === "regenerate") {
    if (body.key !== "frameToken" && body.key !== "adminToken") {
      return json({ error: "key must be frameToken or adminToken." }, 400);
    }
    const updated = await regenerateToken(body.key);
    return json(updated);
  }

  if (body.action === "save") {
    const values = body.values ?? {};
    const validationError = validateSettingsPatch(values);
    if (validationError) return json({ error: validationError }, 400);
    const updated = await putSettings(values as Partial<SettingsValues>);
    return json(updated);
  }

  return json({ error: "Unknown action." }, 400);
}

// Unauthenticated shell — per the nOCP app spec §2, a plain HTML `<form>`
// (or here, a bare page load) can't attach a custom header, so the real
// gate happens client-side: admin.ts prompts for the token, then does all
// actual reads/writes as fetch() calls carrying X-NOCP-Admin-Token. The
// shell itself carries no data, so it's fine for it to be reachable
// without auth — same reasoning NOCP_APP_SPEC.md gives for this pattern.
function renderAdminShell(): APIGatewayProxyResultV2 {
  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>nOCP admin</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">' +
    "<style>" +
    ADMIN_STYLE +
    "</style></head>" +
    '<body><div id="app"></div><div id="toast" class="toast"></div><script>' +
    adminJs +
    "</script></body></html>";
  return html(page);
}

const ADMIN_STYLE = `
html,body{margin:0;padding:0;}
body{font-family:'Inter',sans-serif;font-size:14px;color:#222;background:#f7f7f7;}
#app{max-width:640px;margin:0 auto;padding:32px 20px;}
.token-gate{display:flex;flex-direction:column;gap:8px;max-width:320px;margin:80px auto 0;}
.token-gate label{font-size:12px;text-transform:uppercase;color:#888;}
.token-gate input{padding:8px 10px;font-size:14px;border:1px solid #ccc;border-radius:6px;}
.token-gate button{padding:8px 14px;font-size:14px;border-radius:6px;border:1px solid #1a7a2e;background:#1a7a2e;color:#fff;cursor:pointer;}
.section-title{font-size:16px;font-weight:600;margin:24px 0 12px;}
.section-title:first-child{margin-top:0;}
.field{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px;margin-bottom:10px;}
.field label{display:block;font-size:11px;text-transform:uppercase;color:#888;margin-bottom:4px;}
.field-row{display:flex;gap:6px;}
.field-row input[type="text"],.field-row input[type="password"]{flex:1;padding:6px 8px;font-size:13px;border:1px solid #ccc;border-radius:4px;}
.image-field{display:flex;align-items:center;gap:10px;flex:1;}
.image-preview{width:40px;height:40px;object-fit:contain;border:1px solid #e0e0e0;border-radius:6px;background:#fff;}
.remove-image{padding:4px 8px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;}
.field-row input.mono{font-family:monospace;font-size:12px;background:#f7f7f7;}
.field-row button.regenerate{flex-shrink:0;padding:6px 10px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;}
.field .help{font-size:11px;color:#888;margin:6px 0 0;}
#save-settings{padding:8px 16px;font-size:13px;border-radius:6px;border:1px solid #1a7a2e;background:#1a7a2e;color:#fff;cursor:pointer;margin-top:4px;}
.webhook-row{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:10px 12px;margin-bottom:8px;}
.webhook-meta{font-size:11px;color:#888;margin-bottom:4px;}
.webhook-body{margin:0;font-family:monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);padding:10px 16px;border-radius:6px;font-size:13px;color:#fff;background:#333;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;}
.toast.visible{opacity:1;transform:translateX(-50%) translateY(0);}
.toast.error{background:#a33;}
.toast.success{background:#1a7a2e;}
`;

// NOCP_APP_SPEC.md §7 — an app's display name/icon should live with the
// app, not be hand-copied into the extension's Options page. Both routes
// are unauthenticated (same trust tier as /healthz): a display name and a
// public-facing icon aren't sensitive, and requiring a token here would
// defeat the point (the extension needs to fetch this before it has any
// reason to prove it's authorized). 404 from /nocp/icon when no icon is
// uploaded is deliberate, not an error — it's the signal the extension
// uses to fall back to its own default icon.
//
// Both carry Access-Control-Allow-Origin per the spec — options.js reads
// /nocp/meta via plain cross-origin fetch() (no manifest host_permissions
// grant backs it; see the spec section for why), which needs this on every
// response including the 404 case (a cross-origin fetch() to a response
// with no CORS header doesn't resolve with a readable 404, it just fails
// outright). /nocp/icon is only ever loaded via a plain <img src=...> in
// this extension today, which isn't CORS-gated at all — sent here anyway
// so a future fetch()-based consumer isn't quietly unsupported.
const CORS_HEADERS = { "access-control-allow-origin": "*" };

function iconResponse(icon: string): APIGatewayProxyResultV2 {
  const match = icon.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) return { statusCode: 404, headers: CORS_HEADERS, body: "" };
  const [, contentType, base64Body] = match;
  return {
    statusCode: 200,
    headers: { "content-type": contentType, "cache-control": "public, max-age=300", ...CORS_HEADERS },
    body: base64Body,
    isBase64Encoded: true,
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const path = event.rawPath || "/";
  const method = event.requestContext.http.method;

  if (path === "/healthz") {
    return json({ status: "ok" });
  }

  if (path === "/nocp/meta" && method === "GET") {
    const settings = await getSettings();
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
      // displayMode is hardcoded, not a settings field — this app is a
      // small "what content ID is open" widget, inherently a sidebar tool,
      // not a choice to expose. See NOCP_APP_SPEC.md §7: most apps have
      // one natural shape and should hardcode this rather than making it
      // admin-configurable. hasIcon tells the consumer upfront whether
      // /nocp/icon is worth requesting at all — without it, a consumer
      // pointing its <img> straight at /nocp/icon has no way to tell "no
      // icon uploaded" apart from "icon endpoint is broken."
      body: JSON.stringify({ specVersion: 1, name: settings.title, displayMode: "sidebar", hasIcon: Boolean(settings.icon) }),
    };
  }

  if (path === "/nocp/icon" && method === "GET") {
    const settings = await getSettings();
    return iconResponse(settings.icon);
  }

  if (path === "/nocp/webhook" && method === "POST") {
    return processWebhook(event);
  }

  if ((path === "/admin" || path === "/admin/") && method === "GET") {
    return renderAdminShell();
  }

  if (path === "/admin/settings" && (method === "GET" || method === "POST")) {
    return handleSettings(event, method);
  }

  if (path === "/admin/webhooks" && method === "GET") {
    const settings = await getSettings();
    if (!adminTokenOk(event, settings)) return forbidden();
    return json(await listRecentWebhookEvents());
  }

  // Everything else is the gated widget route. Same two-check gate as
  // reqcatch's Program.cs: a shared-secret token in the query string
  // (embedded by the nOCP extension when it sets the overlay iframe's src)
  // plus Sec-Fetch-Dest: iframe, which Chrome sets on a frame's own
  // top-level document load and cannot be set by a direct address-bar
  // navigation. Both are required so neither alone is sufficient to bypass.
  const settings = await getSettings();
  const token = event.queryStringParameters?.token ?? "";
  const headers = event.headers ?? {};
  const secFetchDest = (headers["sec-fetch-dest"] ?? headers["Sec-Fetch-Dest"] ?? "").toLowerCase();

  const tokenOk = settings.frameToken.length > 0 && token === settings.frameToken;
  const frameOk = secFetchDest === "iframe";

  if (!tokenOk || !frameOk) {
    return html(BLOCKED_HTML, 403);
  }

  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
    escapeHtml(settings.title) +
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
