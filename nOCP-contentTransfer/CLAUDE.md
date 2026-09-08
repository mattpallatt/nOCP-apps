# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A port of `OCPUIs/ContentTransfer-OCP-UI` (a real, production Optimizely
OCP CMS UI extension — `app_id: unrvld_content_transfer`) into the nOCP app
format, deployed as its own Lambda (separate from the sibling `nocp-widget`
and `nocp-frontify` apps — see those repos' own `CLAUDE.md`s for what's
shared: the frame-token gate pattern, the `--external:@aws-sdk/*` esbuild
fix, the general Function-URL-only architecture, and the Axiom widget
integration checklist this repo's widget follows). Pushes content-item
trees (with their dependency blocks/media) and content-model definitions
(locales/content-types/property-groups/display-templates) between
Optimizely CMS SaaS environments — a genuinely large port (~2,500 lines of
backend business logic, a 5-component React frontend), not a small utility
like `nocp-frontify`.

This app is embedded via the nOCP Chrome extension's registry-spoofing +
overlay-iframe mechanism, same as every other nOCP app — never through
Optimizely's official OCP app registration.

## Commands

```bash
./build.sh                                          # type-check, bundle widget + admin + lambda, zip
NOCP_FRAME_TOKEN=<secret> ./deploy/deploy.sh         # build + deploy
# or: cp .env.example .env, fill it in, then just ./deploy/deploy.sh

# One-time (or after any jobStore.ts change) — run against a REAL deployed
# table, not part of build.sh:
NOCP_TABLE=nocp-content-transfer-data node scripts/test-jobstore-race.mjs
```

No test suite. `tsc --noEmit` (run inside `build.sh`) is the correctness
gate for everything except `jobStore.ts`'s concurrency behavior, which
`scripts/test-jobstore-race.mjs` verifies separately against live DynamoDB
(type-checking can't catch a race condition).

## The one real architectural problem this port had to solve

The source app relies entirely on OCP's own `Job` framework
(`jobs.trigger()`, a platform-managed "call `perform()` repeatedly until
`complete:true`" loop, state round-tripped by the platform between calls)
for its two checkpointed background jobs: `PreCheckJob` (BFS tree walk +
per-item resolution, time-boxed per invocation) and `ContentTransferJob`
(one plan item written per invocation). **nOCP has no equivalent** — a bare
Lambda Function URL has no re-invocation loop, and buffered invoke mode has
a hard ~30s response ceiling regardless of the Lambda's own configurable
timeout.

**Resolution: don't build a job scheduler — fold "do the next checkpoint"
into the same action the frontend already polls every 1.5s.** The original
design already assumed short (~45s, here reduced to 20s —
`PERFORM_TIME_BUDGET_MS`) time-boxed chunks per invocation; that's
naturally satisfied by one HTTP request per checkpoint. No new AWS infra —
no Step Functions, no self-invoking Lambda, no SQS. See `src/jobStore.ts`.

**The DynamoDB design**: one table (`NOCP_TABLE`, shared with settings —
see below), one item per job:
```
pk: "JOB"  sk: <jobId>
status: "running" | "done" | "error"
version: <number>          // optimistic-lock counter, bumped on lock acquisition
lockedAt: <epoch ms>        // 0 = unlocked
stateJson: <string>         // internal checkpoint state, JSON-stringified
progressJson: <string>      // exact shape the frontend polls for
createdAt / updatedAt
ttl: <epoch seconds>         // now + 24h, auto-cleanup
```

`advanceJobOnce(jobId, checkpointFn)`: reads the item; if already
done/errored, or another invocation's lock is still fresh (< `STALE_LOCK_MS`
= 60s old — comfortably above `PERFORM_TIME_BUDGET_MS` + the Lambda's own
`--timeout 28`, so a legitimately-running checkpoint is never mistaken for
abandoned), returns the current progress with **no work attempted**.
Otherwise it acquires the lock via a single conditional `UpdateItem`
(`ConditionExpression: version = :expectedVersion AND (lockedAt = :zero OR
lockedAt < :staleThreshold)`, bumping `version` atomically as part of the
same write) — this is what actually prevents two overlapping polls from
double-processing the same item, not just a race on the final write. A
`ConditionalCheckFailedException` means another invocation already won;
return current progress, no retry (the next 1.5s poll tries again).
Verified live: `scripts/test-jobstore-race.mjs` fires 5 concurrent
acquire attempts at the same job row and confirms exactly 1 wins.

`preCheckRunner.ts`/`transferRunner.ts` replace `PreCheckJob.ts`/
`ContentTransferJob.ts` — same algorithms (`collectStep`/`resolveStep` from
`preCheck.ts`, `transferSingleItem` from `transferEngine.ts`, both
unchanged), restructured as a `checkpointFn` passed to
`jobStore.advanceJobOnce` instead of a `Job` subclass's `prepare()`/
`perform()`. `startPreCheck`/`startTransfer` create the job row and call
`advanceJobOnce` once inline (so the UI's first paint already shows
checkpoint #1, not a frozen "0 found" for a full round trip);
`getPreCheckProgress`/`getTransferProgress` call it once before reading.
Credentials are re-resolved from settings on every checkpoint, never
carried in job state — same as the source app re-read `storage.secrets`
fresh on every `prepare()` call.

Lambda config: `--timeout 28`, `--memory-size 1024` (media binary transfer
needs the memory). Stays on **buffered** invoke mode, not streaming — every
action already fits one bounded batch; streaming would change the handler
signature for no benefit here.

## Settings — 3 fixed environment slots, flat `SettingField[]`

The source app's own settings form hard-codes 3 numbered slots (`env1`/
`env2`/`env3`, only slot 1 required) because OCP's form system has no
repeatable-group primitive — nOCP's `SettingField[]` schema has the same
limitation, so `src/settingsSchema.ts` replicates the same convention
rather than inventing something new. Per slot: `Name`, `MatchPattern` (CMS
admin hostname substring), `ClientId`, `ClientSecret` (`secret-masked`),
`RootContainer` (optional), `ContentGraphKey`/`ContentGraphSecret`
(optional pair, `secret-masked`) — 7 fields × 3 slots + the standard
`title`/`frameToken`/`adminToken` trio = 24 fields total.

`src/settingsStore.ts` persists to the same DynamoDB table `jobStore.ts`
uses (`NOCP_TABLE`, partition `pk="SETTINGS"` / `sk="CURRENT"`, one item,
each of the 24 fields its own attribute) — one small table, two purposes,
rather than provisioning a second one. Generalizes `nocp-frontify`'s
schema-driven `cleanValue`/`validateSettingsPatch`/`toAdminView` (built for
its 11-field schema) to iterate `SETTINGS_SCHEMA` generically instead of
hardcoding field names — needed here since 24 fields is a lot to hand-write
per-field logic for, and this generalization is itself reusable by a future
app regardless of which storage backend it picks. `src/admin.ts` is
copied verbatim from `nocp-frontify`/`nocp-base` — fully generic against
`SETTINGS_SCHEMA`, needed zero changes to render 4 sections instead of 3.

`environments.ts`'s `buildEnvironmentProfiles(settings)` derives the
source app's `EnvironmentProfile[]` shape from the 21 flat `env1…env3…`
fields on every call (settingsStore's own 15s cache keeps this cheap) — the
source app's `MASKED_SECRET` constant is deleted entirely, replaced by
settingsStore's generic secret-masked handling for every field with that
type. A slot is only included in the built list if its Match Pattern is
non-empty — an all-blank slot 2/3 is skipped rather than becoming an
empty-string profile that would wrongly match every hostname via
`"".includes()` semantics in `findEnvironmentForHostname`.

## Backend port — file by file

| File | Treatment |
|---|---|
| `cma.ts` | Near-verbatim. OAuth token cache: OCP's `storage.kvStore` → a plain module-level `Map` (same call `nocp-frontify` made for its own CMAPI OAuth cache — tokens are cheap to refetch on a cold start). Everything else (`contentExists`, `getContent`, `createContent`, `createMediaContent`, 429 backoff, ...) is plain `fetch()` logic, zero OCP dependency to begin with. |
| `contentGraph.ts`, `dependencyScanner.ts` | Verbatim. No OCP SDK import in the source at all. |
| `environments.ts` | Real changes — see "Settings" above. |
| `preCheck.ts`, `manifest.ts` | Verbatim except the `logger` import swap (`src/logger.ts` — a one-line `console.*` shim every ported file's SDK logger import became). |
| `transferEngine.ts` | **Verbatim except the logger import swap — treated as a hard requirement, not a default.** 900+ lines, the most production-debugged code in the source app (schema-drift retry via `writeWithRetry`'s two-tier property-stripping, soft-deleted-key recovery, media multipart upload, `cms://content/{key}` reference rewriting), all through plain `CmapiCredentials`/`PreCheckItem[]`/`Map` signatures with zero OCP types to begin with. |
| `constants.ts` | Near-verbatim, all source values kept; added `PERFORM_TIME_BUDGET_MS` (20s) and `STALE_LOCK_MS` (60s) for the checkpoint scheme above. |
| `jobStore.ts` | New — the checkpoint/lock primitive (see above). The one genuinely new piece of infrastructure in this whole port. |
| `preCheckRunner.ts`, `transferRunner.ts` | New, replace `PreCheckJob.ts`/`ContentTransferJob.ts` — same algorithms, restructured around `jobStore.advanceJobOnce`'s `checkpointFn` pattern (see above). |
| `actions.ts` | Ported from `CmsUiExtension.ts` — same 11 action names, same `resolveEnvironments`/`describeResolveFailure` hostname-matching logic, same `CmsError`→HTTP status table. `jobs.trigger`+`storage.kvStore` progress reads became `startPreCheck`+`getPreCheckProgress`/`startTransfer`+`getTransferProgress` from the two runner modules. |
| `lambda.ts` | Same shape as `nocp-frontify`'s — `/healthz`, `POST /content-transfer/api` (frame-token gated, no `Sec-Fetch-Dest` check — same-page `fetch()` calls, not frame navigations), `/admin`, `/admin/settings`, and the frame-token+`Sec-Fetch-Dest`-gated main widget document. |

## Frontend port — file by file

All under `src/frontend/`, plus `src/widget.tsx` as the bootstrap entry
point (esbuild target, not inside `frontend/` — matches where `nocp-base`/
`nocp-frontify` put theirs).

| File | Treatment |
|---|---|
| `types.ts`, `formStyles.ts`, `PlanTree.tsx` | Verbatim — pure data/presentation, no `context` dependency in the source either. |
| `invokeAction.ts` | `context.extension.invokeFunction(...)` → `fetch('/content-transfer/api', ...)` carrying `X-Nocp-Frame-Token` — exactly `nocp-frontify`'s widget.tsx's own inline `callAction()` helper, just kept as its own module here since this app's frontend is 5 separate files that all need to call actions (frontify's is one file). The frame token is set once at bootstrap via `setFrameToken()` (module-level holder) instead of threaded through props — every panel calls `invokeAction(action, params)` directly, no `context` param. `captureEmbeddingDiagnostics()` ports verbatim (plain `window.location` reads). |
| `DestinationTree.tsx`, `ModelSyncPanel.tsx` | Only change: drop the unused `context` prop/param. |
| `TransferPanel.tsx` | **The one file with genuinely new integration code.** `context.content.get()`/`.subscribe()` (OCP's "what's open in the CMS editor" RPC) has no nOCP equivalent — replaced with `window.addEventListener('message', ...)` for the nOCP content-ID `postMessage` contract (`NOCP_APP_SPEC.md` §5 — same contract `nocp-base`'s reference `widget.ts` consumes: `{source:"nocp-host", type:"content-id", contentGuid, ...}`). No origin check on the received message, matching that reference implementation. Everything else — the `'form'\|'checking'\|'plan'\|'transferring'\|'done'` phase state machine, 1500ms polling, the "ignore a stale-looking progress read so the counter doesn't flicker backward" guards — ports verbatim. |
| `ContentTransfer.sidebar.tsx` → `widget.tsx` | Mostly verbatim (`AxiomProvider`, the font-size override, the 2-tab `Tabs` shell). OCP's `register()` mount → `createRoot(...).render(...)` reading `window.__NOCP_CONFIG__`, same bootstrap `nocp-frontify`'s widget.tsx uses. |

## The Axiom widget — follows nocp-frontify's checklist exactly

This widget uses `@optiaxiom/react` (Optimizely's real design system), same
as `nocp-frontify`'s. See that app's `CLAUDE.md`, **"Widget: React kept,
and Axiom is back — this time for real"** for the full reusable checklist
(dependencies, `AxiomProvider` wrapping, the esbuild CSS-splitting
mechanic, the Fontsource-relative-path/CSP trap and its jsDelivr-rewrite
fix, confirmed component API gotchas) — this repo's `scripts/
build-widget.mjs` is copied verbatim from that app, no modifications
needed. Confirmed working here too: `dist/widgetbuild/widget.css` built to
~92KB with zero `data:font` URIs remaining (22 real `@fontsource-variable`
rules rewritten to jsDelivr, 2 harmless `data:image/avif` decorative
textures left alone) — the same outcome `nocp-frontify` got applying this
exact fix.

## Honest verification gap

Every "confirmed live" comment carried over from the source app (CMAPI's
`container`/`owner` mutual exclusivity, the two soft-deleted-key error
shapes `writeWithRetry` recovers from, the property-path quirks its
two-tier stripping handles, multipart media upload's key-honoring
behavior, whether Content Graph's `displayName` filter supports `eq`, ...)
reflects verification the *source* app did against a real tenant — porting
verbatim carries that same unverified-vs-plausible status forward, it does
not re-verify it. What *this port itself* has closed:

- **Structural**: every file listed above type-checks (`tsc --noEmit`
  clean across the whole tree) and the full `build.sh` pipeline (esbuild
  widget/admin/lambda bundling, CSS-splitting, zip packaging) completes
  successfully.
- **`jobStore.ts`'s concurrency safety**: verified live via
  `scripts/test-jobstore-race.mjs` against a real deployed table — 5
  concurrent lock-acquisition attempts on the same job row, exactly 1 wins.
- **HTTP-layer gates**: verified live via `curl` against the deployed
  Function URL (see the deploy notes in this repo's git history /
  whoever ran `deploy.sh` last) — `/healthz`, direct-nav 403 on the widget
  route, frame-token+`Sec-Fetch-Dest` 200, `/admin` token gate,
  `/content-transfer/api` frame-token gate.

**Not closed, and can't be from a dev environment**: any actual CMAPI
write. `transferEngine.ts`'s schema-drift retry, soft-deleted-key recovery,
and media multipart upload; `preCheck.ts`'s ancestor-walk and Content Graph
title-match fallback; `manifest.ts`'s per-section apply order — none of
these have been exercised against a real Optimizely CMS SaaS tenant by
*this* port. That needs real CMAPI + Content Graph credentials against a
real tenant, and the real nOCP Chrome extension in a real browser,
worked in ascending risk order: `listEnvironments` (no CMAPI dependency) →
precheck actions (read-only) → transfer actions (real destructive writes)
last.
