// Single source of truth for what settings this app exposes. Bundled into
// BOTH the server (lambda.ts / settingsStore.ts, for defaults + validation)
// and the client (admin.ts, to render the form) independently by esbuild —
// no server/client duplication, since it's a plain data module with no
// runtime dependencies. This is nocp-widget's/nocp-frontify's settings-page
// pattern (see nocp-frontify's CLAUDE.md, "The settings page is a reusable
// pattern") — this is the one file that pattern says a new app actually
// needs to edit; settingsStore.ts's persistence and admin.ts's form
// rendering/regenerate flow are written against the schema shape
// generically and needed no changes to adopt this app's field list.

// "image": a data: URI (base64-encoded PNG/JPEG/WebP), uploaded via a file
// input in admin.ts and capped client-side before it's ever sent — see
// MAX_IMAGE_BYTES. Backs NOCP_APP_SPEC.md §7's GET /nocp/icon.
export type SettingFieldType = "text" | "secret" | "secret-masked" | "toggle" | "number" | "image";

// Enforced client-side in admin.ts before an image is included in a save
// payload — DynamoDB's 400KB item cap is nowhere near a concern at this
// size, this is purely "don't let someone accidentally upload a hero image
// and call it an icon."
export const MAX_IMAGE_BYTES = 100 * 1024;

export interface SettingField {
  key: string;
  label: string;
  type: SettingFieldType;
  help?: string;
  // Only meaningful for type: "secret" — shows a "Regenerate" button that
  // replaces the value with a fresh crypto-random token, server-side.
  regenerable?: boolean;
  // Only meaningful for type: "number".
  min?: number;
  max?: number;
  // Groups fields under a heading — fields sharing the same `section`
  // string render together, in first-appearance order.
  section?: string;
  // Rejects a save that would leave this field blank. Only Environment 1's
  // MatchPattern/ClientId/ClientSecret are required — the source app
  // (`ContentTransfer-OCP-UI`) only ever marked slot 1 required too, since
  // it has no repeatable-group primitive and falls back to 3 fixed numbered
  // slots. Slots 2/3 left blank simply never resolve for any hostname
  // (findEnvironmentForHostname has nothing to match), which is a
  // non-silent, expected failure mode — not something to validate against.
  required?: boolean;
}

const ENVIRONMENT_SLOTS = [1, 2, 3] as const;

function environmentFields(slot: number, required: boolean): SettingField[] {
  const section = `Environment ${slot}`;
  return [
    {
      key: `env${slot}Name`,
      label: "Name",
      type: "text",
      section,
      help: "Display label only — not matched against anything.",
    },
    {
      key: `env${slot}MatchPattern`,
      label: "Match pattern",
      type: "text",
      section,
      required,
      help: "A substring of this environment's CMS admin hostname, e.g. \"test1\". Used to figure out which environment the widget is currently embedded in, and to pick a transfer target by name.",
    },
    {
      key: `env${slot}ClientId`,
      label: "Client ID",
      type: "text",
      section,
      required,
      help: "Optimizely CMS Content Management API (CMAPI) OAuth2 client-credentials client ID.",
    },
    {
      key: `env${slot}ClientSecret`,
      label: "Client secret",
      type: "secret-masked",
      section,
      required,
    },
    {
      key: `env${slot}RootContainer`,
      label: "Root container key",
      type: "text",
      section,
      help: "Optional. Fallback destination parent when an item's true ancestor can't be resolved on this environment.",
    },
    {
      key: `env${slot}ContentGraphKey`,
      label: "Content Graph key",
      type: "text",
      section,
      help: "Optional. Enables title-match fallback resolution when a same-key ancestor lookup fails.",
    },
    {
      key: `env${slot}ContentGraphSecret`,
      label: "Content Graph secret",
      type: "secret-masked",
      section,
    },
  ];
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
    help: "PNG, JPEG, or WebP, under 100KB. Served at /nocp/icon and picked up automatically by the nOCP Chrome extension (NOCP_APP_SPEC.md §7) — leave blank to fall back to the extension's own default icon.",
  },
  {
    key: "frameToken",
    label: "Frame token",
    type: "secret",
    regenerable: true,
    section: "Settings",
    required: true,
    help: "Shared secret the nOCP Chrome extension sends as ?token= (and as X-Nocp-Frame-Token on the widget's own /content-transfer/api calls). Must exactly match the Frame Token field on this app's card in the extension's Options page — regenerating here doesn't update the extension automatically.",
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
  ...environmentFields(1, true),
  ...environmentFields(2, false),
  ...environmentFields(3, false),
];

// The actual settings values this app persists — keys here must match
// SETTINGS_SCHEMA's `key`s above.
export interface SettingsValues {
  title: string;
  // Data URI ("data:image/png;base64,...") or "" if none uploaded yet.
  icon: string;
  frameToken: string;
  adminToken: string;
  env1Name: string;
  env1MatchPattern: string;
  env1ClientId: string;
  env1ClientSecret: string;
  env1RootContainer: string;
  env1ContentGraphKey: string;
  env1ContentGraphSecret: string;
  env2Name: string;
  env2MatchPattern: string;
  env2ClientId: string;
  env2ClientSecret: string;
  env2RootContainer: string;
  env2ContentGraphKey: string;
  env2ContentGraphSecret: string;
  env3Name: string;
  env3MatchPattern: string;
  env3ClientId: string;
  env3ClientSecret: string;
  env3RootContainer: string;
  env3ContentGraphKey: string;
  env3ContentGraphSecret: string;
}

export const ENVIRONMENT_SLOT_COUNT = ENVIRONMENT_SLOTS.length;
