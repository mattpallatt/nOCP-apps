// Near-verbatim port of the source app's src/backend/lib/cma.ts. Every
// operation here is plain fetch() logic with zero real OCP dependency
// except the OAuth token cache, which used OCP's storage.kvStore — swapped
// for a plain module-level Map (same call nocp-frontify's own CMAPI OAuth
// cache made): tokens are cheap to refetch on a cold start, and this
// avoids a DynamoDB round-trip on nearly every CMAPI operation the app
// makes. Everything else — contentExists, getContent, createContent,
// createMediaContent, 429 backoff, the write-retry-relevant rawRequest/
// parseProblem split — is unchanged from the source.
import {logger} from './logger';
import {DEFAULT_CMAPI_ENDPOINT, MAX_429_RETRIES, RETRY_BASE_DELAY_MS} from './constants';

// Keyed by clientId — the one per-environment identity a request actually
// carries, so a shared/global cache key would let one environment's calls
// reuse another environment's still-valid token.
function tokenCacheKey(clientId: string): string {
  return `cmapiOAuthToken:${clientId}`;
}

export class CmsError extends Error {
  public constructor(
    public readonly code: 'unauthorized' | 'not_found' | 'request_failed' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

// CMAPI's endpoint is not user-configurable — every CMS (SaaS) tenant uses
// the same base URL, so there's nothing for a settings field to add here.
export interface CmapiCredentials {
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Module-level — persists warm for a Lambda execution environment's
// lifetime, cleared on cold start. See file header for why this replaced
// OCP's storage.kvStore here.
const tokenCache = new Map<string, CachedToken>();

/**
 * Extracts everything useful from CMAPI's RFC9110 problem+json error body:
 * `title`/`detail`/`code`, plus a raw dump of `errors` if present. The
 * transfer engine's write-retry loop additionally needs the raw parsed body
 * (to pick out which specific property a "PropertyNotFound"/"InvalidContent"
 * error names) — see describeError vs parseProblem below.
 */
export interface ProblemDetails {
  title?: string;
  detail?: string;
  code?: string;
  errors?: unknown;
}

export async function parseProblem(response: Response): Promise<ProblemDetails | null> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text) as ProblemDetails;
  } catch {
    return null;
  }
}

function describeProblem(problem: ProblemDetails | null, fallbackText: string): string {
  if (!problem) return fallbackText.slice(0, 300);
  const parts: string[] = [];
  if (problem.title) parts.push(problem.title);
  if (problem.detail) parts.push(problem.detail);
  const hasErrors = problem.errors
    && (Array.isArray(problem.errors) ? problem.errors.length > 0 : Object.keys(problem.errors).length > 0);
  if (hasErrors) parts.push(`errors: ${JSON.stringify(problem.errors)}`);
  return parts.length > 0 ? parts.join(' — ') : fallbackText.slice(0, 300);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestResult {
  response: Response;
  problem: ProblemDetails | null;
}

/**
 * Low-level CMA request, shared by every helper below and by
 * transferEngine.ts's write-retry loop (which needs the raw response/problem
 * on non-2xx statuses to decide how to patch and retry, rather than having
 * this throw immediately the way the simpler read/list helpers below want).
 * 429 retry/backoff: CMAPI's rate-limit behavior is the same regardless of
 * which app is calling it.
 */
export async function rawRequest(
  config: CmapiCredentials,
  path: string,
  init?: RequestInit & {token?: string},
  attempt = 0,
): Promise<RequestResult> {
  const token = init?.token ?? (await getToken(config));
  const response = await fetch(`${DEFAULT_CMAPI_ENDPOINT}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 429 && attempt < MAX_429_RETRIES) {
    const retryAfterHeader = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : RETRY_BASE_DELAY_MS * 2 ** attempt;
    logger.warn(`[ContentTransfer] 429 from CMAPI for ${path}, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`);
    await delay(retryAfterMs);
    return rawRequest(config, path, init, attempt + 1);
  }

  if (response.ok) {
    return {response, problem: null};
  }
  // Response body can only be read once — clone before parseProblem
  // consumes it, so callers that want the raw response can still read it.
  const problem = await parseProblem(response.clone());
  return {response, problem};
}

/** Throws a CmsError on any non-2xx status — for callers that don't need to inspect/retry the raw error themselves. */
async function request(
  config: CmapiCredentials,
  path: string,
  init?: RequestInit & {token?: string},
): Promise<Response> {
  const {response, problem} = await rawRequest(config, path, init);
  if (response.status === 401 || response.status === 403) {
    throw new CmsError('unauthorized', `CMAPI rejected the request (${response.status}) for ${path}: ${describeProblem(problem, await response.text().catch(() => ''))}`);
  }
  if (response.status === 404) {
    throw new CmsError('not_found', `CMAPI resource not found: ${path}: ${describeProblem(problem, await response.text().catch(() => ''))}`);
  }
  if (response.status === 409) {
    throw new CmsError('conflict', `CMAPI conflict for ${path}: ${describeProblem(problem, await response.text().catch(() => ''))}`);
  }
  if (!response.ok) {
    throw new CmsError('request_failed', `CMAPI request to ${path} failed (${response.status}): ${describeProblem(problem, await response.text().catch(() => ''))}`);
  }
  return response;
}

async function getToken(config: CmapiCredentials): Promise<string> {
  const cached = tokenCache.get(tokenCacheKey(config.clientId));
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const response = await fetch(`${DEFAULT_CMAPI_ENDPOINT}/oauth/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });

  if (!response.ok) {
    throw new CmsError('unauthorized', `CMAPI OAuth failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {access_token: string; expires_in: number};
  const toCache: CachedToken = {token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000};
  tokenCache.set(tokenCacheKey(config.clientId), toCache);
  return toCache.token;
}

/** Sanity-check credentials by fetching the OAuth token and, if a root container is configured, one page of its children. */
export async function validateCredentials(config: CmapiCredentials & {rootContainer?: string}): Promise<void> {
  await getToken(config);
  if (config.rootContainer) {
    await request(config, `/v1/content/${config.rootContainer}/items?pageIndex=0&pageSize=1`);
  }
}

export interface ContentItem {
  key: string;
  contentType?: string;
  container?: string;
  // Set instead of `container` for assets owned by another content item
  // (e.g. an image uploaded "for this page") — container/owner are mutually
  // exclusive on create, and a source item with only `owner` set has no
  // `container` to fall back to.
  owner?: string;
  displayName?: string;
  [key: string]: unknown;
}

/** True if a content item with this key already exists on this environment. 401/403 counts as "exists" — can't read it, but it's there. */
export async function contentExists(config: CmapiCredentials, key: string): Promise<boolean> {
  const {response} = await rawRequest(config, `/v1/content/${key}`);
  if (response.status === 404) return false;
  if (response.ok || response.status === 401 || response.status === 403) return true;
  throw new CmsError('request_failed', `CMAPI existence check for ${key} failed (${response.status})`);
}

/** Fetches a content item's current definition (container/contentType/properties), or null on 404. */
export async function getContent(config: CmapiCredentials, key: string): Promise<ContentItem | null> {
  try {
    const response = await request(config, `/v1/content/${key}`);
    return (await response.json()) as ContentItem;
  } catch (error) {
    if (error instanceof CmsError && error.code === 'not_found') return null;
    throw error;
  }
}

export interface ContentVersion {
  version?: string;
  locale?: string;
  displayName?: string;
  status?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ContentVersionsResponse {
  items?: ContentVersion[];
}

/** Lists a content item's versions, most recent first — used to find the version number to publish or to read current properties before an update. */
export async function listVersions(config: CmapiCredentials, key: string, pageSize = 1): Promise<ContentVersion[]> {
  try {
    const response = await request(config, `/v1/content/${key}/versions?pageIndex=0&pageSize=${pageSize}`);
    const data = (await response.json()) as ContentVersionsResponse;
    return data.items ?? [];
  } catch (error) {
    if (error instanceof CmsError && error.code === 'not_found') return [];
    throw error;
  }
}

/** The name to show a human for a content item — its latest version's displayName, falling back to the item's own (rarely different in practice), then the key itself if neither is set. Null only if the item doesn't exist at all. */
export async function getContentDisplayName(config: CmapiCredentials, key: string): Promise<string | null> {
  const content = await getContent(config, key);
  if (!content) return null;
  const [latestVersion] = await listVersions(config, key, 1);
  return latestVersion?.displayName ?? content.displayName ?? key;
}

// How many times to retry around a just-created item's version being
// briefly unavailable before giving up on publishing it — a version created
// moments earlier in the same call chain can briefly not show up yet.
// Used for two *independent* lookups that lag separately rather than
// together: listVersions finding the new version at all, and the
// versions/{v}:publish endpoint itself 404ing on a version number that
// listVersions had already reported moments before.
const PUBLISH_VERSION_LOOKUP_RETRIES = 3;
const PUBLISH_VERSION_LOOKUP_DELAY_MS = 400;

/** Publishes a content item's version, resolving the version number from its latest version if not given. */
export async function publishVersion(config: CmapiCredentials, key: string, version?: string): Promise<void> {
  let versionNumber = version;
  if (!versionNumber) {
    for (let attempt = 0; !versionNumber && attempt < PUBLISH_VERSION_LOOKUP_RETRIES; attempt++) {
      if (attempt > 0) await delay(PUBLISH_VERSION_LOOKUP_DELAY_MS);
      const [latest] = await listVersions(config, key, 1);
      versionNumber = latest?.version;
    }
  }
  if (!versionNumber) {
    throw new CmsError('request_failed', `Could not determine version number to publish for ${key}`);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await request(config, `/v1/content/${key}/versions/${versionNumber}:publish`, {method: 'POST'});
      return;
    } catch (error) {
      if (!(error instanceof CmsError) || error.code !== 'not_found' || attempt >= PUBLISH_VERSION_LOOKUP_RETRIES) {
        throw error;
      }
      await delay(PUBLISH_VERSION_LOOKUP_DELAY_MS);
    }
  }
}

export interface ContentTypeSchema {
  key?: string;
  baseType?: string;
  properties?: Record<string, {type: string; [key: string]: unknown}>;
  [key: string]: unknown;
}

/** Fetches a content type's schema, or null if it doesn't exist on this environment. */
export async function getContentType(config: CmapiCredentials, key: string): Promise<ContentTypeSchema | null> {
  try {
    const response = await request(config, `/v1/contenttypes/${encodeURIComponent(key)}`);
    return (await response.json()) as ContentTypeSchema;
  } catch (error) {
    if (error instanceof CmsError && error.code === 'not_found') return null;
    throw error;
  }
}

export type CreateContentInput = {
  key: string;
  contentType: string;
  // container/owner are mutually exclusive — exactly one of the two must be
  // present. Callers pick based on which the source item actually had (see
  // transferEngine.ts's writeWithRetry).
  //
  // No `status` field — CMA rejects it on create ("Status cannot be
  // assigned when creating a new content item"). Every create lands as a
  // draft; publish explicitly via publishVersion.
  initialVersion: {
    displayName?: string;
    locale?: string;
    properties?: Record<string, unknown>;
  };
} & ({container: string; owner?: undefined} | {owner: string; container?: undefined});

/** POST /v1/content — creates a brand-new content item (key not yet present on this environment). */
export async function createContent(config: CmapiCredentials, input: CreateContentInput): Promise<RequestResult> {
  return rawRequest(config, '/v1/content', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(input),
  });
}

export type CreateMediaContentInput = {
  key: string;
  contentType: string;
  displayName?: string;
  locale?: string;
} & ({container: string; owner?: undefined} | {owner: string; container?: undefined});

export interface MediaFile {
  filename: string;
  data: Buffer;
  mimeType?: string;
}

/**
 * POST /v1/content via multipart/form-data — the only confirmed way to
 * attach a *new* binary to a media content item. A plain JSON create
 * (createContent above) 400s on media content types ("Media content must
 * be provided for media content types", field `initialVersion.media`);
 * there is no documented separate media-upload endpoint.
 *
 * A `content` part carries the same JSON shape createContent's body would,
 * and a `file` part carries the raw bytes — per Optimizely's own docs, the
 * file part's filename and the content part's `displayName` must match
 * exactly or the request is rejected.
 *
 * `key` is supplied explicitly to preserve identity with the source
 * environment's item. Whether the multipart path also honors a
 * client-supplied key the same way createContent's plain-JSON path does is
 * NOT confirmed live — carried forward from the source app as an open
 * question, not resolved by this port. If it doesn't, the created item's
 * actual key would need to come from the response's `Location` header
 * instead.
 */
export async function createMediaContent(
  config: CmapiCredentials,
  input: CreateMediaContentInput,
  file: MediaFile,
): Promise<RequestResult> {
  const token = await getToken(config);

  const createJson: Record<string, unknown> = {
    key: input.key,
    contentType: input.contentType,
    initialVersion: {displayName: input.displayName, locale: input.locale},
  };
  if (input.owner) createJson.owner = input.owner;
  else createJson.container = input.container;

  const formData = new FormData();
  formData.append('content', new Blob([JSON.stringify(createJson)], {type: 'application/json'}));
  // Buffer's own type (ArrayBufferLike, which admits SharedArrayBuffer)
  // isn't assignable to BlobPart's stricter ArrayBuffer requirement — a
  // plain Uint8Array copy satisfies it.
  formData.append('file', new Blob([new Uint8Array(file.data)], {type: file.mimeType || 'application/octet-stream'}), file.filename);

  const response = await fetch(`${DEFAULT_CMAPI_ENDPOINT}/v1/content`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`},
    body: formData,
  });

  const problem = response.ok ? null : await parseProblem(response.clone());
  return {response, problem};
}

export interface MediaDownload {
  data: Buffer;
  contentType?: string;
}

/**
 * GET /v1/content/{key}/versions/{version}/media — downloads a media
 * item's raw binary bytes for a specific version. Per the CMA's own
 * reference docs (`content_getmedia`): returns the file as a binary stream
 * given a Bearer token, no query params.
 */
export async function getMediaBinary(config: CmapiCredentials, key: string, version: string): Promise<MediaDownload | null> {
  const {response, problem} = await rawRequest(config, `/v1/content/${key}/versions/${version}/media`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CmsError('request_failed', `Failed to download media for ${key} version ${version} (${response.status}): ${describeProblem(problem, await response.text().catch(() => ''))}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  return {data, contentType: response.headers.get('content-type') ?? undefined};
}

export interface CreateVersionInput {
  displayName?: string;
  locale?: string;
  properties?: Record<string, unknown>;
}

/** POST /v1/content/{key}/versions — adds a new version to an existing content item (full properties replace, not a patch). */
export async function createVersion(config: CmapiCredentials, key: string, input: CreateVersionInput): Promise<RequestResult> {
  return rawRequest(config, `/v1/content/${key}/versions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(input),
  });
}

interface ContentItemsResponse {
  items?: ContentItem[];
  totalCount?: number;
}

/** Lists direct children of a container, one page at a time. */
export async function listChildren(
  config: CmapiCredentials,
  containerKey: string,
  pageIndex: number,
  pageSize: number,
): Promise<{items: ContentItem[]; totalCount?: number}> {
  const response = await request(config, `/v1/content/${containerKey}/items?pageIndex=${pageIndex}&pageSize=${pageSize}`);
  const data = (await response.json()) as ContentItemsResponse;
  return {items: data.items ?? [], totalCount: data.totalCount};
}

export {request, describeProblem};
