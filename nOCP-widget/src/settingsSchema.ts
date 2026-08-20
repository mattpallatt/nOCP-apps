// Single source of truth for what settings this app exposes. Bundled into
// BOTH the server (lambda.ts / settingsStore.ts, for defaults + validation)
// and the client (admin.ts, to render the form) independently by esbuild —
// no server/client duplication, since it's just a plain data module with no
// runtime dependencies of its own.
//
// This is the one file a new nOCP app actually needs to edit when copying
// this settings-page pattern: change SETTINGS_SCHEMA and SettingsValues to
// whatever fields that app needs. settingsStore.ts's DynamoDB read/write,
// admin.ts's form rendering and regenerate-token flow, and lambda.ts's
// /admin routes are all written against this schema generically and
// shouldn't need touching.

// "secret" (this app's frameToken/adminToken): shown in plain text,
// optionally `regenerable` — a server-generated random value, since we own
// both sides of that secret.
// "secret-masked" (e.g. a pasted-in third-party API key): shown masked
// once saved, never regenerable — the value comes from somewhere else, so
// there's nothing for us to regenerate. Submitting the masked placeholder
// back unchanged (or blank) means "keep the existing value"; that
// comparison happens server-side against whatever masked constant that
// field's owner defines, not here.
// "image": a data: URI (base64-encoded PNG/JPEG/WebP), uploaded via a file
// input in admin.ts and capped client-side before it's ever sent — see
// MAX_IMAGE_BYTES. Backs NOCP_APP_SPEC.md §7's GET /nocp/icon.
export type SettingFieldType = "text" | "secret" | "secret-masked" | "toggle" | "number" | "image";

// Enforced client-side in admin.ts before an image is included in a save
// payload — DynamoDB's 400KB item cap is nowhere close to a real concern
// at this size, this is purely "don't let someone accidentally upload a
// hero image and call it an icon."
export const MAX_IMAGE_BYTES = 100 * 1024;

export interface SettingField {
  key: string;
  label: string;
  type: SettingFieldType;
  help?: string;
  // Only meaningful for type: "secret" — shows a "Regenerate" button next
  // to the field that replaces its value with a fresh crypto-random token,
  // server-side, on click.
  regenerable?: boolean;
  // Only meaningful for type: "number".
  min?: number;
  max?: number;
  // Groups fields under a heading — fields sharing the same `section`
  // string render together, in first-appearance order. Omit for a form
  // with just one implicit section.
  section?: string;
}

export const SETTINGS_SCHEMA: readonly SettingField[] = [
  {
    key: "title",
    label: "Browser tab title",
    type: "text",
    section: "Settings",
    help: "Shown in the browser tab when the widget is opened standalone.",
  },
  {
    key: "icon",
    label: "App icon",
    type: "image",
    section: "Settings",
    help: "PNG, JPEG, or WebP, under 100KB. Served at /nocp/icon and picked up automatically by the nOCP Chrome extension (NOCP_APP_SPEC.md §7) — leave blank to fall back to the extension's own default icon.",
  },
  {
    key: "frameToken",
    label: "Frame token",
    type: "secret",
    regenerable: true,
    section: "Settings",
    help: "Shared secret the nOCP Chrome extension sends as ?token=. Must exactly match the Frame Token field on this app's card in the extension's Options page — regenerating here doesn't update the extension automatically.",
  },
  {
    key: "adminToken",
    label: "Admin token",
    type: "secret",
    regenerable: true,
    section: "Settings",
    help: "Sent as the X-NOCP-Admin-Token header to open this settings page and view recent webhooks. Regenerating immediately invalidates your current session here — copy the new value before navigating away.",
  },
];

// The actual settings values this app persists — keys here must match
// SETTINGS_SCHEMA's `key`s above (not statically enforced, small enough to
// keep in sync by hand for a schema this size).
export interface SettingsValues {
  title: string;
  // Data URI ("data:image/png;base64,...") or "" if none uploaded yet.
  icon: string;
  frameToken: string;
  adminToken: string;
}
