// Ported from CategoryExplorerOCPUI's src/backend/lib/OptimizelyGraphClient.ts
// + GraphErrors.ts/GraphRequestError.ts (folded into this one file — small
// enough not to need three). getSingleKey() reads from this app's own
// settingsStore instead of OCP's storage.settings. testSingleKey() (the
// source app's settings-form "Test Connection" button) isn't ported — this
// app's settings page is the shared generic admin.ts pattern used across
// every nOCP app (schema-driven Save/Regenerate, no per-field custom
// actions), same tradeoff nocp-frontify already made for its own
// third-party credentials. An invalid key surfaces the same way: the
// widget's first real Graph call fails with a clear "Graph rejected the
// key" message instead of a dedicated pre-save check.

import {getSettings} from './settingsStore';

const GRAPH_ENDPOINT = 'https://cg.optimizely.com/content/v2';

export class GraphAuthError extends Error {
  public constructor() {
    super('Optimizely Graph is not configured');
  }
}

export class GraphRequestError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function getSingleKey(): Promise<string> {
  const settings = await getSettings();
  const trimmed = settings.singleKey.trim();
  if (!trimmed) {
    throw new GraphAuthError();
  }
  return trimmed;
}

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{message: string}>;
}

function firstErrorMessage(body: GraphResponse<unknown>, status: number): string {
  return body.errors?.[0]?.message ?? `Graph request failed (${status})`;
}

export async function graphQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const singleKey = await getSingleKey();
  const url = `${GRAPH_ENDPOINT}?auth=${encodeURIComponent(singleKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({query, variables}),
  });

  const body = (await response.json()) as GraphResponse<T>;

  if (!response.ok) {
    throw new GraphRequestError(response.status, firstErrorMessage(body, response.status));
  }
  if (body.errors?.length) {
    throw new GraphRequestError(200, body.errors[0].message);
  }
  if (!body.data) {
    throw new GraphRequestError(response.status, 'Graph returned no data');
  }
  return body.data;
}
