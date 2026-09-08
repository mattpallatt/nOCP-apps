// Function URL handler — same shape as nocp-frontify's/nocp-base's
// lambda.ts (see nocp-frontify's CLAUDE.md for the reusable pattern this
// follows almost verbatim): hand-rolled routing, frame-token +
// Sec-Fetch-Dest gate on the main widget document, a same-page-fetch()
// frame-token-only gate on /content-transfer/api (the widget's own
// follow-up calls, which never carry Sec-Fetch-Dest: iframe), and a
// separate X-NOCP-Admin-Token-gated /admin surface.
import type {APIGatewayProxyEventV2, APIGatewayProxyResultV2} from 'aws-lambda';
import widgetJs from '../dist/widget.txt';
import widgetCss from '../dist/widgetbuild/widget.css';
import adminJs from '../dist/admin.txt';
import {handleAction} from './actions';
import {
  getSettings,
  putSettings,
  regenerateToken,
  validateSettingsPatch,
  toAdminView,
} from './settingsStore';
import type {SettingsValues} from './settingsSchema';

const BLOCKED_HTML =
  '<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#444">' +
  '<p>This app can only be opened from within the CMS sidebar.</p></body></html>';

function html(body: string, statusCode = 200): APIGatewayProxyResultV2 {
  return {statusCode, headers: {'content-type': 'text/html; charset=utf-8'}, body};
}

function json(data: unknown, statusCode = 200): APIGatewayProxyResultV2 {
  return {statusCode, headers: {'content-type': 'application/json; charset=utf-8'}, body: JSON.stringify(data)};
}

function forbidden(): APIGatewayProxyResultV2 {
  return {statusCode: 403, headers: {}, body: ''};
}

function escapeForScriptTag(value: string): string {
  // Prevents a literal "</script>" inside a JSON string value from closing
  // the script tag early.
  return value.replace(/</g, '\\u003c');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function frameTokenOk(event: APIGatewayProxyEventV2, settings: SettingsValues): boolean {
  const headers = event.headers ?? {};
  const headerToken = headers['x-nocp-frame-token'] ?? headers['X-Nocp-Frame-Token'] ?? '';
  const queryToken = event.queryStringParameters?.token ?? '';
  return settings.frameToken.length > 0 && (headerToken === settings.frameToken || queryToken === settings.frameToken);
}

// Separate, independent secret gating the /admin* routes — admin access is
// never the frame-token check with a bypass flag. Passed as a header
// (never a query param).
function adminTokenOk(event: APIGatewayProxyEventV2, settings: SettingsValues): boolean {
  const headers = event.headers ?? {};
  const provided = headers['x-nocp-admin-token'] ?? headers['X-NOCP-Admin-Token'] ?? '';
  return settings.adminToken.length > 0 && provided === settings.adminToken;
}

function getBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// GET /admin/settings and POST /admin/settings share the same gate; GET
// returns the masked admin view (toAdminView hides every secret-masked
// field — the 6 ClientSecret/ContentGraphSecret fields across the 3
// environment slots), POST returns the masked view of whatever the
// save/regenerate produced.
async function handleSettings(
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const settings = await getSettings();
  if (!adminTokenOk(event, settings)) return forbidden();

  if (method === 'GET') {
    return json(toAdminView(settings));
  }

  const body = getBody(event) as {action?: string; key?: string; values?: Record<string, unknown>};

  if (body.action === 'regenerate') {
    if (body.key !== 'frameToken' && body.key !== 'adminToken') {
      return json({error: 'key must be frameToken or adminToken.'}, 400);
    }
    const updated = await regenerateToken(body.key);
    return json(toAdminView(updated));
  }

  if (body.action === 'save') {
    const values = body.values ?? {};
    const validationError = validateSettingsPatch(values);
    if (validationError) return json({error: validationError}, 400);
    const updated = await putSettings(values);
    return json(toAdminView(updated));
  }

  return json({error: 'Unknown action.'}, 400);
}

// Unauthenticated shell — a bare page load can't attach a custom header, so
// the real gate happens client-side: admin.ts prompts for the token, then
// does all actual reads/writes as fetch() calls carrying
// X-NOCP-Admin-Token. The shell itself carries no data.
function renderAdminShell(): APIGatewayProxyResultV2 {
  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Content Transfer — Admin</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">' +
    '<style>' + ADMIN_STYLE + '</style></head>' +
    '<body><div id="app"></div><div id="toast" class="toast"></div><script>' +
    adminJs +
    '</script></body></html>';
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
.field-row input[type="text"],.field-row input[type="password"],.field-row input[type="number"]{flex:1;padding:6px 8px;font-size:13px;border:1px solid #ccc;border-radius:4px;}
.image-field{display:flex;align-items:center;gap:10px;flex:1;}
.image-preview{width:40px;height:40px;object-fit:contain;border:1px solid #e0e0e0;border-radius:6px;background:#fff;}
.remove-image{padding:4px 8px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;}
.field-row input.mono{font-family:monospace;font-size:12px;background:#f7f7f7;}
.field-row button.regenerate{flex-shrink:0;padding:6px 10px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;}
.field .help{font-size:11px;color:#888;margin:6px 0 0;}
#save-settings{padding:8px 16px;font-size:13px;border-radius:6px;border:1px solid #1a7a2e;background:#1a7a2e;color:#fff;cursor:pointer;margin-top:4px;}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);padding:10px 16px;border-radius:6px;font-size:13px;color:#fff;background:#333;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;}
.toast.visible{opacity:1;transform:translateX(-50%) translateY(0);}
.toast.error{background:#a33;}
.toast.success{background:#1a7a2e;}
`;

// NOCP_APP_SPEC.md §7 — an app's display name/icon should live with the
// app, not be hand-copied into the extension's Options page. Both routes
// are unauthenticated (same trust tier as /healthz) and carry
// Access-Control-Allow-Origin — the extension's Options page reads
// /nocp/meta via plain cross-origin fetch() (no manifest host_permissions
// grant backs it), which needs this on every response including the
// hasIcon:false case, not just 200s with a real icon.
const CORS_HEADERS = {'access-control-allow-origin': '*'};

function iconResponse(icon: string): APIGatewayProxyResultV2 {
  const match = icon.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) return {statusCode: 404, headers: CORS_HEADERS, body: ''};
  const [, contentType, base64Body] = match;
  return {
    statusCode: 200,
    headers: {'content-type': contentType, 'cache-control': 'public, max-age=300', ...CORS_HEADERS},
    body: base64Body,
    isBase64Encoded: true,
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const path = event.rawPath || '/';
  const method = event.requestContext.http.method;

  if (path === '/healthz') {
    return json({status: 'ok'});
  }

  if (path === '/nocp/meta' && method === 'GET') {
    const settings = await getSettings();
    return {
      statusCode: 200,
      headers: {'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS},
      // displayMode hardcoded 'sidebar' — matches the source app's own
      // ui_extensions.sidebar declaration, not a runtime choice.
      body: JSON.stringify({specVersion: 1, name: settings.title, displayMode: 'sidebar', hasIcon: Boolean(settings.icon)}),
    };
  }

  if (path === '/nocp/icon' && method === 'GET') {
    const settings = await getSettings();
    return iconResponse(settings.icon);
  }

  // Action router — POST /content-transfer/api {action, params}. Gated by
  // the same frame token as the widget document itself (sent back by the
  // widget's own JS, embedded into it at initial page load), but without
  // the Sec-Fetch-Dest requirement: this is a same-page fetch() call from
  // already-loaded widget JS, not a fresh frame navigation, so that header
  // won't be "iframe" here the way it is for the document load.
  if (path === '/content-transfer/api' && method === 'POST') {
    const settings = await getSettings();
    if (!frameTokenOk(event, settings)) return forbidden();
    const body = getBody(event) as {action?: unknown; params?: unknown};
    const action = typeof body.action === 'string' ? body.action : '';
    const params = (body.params ?? {}) as Record<string, unknown>;
    const {envelope, status} = await handleAction(action, params);
    return json(envelope, status);
  }

  if ((path === '/admin' || path === '/admin/') && method === 'GET') {
    return renderAdminShell();
  }

  if (path === '/admin/settings' && (method === 'GET' || method === 'POST')) {
    return handleSettings(event, method);
  }

  // Main widget document — frame-token + Sec-Fetch-Dest gate, per
  // NOCP_APP_SPEC.md §1.
  const settings = await getSettings();
  const secFetchDest = (event.headers?.['sec-fetch-dest'] ?? event.headers?.['Sec-Fetch-Dest'] ?? '').toLowerCase();
  const frameOk = secFetchDest === 'iframe';
  if (!frameTokenOk(event, settings) || !frameOk) {
    return html(BLOCKED_HTML, 403);
  }

  const configJson = escapeForScriptTag(JSON.stringify({frameToken: settings.frameToken}));
  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + escapeHtml(settings.title) + '</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">' +
    '<style>' + widgetCss + '</style>' +
    '<style>html,body{margin:0;padding:0;}body{font-family:\'Inter\',sans-serif;font-size:14px;}</style></head>' +
    '<body><div id="app"></div><script>window.__NOCP_CONFIG__ = ' + configJson + ';</script>' +
    '<script>' + widgetJs + '</script></body></html>';
  return html(page);
};
