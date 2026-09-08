// Single source of truth for what settings this app exposes. Bundled into
// BOTH the server (lambda.ts / settingsStore.ts, for defaults + validation)
// and the client (admin.ts, to render the form) independently by esbuild —
// no server/client duplication, since it's just a plain data module with no
// runtime dependencies of its own. Ported from nocp-frontify's copy of this
// same pattern — see that app's CLAUDE.md ("The settings page is a reusable
// pattern") for the full rationale. This file is the one a new app copying
// the pattern actually needs to edit; settingsStore.ts's persistence and
// admin.ts's form rendering/regenerate flow are written against the schema
// shape generically.

// "image": a data: URI (base64-encoded PNG/JPEG/WebP), uploaded via a file
// input in admin.ts and capped client-side before it's ever sent — see
// MAX_IMAGE_BYTES. Backs NOCP_APP_SPEC.md §7's GET /nocp/icon.
export type SettingFieldType = "text" | "secret" | "secret-masked" | "toggle" | "number" | "image";

// Enforced client-side in admin.ts (and re-checked server-side in
// settingsStore.ts's validateSettingsPatch). The icon lives in its own SSM
// Standard parameter (see settingsStore.ts's ICON_PARAM_NAME), and Standard
// parameters cap out at 4096 *characters* total for the value — base64
// inflates by ~4/3 and the "data:image/png;base64," prefix eats a little
// more, so this needs real headroom under 4096. Same cap nocp-frontify
// settled on after that app's icon upload 502'd live at a looser limit.
export const MAX_IMAGE_BYTES = 3000;

export interface SettingField {
  key: string;
  label: string;
  type: SettingFieldType;
  help?: string;
  // Only meaningful for type: "secret" — shows a "Regenerate" button that
  // replaces the value with a fresh crypto-random token, server-side.
  regenerable?: boolean;
  // Groups fields under a heading — fields sharing the same `section`
  // string render together, in first-appearance order.
  section?: string;
  // Rejects a save that would leave this field blank (checked against the
  // cleaned value, so a secret-masked field submitted masked/blank when it
  // already has a real value isn't wrongly treated as "going blank"). The
  // Graph Single Key is deliberately NOT required — same reasoning as
  // nocp-frontify's Frontify/CMS credentials: the app tolerates being
  // unconfigured (actions.ts reports not_configured rather than erroring)
  // instead of blocking the settings page from saving at all.
  required?: boolean;
}

export const SETTINGS_SCHEMA: readonly SettingField[] = [
  {
    key: "title",
    label: "Browser tab title",
    type: "text",
    section: "Settings",
    required: true,
    help: "Shown in the browser tab when the widget is opened standalone.",
  },
  {
    key: "icon",
    label: "App icon",
    type: "image",
    section: "Settings",
    help: "PNG, JPEG, or WebP, under 3KB — small, since this is stored in its own SSM parameter (4KB hard cap). A simple flat icon around 48-64px square fits comfortably; a photo won't. Served at /nocp/icon and picked up automatically by the nOCP Chrome extension (NOCP_APP_SPEC.md §7) — leave blank to fall back to the extension's own default icon.",
  },
  {
    key: "frameToken",
    label: "Frame token",
    type: "secret",
    regenerable: true,
    section: "Settings",
    required: true,
    help: "Shared secret the nOCP Chrome extension sends as ?token= (and as X-Nocp-Frame-Token on the widget's own /category-explorer/api calls). Must exactly match the Frame Token field on this app's card in the extension's Options page — regenerating here doesn't update the extension automatically.",
  },
  {
    key: "adminToken",
    label: "Admin token",
    type: "secret",
    regenerable: true,
    section: "Settings",
    required: true,
    help: "Sent as the X-NOCP-Admin-Token header to open this settings page. Regenerating immediately invalidates your current session here — copy the new value before navigating away.",
  },
  {
    key: "singleKey",
    label: "Graph Single Key",
    type: "secret-masked",
    section: "Optimizely Graph",
    help: "Create a Single Key in your Optimizely Graph instance (Settings > API Keys) and paste it in — this page doesn't generate it. Used for read-only access to published content and categories. Shown masked once saved; leave it as-is (or blank) to keep the current value.",
  },
];

// The actual settings values this app persists — keys here must match
// SETTINGS_SCHEMA's `key`s above.
export interface SettingsValues {
  title: string;
  // Data URI ("data:image/png;base64,...") or "" if none uploaded yet.
  icon: string;
  frameToken: string;
  adminToken: string;
  singleKey: string;
}
