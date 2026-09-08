// Admin-editable settings, persisted in the same DynamoDB table jobStore.ts
// uses for checkpointed job state (`NOCP_TABLE`, partition key `pk`, sort
// key `sk`) — one small table, two purposes, rather than provisioning a
// second one for a single settings item. This is nocp-base's
// settingsStore.ts pattern (see its CLAUDE.md, "The settings page is a
// reusable pattern") generalized to iterate SETTINGS_SCHEMA instead of
// three hardcoded fields — needed here since this app has 24 fields, not
// 3 — plus nocp-frontify's schema-driven cleanValue/validateSettingsPatch/
// toAdminView logic for secret-masked/number/toggle handling, which that
// generalization makes available for free.
//
// Each field is its own DynamoDB attribute (not one serialized JSON blob)
// so the live values stay directly readable from the DynamoDB console too,
// matching the convention every other nOCP app's DynamoDB-backed settings
// store already uses.

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { MAX_IMAGE_BYTES, SETTINGS_SCHEMA, type SettingField, type SettingsValues } from "./settingsSchema";

const TABLE = process.env.NOCP_TABLE ?? "";
const PARTITION_KEY = "SETTINGS";
const SORT_KEY = "CURRENT";

const client = new DynamoDBClient({});

// Same placeholder convention as nocp-frontify: one shared masked string
// for every `secret-masked` field, not a distinct one per field. Submitting
// this value back unchanged, or blank, means "keep the existing value" —
// see cleanValue() below.
export const MASKED_PLACEHOLDER = "••••••••";

function blankValues(): SettingsValues {
  const values = {} as Record<string, string>;
  for (const field of SETTINGS_SCHEMA) {
    values[field.key] = field.type === "number" ? "0" : "";
  }
  return values as unknown as SettingsValues;
}

export const DEFAULT_SETTINGS: SettingsValues = {
  ...blankValues(),
  title: "Content Transfer",
};

// Lambda execution environments are reused across invocations, so this
// module-level cache persists warm. getSettings() is called on every
// action-router request (see actions.ts), so this matters more here than
// it would for a lower-traffic admin-only read.
const CACHE_TTL_MS = 15_000;

let cache: { values: SettingsValues; expiresAt: number } | null = null;

function toAttributeValue(field: SettingField, value: unknown): AttributeValue {
  if (field.type === "toggle") return { BOOL: value === true };
  if (field.type === "number") return { N: String(typeof value === "number" ? value : Number(value) || 0) };
  return { S: typeof value === "string" ? value : "" };
}

function fromAttributeValue(field: SettingField, attr: AttributeValue | undefined): unknown {
  if (field.type === "toggle") return attr?.BOOL ?? false;
  if (field.type === "number") return attr?.N !== undefined ? Number(attr.N) : 0;
  return attr?.S ?? "";
}

async function readFromTable(): Promise<SettingsValues | null> {
  if (!TABLE) return null;
  const result = await client.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: PARTITION_KEY }, sk: { S: SORT_KEY } },
    }),
  );
  if (!result.Item) return null;

  const values = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
  for (const field of SETTINGS_SCHEMA) {
    values[field.key] = fromAttributeValue(field, result.Item[field.key]);
  }
  return values as unknown as SettingsValues;
}

async function writeToTable(values: SettingsValues): Promise<void> {
  if (!TABLE) return;
  const record = values as unknown as Record<string, unknown>;
  const item: Record<string, AttributeValue> = {
    pk: { S: PARTITION_KEY },
    sk: { S: SORT_KEY },
  };
  for (const field of SETTINGS_SCHEMA) {
    item[field.key] = toAttributeValue(field, record[field.key]);
  }
  await client.send(new PutItemCommand({ TableName: TABLE, Item: item }));
}

function envDefaults(): Pick<SettingsValues, "title" | "frameToken" | "adminToken"> {
  return {
    title: process.env.NOCP_TITLE ?? DEFAULT_SETTINGS.title,
    frameToken: process.env.NOCP_FRAME_TOKEN ?? "",
    adminToken: process.env.NOCP_ADMIN_TOKEN ?? "",
  };
}

// Reads live settings, bootstrapping title/frameToken/adminToken from the
// Lambda's own env vars the first time each is found blank (covers both a
// brand-new table and a later schema change that added a field nothing's
// saved yet). Each bootstrapped field is persisted once, so DynamoDB
// becomes authoritative for it from then on — a later deploy.sh run with
// different env vars does not clobber what's already live.
export async function getSettings(): Promise<SettingsValues> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.values;

  const stored = await readFromTable();
  const settings = stored ?? { ...DEFAULT_SETTINGS };
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

  if (needsBootstrap) await writeToTable(settings);

  cache = { values: settings, expiresAt: now + CACHE_TTL_MS };
  return settings;
}

function cleanValue(field: SettingField, raw: unknown, existing: SettingsValues): unknown {
  const record = existing as unknown as Record<string, unknown>;

  if (field.type === "toggle") return raw === true;

  if (field.type === "number") {
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(num)) return record[field.key];
    const min = field.min ?? -Infinity;
    const max = field.max ?? Infinity;
    return Math.min(max, Math.max(min, num));
  }

  const str = typeof raw === "string" ? raw.trim() : "";
  if (field.type === "secret-masked" && (!str || str === MASKED_PLACEHOLDER)) {
    return record[field.key];
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

    if (field.type === "number") {
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(num)) return `${field.label} must be a number.`;
      if (field.min !== undefined && num < field.min) return `${field.label} must be at least ${field.min}.`;
      if (field.max !== undefined && num > field.max) return `${field.label} must be at most ${field.max}.`;
      continue;
    }

    if (field.type === "image") {
      if (typeof raw !== "string") return `${field.label} must be a string.`;
      if (!raw) continue; // blank = no icon uploaded — allowed
      if (!ACCEPTED_IMAGE_DATA_URI.test(raw)) return `${field.label} must be a PNG, JPEG, or WebP image.`;
      const approxBytes = Math.floor((raw.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) return `${field.label} must be under ${Math.floor(MAX_IMAGE_BYTES / 1024)}KB.`;
      continue;
    }

    if (!field.required || field.type === "toggle") continue;

    const str = typeof raw === "string" ? raw.trim() : "";
    const keepsExistingMaskedValue = field.type === "secret-masked" && (!str || str === MASKED_PLACEHOLDER);
    if (!str && !keepsExistingMaskedValue) {
      return `${field.label} cannot be empty.`;
    }
  }
  return null;
}

export async function putSettings(patch: Record<string, unknown>): Promise<SettingsValues> {
  const existing = await getSettings();
  const next = { ...existing } as unknown as Record<string, unknown>;
  for (const field of SETTINGS_SCHEMA) {
    if (!(field.key in patch)) continue;
    next[field.key] = cleanValue(field, patch[field.key], existing);
  }

  const result = next as unknown as SettingsValues;
  await writeToTable(result);
  cache = { values: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same shape as `openssl rand -hex 32` (64 lowercase hex chars), matching
// what deploy.sh's own instructions tell you to generate manually for the
// bootstrap .env value.
export async function regenerateToken(key: "frameToken" | "adminToken"): Promise<SettingsValues> {
  return putSettings({ [key]: generateToken() });
}

// The admin surface should never echo a real secret-masked value back once
// saved. Applies generically to every `type: "secret-masked"` field in the
// schema rather than hardcoding which fields get masked.
export function toAdminView(settings: SettingsValues): SettingsValues {
  const view = { ...settings } as unknown as Record<string, unknown>;
  for (const field of SETTINGS_SCHEMA) {
    if (field.type !== "secret-masked") continue;
    if (view[field.key]) view[field.key] = MASKED_PLACEHOLDER;
  }
  return view as unknown as SettingsValues;
}
