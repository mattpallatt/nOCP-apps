// Admin-editable settings, persisted as a single SecureString SSM parameter
// (encrypted at rest under the default AWS-managed key, alias/aws/ssm — no
// per-secret cost, unlike Secrets Manager). One parameter holding the whole
// JSON blob rather than one per field: simpler to read/write atomically, and
// SecureString already encrypts the entire value regardless of how many
// fields are actually sensitive.
//
// This is nocp-widget's settingsStore.ts pattern (see that app's CLAUDE.md,
// "The settings page is a reusable pattern"), adapted to SSM instead of
// DynamoDB — same choice nocp-frontify made, for the same reason: the Graph
// Single Key needs SecureString's encryption-at-rest in a way nocp-widget's
// plaintext tokens never did. Logic driven generically by SETTINGS_SCHEMA
// (cleaning, masked-secret handling, validation), same as both sibling
// apps' versions.

import {SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand} from '@aws-sdk/client-ssm';
import {MAX_IMAGE_BYTES, SETTINGS_SCHEMA, type SettingsValues} from './settingsSchema';

const PARAM_NAME = process.env.NOCP_SETTINGS_PARAM ?? '/nocp-category-explorer/settings';
// Deliberately its own parameter, not a field inside the main blob — see
// deploy.sh's own comment on ICON_PARAM for why: SSM Standard parameters
// cap at 4KB total, and bundling a variable-size icon into the same blob as
// the Graph Single Key meant a plain settings save could 502 for reasons
// unrelated to what was actually being saved (confirmed live on
// nocp-frontify the hard way). Plain String, not SecureString — an icon
// isn't sensitive (NOCP_APP_SPEC.md §7), so no KMS decrypt round-trip
// needed to read it.
const ICON_PARAM_NAME = process.env.NOCP_ICON_PARAM ?? '/nocp-category-explorer/icon';
const client = new SSMClient({});

export const DEFAULT_SETTINGS: SettingsValues = {
  title: 'Category Explorer',
  icon: '',
  frameToken: '',
  adminToken: '',
  singleKey: '',
};

// Same convention nocp-widget/nocp-frontify use for their masked fields —
// one placeholder shared by every `secret-masked` field. Submitting this
// value back unchanged, or blank, means "keep the existing value" — see
// cleanValue() below.
export const MASKED_PLACEHOLDER = '••••••••';

// Lambda execution environments are reused across invocations, so this
// module-level cache persists warm. getSettings() is called on every
// action-router request (see actions.ts), so this matters more here than
// it would for a lower-traffic admin-only read.
const CACHE_TTL_MS = 15_000;

let cache: {values: SettingsValues; expiresAt: number} | null = null;

async function readFromParam(): Promise<SettingsValues | null> {
  try {
    const result = await client.send(
      new GetParameterCommand({Name: PARAM_NAME, WithDecryption: true}),
    );
    const raw = result.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SettingsValues>;
    return {...DEFAULT_SETTINGS, ...parsed};
  } catch {
    // ParameterNotFound on first run before anything's been saved yet — any
    // other error also degrades to "nothing saved" rather than 500ing the
    // caller, matching nocp-frontify's behavior here.
    return null;
  }
}

// `icon` is deliberately excluded from what's serialized into the main
// blob — it lives entirely in ICON_PARAM_NAME (see readIconFromParam/
// writeIconToParam below).
async function writeToParam(values: SettingsValues): Promise<void> {
  const {icon: _icon, ...rest} = values;
  await client.send(
    new PutParameterCommand({
      Name: PARAM_NAME,
      Value: JSON.stringify(rest),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
}

async function readIconFromParam(): Promise<string> {
  try {
    const result = await client.send(new GetParameterCommand({Name: ICON_PARAM_NAME}));
    return result.Parameter?.Value ?? '';
  } catch {
    // ParameterNotFound — no icon uploaded yet. Any other error also
    // degrades to "no icon" rather than 500ing the whole settings read
    // over a piece of purely cosmetic data.
    return '';
  }
}

async function writeIconToParam(icon: string): Promise<void> {
  if (!icon) {
    try {
      await client.send(new DeleteParameterCommand({Name: ICON_PARAM_NAME}));
    } catch {
      // Already didn't exist — fine, that's the state we wanted anyway.
    }
    return;
  }
  await client.send(
    new PutParameterCommand({
      Name: ICON_PARAM_NAME,
      Value: icon,
      Type: 'String',
      Overwrite: true,
    }),
  );
}

function envDefaults(): Pick<SettingsValues, 'title' | 'frameToken' | 'adminToken'> {
  return {
    title: process.env.NOCP_TITLE ?? DEFAULT_SETTINGS.title,
    frameToken: process.env.NOCP_FRAME_TOKEN ?? '',
    adminToken: process.env.NOCP_ADMIN_TOKEN ?? '',
  };
}

// Reads live settings, bootstrapping title/frameToken/adminToken from the
// Lambda's own env vars the first time each is found blank. Each
// bootstrapped field is persisted once, so SSM becomes authoritative for it
// from then on — a later `deploy.sh` run with different env vars does not
// clobber it.
export async function getSettings(): Promise<SettingsValues> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.values;

  const [stored, icon] = await Promise.all([readFromParam(), readIconFromParam()]);
  const settings = stored ?? {...DEFAULT_SETTINGS};
  settings.icon = icon;
  const defaults = envDefaults();

  let needsBootstrap = !stored;
  if (!settings.title) {
    settings.title = defaults.title;
    needsBootstrap = true;
  }
  if (!settings.frameToken) {
    settings.frameToken = defaults.frameToken;
    needsBootstrap = true;
  }
  if (!settings.adminToken) {
    settings.adminToken = defaults.adminToken;
    needsBootstrap = true;
  }

  if (needsBootstrap) await writeToParam(settings);

  cache = {values: settings, expiresAt: now + CACHE_TTL_MS};
  return settings;
}

function cleanValue(
  key: keyof SettingsValues,
  raw: unknown,
  existing: SettingsValues,
): SettingsValues[keyof SettingsValues] {
  const field = SETTINGS_SCHEMA.find((f) => f.key === key);
  if (!field) return existing[key];

  const str = typeof raw === 'string' ? raw.trim() : '';
  if (field.type === 'secret-masked' && (!str || str === MASKED_PLACEHOLDER)) {
    return existing[key];
  }
  return str;
}

// Rejects a save that would leave a `required` field blank — checked
// against the *cleaned* value, so a secret-masked field submitted masked
// or blank when it already has a real value isn't wrongly flagged as
// "going blank." Called before putSettings() in lambda.ts's POST handler.
const ACCEPTED_IMAGE_DATA_URI = /^data:image\/(png|jpeg|webp);base64,/;

export function validateSettingsPatch(patch: Record<string, unknown>): string | null {
  for (const field of SETTINGS_SCHEMA) {
    if (!(field.key in patch)) continue;
    const raw = patch[field.key];

    if (field.type === 'image') {
      if (typeof raw !== 'string') return `${field.label} must be a string.`;
      if (!raw) continue; // blank = no icon uploaded — allowed
      if (!ACCEPTED_IMAGE_DATA_URI.test(raw)) return `${field.label} must be a PNG, JPEG, or WebP image.`;
      const approxBytes = Math.floor((raw.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) return `${field.label} must be under ${Math.floor(MAX_IMAGE_BYTES / 1024)}KB.`;
      continue;
    }

    if (!field.required || field.type === 'toggle') continue;

    const str = typeof raw === 'string' ? raw.trim() : '';
    const keepsExistingMaskedValue = field.type === 'secret-masked' && (!str || str === MASKED_PLACEHOLDER);
    if (!str && !keepsExistingMaskedValue) {
      return `${field.label} cannot be empty.`;
    }
  }
  return null;
}

export async function putSettings(patch: Record<string, unknown>): Promise<SettingsValues> {
  const existing = await getSettings();
  const next = {...existing};
  for (const field of SETTINGS_SCHEMA) {
    if (!(field.key in patch)) continue;
    const key = field.key as keyof SettingsValues;
    (next[key] as unknown) = cleanValue(key, patch[field.key], existing);
  }

  // Icon goes to its own parameter (see ICON_PARAM_NAME above); only
  // written when actually touched, so an unrelated settings save doesn't
  // needlessly rewrite it.
  if ('icon' in patch) {
    await writeIconToParam(next.icon);
  }
  await writeToParam(next);
  cache = {values: next, expiresAt: Date.now() + CACHE_TTL_MS};
  return next;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Same shape as `openssl rand -hex 32` (64 lowercase hex chars), matching
// what deploy.sh's own instructions tell you to generate manually for the
// bootstrap .env value.
export async function regenerateToken(key: 'frameToken' | 'adminToken'): Promise<SettingsValues> {
  return putSettings({[key]: generateToken()});
}

// The admin surface should never echo a real secret-masked value back once
// saved. Applies generically to every `type: "secret-masked"` field in the
// schema (just singleKey today) rather than hardcoding which fields get
// masked.
export function toAdminView(settings: SettingsValues): SettingsValues {
  const view = {...settings};
  for (const field of SETTINGS_SCHEMA) {
    if (field.type !== 'secret-masked') continue;
    const key = field.key as keyof SettingsValues;
    if (view[key]) (view[key] as unknown) = MASKED_PLACEHOLDER;
  }
  return view;
}
