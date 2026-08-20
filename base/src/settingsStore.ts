import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { SettingsValues } from "./settingsSchema";

// Same table webhookStore.ts uses, a different partition — one small table,
// two purposes, rather than provisioning a second one for a single item.
const TABLE = process.env.NOCP_WEBHOOKS_TABLE ?? "";
const PARTITION_KEY = "SETTINGS";
const SORT_KEY = "CURRENT";

// Lambda execution environments are reused across invocations, so this
// module-level cache persists warm — short enough that an edit made via
// the settings page is live everywhere within seconds, long enough to
// avoid a DynamoDB read on every single request.
const CACHE_TTL_MS = 15_000;

const client = new DynamoDBClient({});

let cache: { values: SettingsValues; expiresAt: number } | null = null;

function envDefaults(): SettingsValues {
  return {
    title: process.env.NOCP_TITLE ?? "nOCP",
    icon: "",
    frameToken: process.env.NOCP_FRAME_TOKEN ?? "",
    adminToken: process.env.NOCP_ADMIN_TOKEN ?? "",
  };
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
  return {
    title: result.Item.title?.S ?? "",
    icon: result.Item.icon?.S ?? "",
    frameToken: result.Item.frameToken?.S ?? "",
    adminToken: result.Item.adminToken?.S ?? "",
  };
}

async function writeToTable(values: SettingsValues): Promise<void> {
  if (!TABLE) return;
  // Individual string attributes, not a single serialized JSON blob — so
  // the current values are directly readable from the DynamoDB console
  // too, not just through this app's own settings page. `icon` is the one
  // exception worth noting: still its own attribute, but its *value* is a
  // whole data: URI rather than a short string — comfortably under
  // DynamoDB's 400KB item cap at the sizes MAX_IMAGE_BYTES allows, but not
  // as pleasant to eyeball in the console as the others.
  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: PARTITION_KEY },
        sk: { S: SORT_KEY },
        title: { S: values.title },
        icon: { S: values.icon },
        frameToken: { S: values.frameToken },
        adminToken: { S: values.adminToken },
      },
    }),
  );
}

// Reads the live settings, bootstrapping DynamoDB from the Lambda's own env
// vars the very first time this is ever called against a fresh table (i.e.
// right after a first deploy). Once that first write happens, DynamoDB is
// authoritative from then on — a later `deploy.sh` run passing different
// env vars does NOT overwrite whatever's already there. See deploy.sh's own
// comment on why the env vars are bootstrap-only.
export async function getSettings(): Promise<SettingsValues> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.values;

  let values = await readFromTable();
  if (!values) {
    values = envDefaults();
    await writeToTable(values);
  }

  cache = { values, expiresAt: now + CACHE_TTL_MS };
  return values;
}

export async function putSettings(patch: Partial<SettingsValues>): Promise<SettingsValues> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await writeToTable(next);
  cache = { values: next, expiresAt: Date.now() + CACHE_TTL_MS };
  return next;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same shape as `openssl rand -hex 32` (64 lowercase hex chars), matching
// what deploy.sh tells you to generate manually for the bootstrap .env value.
export async function regenerateToken(
  key: "frameToken" | "adminToken",
): Promise<SettingsValues> {
  return putSettings({ [key]: generateToken() } as Partial<SettingsValues>);
}
