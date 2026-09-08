// Near-verbatim port of the source app's src/backend/lib/constants.ts — its
// own header comment (explaining why these live outside a shared/ dir) was
// about a Vite backend-build quirk that doesn't apply here, so it's dropped;
// every value is kept unchanged. PERFORM_TIME_BUDGET_MS and STALE_LOCK_MS
// are new, added for the checkpoint/lock scheme jobStore.ts implements in
// place of OCP's Job framework (see the plan's "one real architectural
// problem" section).

export const DEFAULT_CMAPI_ENDPOINT = 'https://api.cms.optimizely.com';
export const DEFAULT_GRAPH_ENDPOINT = 'https://cg.optimizely.com/content/v2';

// Same pattern used to validate a value before interpolating it raw into a
// GraphQL query string (field/type names, not string-literal positions —
// those go through JSON.stringify instead).
export const GRAPHQL_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Bounded worker-pool size for concurrent CMA writes during a transfer.
// Unconfirmed against a live tenant — CMA rate limits are plausibly
// per-tenant/per-app-registration, not fixed platform-wide.
export const WRITE_CONCURRENCY = 2;

// Bounded retry/backoff for CMA's 429 responses.
export const MAX_429_RETRIES = 4;
export const RETRY_BASE_DELAY_MS = 500;

// A single content write may need several corrective retries as unknown/
// required properties are stripped or placeholder-substituted one at a time
// — bounds that loop so a persistent server error can't spin forever.
export const MAX_WRITE_ATTEMPTS = 25;

// Fixed placeholder content name used when a required reference can't be
// resolved and no fallback container is configured — makes transferred
// content needing editor review easy to find/search for on the target.
export const PLACEHOLDER_DISPLAY_NAME = 'PLACEHOLDER';

// One page's worth of a container's children for the sidebar's destination-
// tree browser — no "load more"/pagination UI exists yet, so a container
// with more children than this simply doesn't show the rest.
export const CONTAINER_CHILDREN_PAGE_SIZE = 200;

// Per-invocation time budget for one precheck/transfer checkpoint — down
// from the source app's 45_000 (that value assumed OCP's own Job loop,
// which had no per-request HTTP timeout to stay under). Leaves headroom
// under both invokeAction.ts's 27_000ms client timeout and the Function
// URL's ~30s buffered-response ceiling.
export const PERFORM_TIME_BUDGET_MS = 20_000;

// A job row's lock is considered abandoned (safe to re-acquire) once its
// lockedAt timestamp is older than this — comfortably above
// PERFORM_TIME_BUDGET_MS plus the Lambda's own --timeout (28s), so a
// checkpoint that's still legitimately running is never mistaken for one
// whose Lambda invocation was hard-killed mid-checkpoint.
export const STALE_LOCK_MS = 60_000;
