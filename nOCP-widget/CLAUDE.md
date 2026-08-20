# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The nOCP CMS-sidebar widget (previously `reqCatch/nOCP`), standalone on AWS
instead of inside reqcatch's ASP.NET Core app on Azure. It's the small app
the [nOCP Chrome extension](https://github.com/mattpallatt/nocp) loads into
its overlay iframe — see that repo's `NOCP_APP_SPEC.md` for the full
contract this app implements (frame token, admin surface, webhook
endpoint, sandbox constraints). reqcatch itself is unrelated to this repo
now; it stays on Azure purely as a webhook-inspector dashboard.

One AWS Lambda function behind a public Function URL. No API Gateway, no
CloudFront, no S3, no database server — DynamoDB for the things that need
to persist (webhook events, live settings). Everything free within
Lambda's and DynamoDB's always-free tiers (not 12-month trials —
permanently free at this scale).

This repo doubles as the **reference template** for a new nOCP app's
settings page — see "The settings page is a reusable pattern" below before
building a second app's version of this from scratch.

## Commands

```bash
./build.sh                                          # type-check, bundle, zip
NOCP_FRAME_TOKEN=<secret> ./deploy/deploy.sh         # build + deploy (see below)
# or: cp .env.example .env, fill it in, then just ./deploy/deploy.sh
```

No test suite. `build.sh` runs `tsc --noEmit` as its type-check step — that
is the correctness gate here, not unit tests.

## Development workflow

There's no local dev server; `src/lambda.ts` only runs as a Lambda handler,
and testing it meaningfully means deploying and hitting the real Function
URL with `curl` (the frame-token/`Sec-Fetch-Dest` gate and DynamoDB reads
aren't things you can fake by opening the file in a browser). `deploy.sh`
is safe to re-run — it updates an existing function's code/config rather
than failing, and only creates the IAM role, DynamoDB table, and Function
URL if they don't already exist. The DynamoDB access policy is re-applied
on every run regardless, so it stays in sync even after the role already
existed.

Required: `NOCP_FRAME_TOKEN` (deploy.sh errors without it). Optional:
`NOCP_ADMIN_TOKEN` (auto-generated if omitted — printed at the end, keep
it), `NOCP_TITLE`, `AWS_REGION`. All three are **bootstrap values only** —
they seed DynamoDB on the very first invocation after a fresh deploy and
are never consulted again after that; the `/admin` settings page is
the live source of truth from then on. `.env` (gitignored, see
`.env.example`) is a convenient local place to keep them for repeated
deploys, sourced automatically by `deploy.sh` for whatever isn't already
set on the command line.

## Architecture

### One handler, hand-rolled routing

`src/lambda.ts` is a single Function URL handler (API Gateway v2 payload
format — `event.rawPath`, `event.requestContext.http.method`, not the v1
`event.path`/`event.httpMethod` shape) that branches on path/method itself.
No framework: `/healthz`, `POST /nocp/webhook`, `GET /admin`,
`GET`+`POST /admin/settings`, `GET /admin/webhooks`, and the
frame-gated widget route (anything else) are each just an `if` in
`handler`. This is deliberately minimal — there's one file's worth of
routes, a router would be pure overhead.

### The frame-token gate

Same two-check gate as reqcatch's `Program.cs` had: `?token=` query param
must match the current frame token, **and** `Sec-Fetch-Dest: iframe` must
be present (Chrome sets this for a frame's own document load; a direct
address-bar navigation sends `Sec-Fetch-Dest: document` instead and can't
fake the other value). Both required — neither alone is sufficient. See
the nOCP app spec §1 for why. The token itself comes from
`getSettings()` (DynamoDB, falling back to the `NOCP_FRAME_TOKEN` env var
only on a fresh table — see "The settings page is a reusable pattern"
below), not a module-level constant read once at cold start — so a token
rotated via `/admin` takes effect without a redeploy, within the
settings cache's `CACHE_TTL_MS` window at worst.

### Why `@aws-sdk/*` is `--external` in the esbuild bundle

`build.sh` bundles `src/lambda.ts` with `--format=esm` for the Node 20
Lambda runtime. Bundling `@aws-sdk/client-dynamodb` into that ESM output
breaks at runtime with `Dynamic require of "node:https" is not supported`
— esbuild's CJS-in-ESM interop shim can't handle the SDK's internal
`require()` calls for Node builtins once wrapped for ESM. This isn't
theoretical: it crashed *every* route including `/healthz` (a module-level
crash, not a per-route one) the first time this was wired up. Fix: mark
`@aws-sdk/*` external in the esbuild command and let it resolve against
the copy the Node 20.x managed Lambda runtime ships pre-installed — the
package stays a `devDependency` (needed for `tsc --noEmit` locally) but is
never in `dist/function.zip`. If a future change adds another AWS SDK
package, it needs the same `--external` treatment or it'll reproduce this
exact failure.

### Webhook receiver and admin listing

`POST /nocp/webhook` is deliberately open at the route level — per the
nOCP app spec §6, the caller is an arbitrary external service with its own
auth/signing scheme, so a shared secret of ours in front would just
conflict with it. The handler (`processWebhook`-equivalent, inlined in
`handler`) stores the raw request via `src/webhookStore.ts` and returns
`{received: true}` — no validation of the payload itself, that's left to
whatever real integration replaces this reference behavior.

`src/webhookStore.ts` uses partition key `pk = "WEBHOOK"`, sort key
`sk = "{receivedUtc}#{id}"` (so a `Query` with `ScanIndexForward: false`
returns newest-first) with a 7-day TTL attribute for automatic pruning
rather than exact-count capping — simpler than reqcatch's old flat-file
"keep last 20" logic and more idiomatic for DynamoDB, at the cost of not
being an exact cap. `GET /admin/webhooks` gates this behind
`X-NOCP-Admin-Token` (header, never a query param — same reasoning as the
frame token's asymmetry with the admin token in the spec); `admin.ts`
fetches and renders this list as a section of the settings page too, so
`/admin` is one coherent surface rather than the settings form and a
bare JSON endpoint being two separate things to know about.

### The settings page is a reusable pattern

Modeled on how OCP (Optimizely Connect Platform) apps declare a settings
page: a plain data schema drives a generically-written form renderer,
rather than hand-writing markup per field. Three pieces, in dependency
order:

- `src/settingsSchema.ts` — the schema: an array of `{key, label, type:
  "text"|"secret"|"secret-masked"|"toggle"|"number", help, regenerable?,
  min?, max?, section?}`, plus the `SettingsValues` interface. **This is the
  one file a new app copies this pattern for actually needs to edit** —
  change the schema/interface to whatever fields that app needs; everything
  downstream is written against the schema shape, not against
  `title`/`frameToken`/`adminToken` specifically. `secret` vs
  `secret-masked` is a real distinction, not two names for one idea:
  `secret` is for a value *we* generate (shown in plain text, optionally
  `regenerable`); `secret-masked` is for a value that comes from somewhere
  else — a pasted-in third-party API key — shown masked once saved, never
  regenerable, with "submitted unchanged/blank means keep the existing
  value" handled server-side (see nocp-frontify's `settingsStore.ts` for
  the real usage this was extended for). `section` groups fields under a
  heading — omit it everywhere for a single flat list, as this app does.
  It's a plain data module with no server or browser APIs, so esbuild
  bundles it into both `lambda.ts`'s Node bundle and `admin.ts`'s browser
  bundle independently — single source of truth, no duplication, no shared
  build step needed between them.
- `src/settingsStore.ts` — persistence. Same DynamoDB table
  `webhookStore.ts` uses, partition `pk = "SETTINGS"`, `sk = "CURRENT"`,
  one item, each field its own string attribute (not a serialized JSON
  blob — so the current values are readable directly from the DynamoDB
  console too, not just through this app). `getSettings()` bootstraps that
  item from the Lambda's env vars (`NOCP_TITLE`/`NOCP_FRAME_TOKEN`/
  `NOCP_ADMIN_TOKEN`) the first time it's ever called against a table with
  nothing in it yet, then never touches the env vars again — a later
  `deploy.sh` run with different values does not clobber what's live. A
  15-second in-memory cache (`CACHE_TTL_MS`) per warm Lambda container
  avoids a DynamoDB read on every single request while still keeping
  changes live everywhere within seconds; a cold start always reads fresh.
  `regenerateToken()` generates a 64-char lowercase-hex value via
  `crypto.getRandomValues` — same shape as `openssl rand -hex 32`, which is
  what `deploy.sh`'s own instructions tell you to generate manually for the
  bootstrap `.env` value.
- `src/admin.ts` — the client. Prompts for the admin token (stored in
  `sessionStorage`, not `localStorage` — cleared when the tab closes rather
  than persisting indefinitely) since a plain page load can't attach a
  custom header (nOCP app spec §2), then does every real read/write as
  `fetch()` calls carrying `X-NOCP-Admin-Token`. Renders the form by
  iterating `SETTINGS_SCHEMA`, grouped by `section` (each distinct section
  gets one heading, in first-appearance order — a schema with no `section`
  set anywhere, like this app's, gets none) — a future app using any type
  already in `SettingFieldType` is already handled by `fieldInputHtml()`/
  `readFormValues()`/`applyFormValues()`, no new code needed here; a
  genuinely new type needs a case added in all three, same as any other
  change to this shared pattern. Deliberately diverges from OCP's own
  convention of masking `secret`-type fields forever after they're set:
  these are shown in plain text, because the whole point of this page (per
  the human who asked for it) is making tokens easy to see, not hiding
  them — `secret-masked` exists precisely for the fields that *should*
  follow OCP's convention instead (see above). A 403 from either fetch clears the
  stored token and re-prompts rather than showing a dead page.

Server-side validation (`validateSettingsPatch` in `lambda.ts`) rejects a
"save" that would leave any non-toggle field blank — the frame token in
particular going empty wouldn't 500 anything (the gate's own
`settings.frameToken.length > 0` check already treats blank as "never
matches"), but it would silently lock out the widget until someone noticed
and fixed it back via the (independently-tokened) settings page. Also
worth knowing: `settings.title` is now admin-editable where it used to be
an operator-controlled env var, so `lambda.ts` HTML-escapes it before
splicing into the widget page's `<title>` tag — do the same for any new
schema field that ends up spliced into HTML rather than JSON.

**Bootstrapping order matters**: the frame/admin tokens gate the settings
page itself, so they can never become *purely* settings-managed — a
bootstrap value has to exist before the page is reachable at all. That
piece stays exactly as before (`deploy.sh`'s env vars / `.env`). Everything
else about them — viewing, rotating, updating the title — moved off the
redeploy path.

### The widget is deliberately a minimal "hello world"

`src/widget.ts` renders exactly one thing: `Page ID <contentGuid>`, from the
content-id `postMessage` contract (nOCP app spec §5). It used to also show
a config-driven title heading and an image-URL preview input/button — both
removed, along with the `window.__NOCP_CONFIG__` script-tag/`NocpConfig`
plumbing in `lambda.ts` that fed them (nothing else reads it, so it went
too rather than leaving a config channel with no consumer). If this repo
grows back into something demonstrating more than "the extension delivers
the content ID correctly," re-add features here deliberately rather than
reintroducing what was cut — this file's whole reason to exist is being the
minimal reference/proof-of-life widget. It deliberately does **not** carry
`@optiaxiom/react` (Optimizely's real Axiom design system) for this same
reason — a future app that wants the real Optimizely look should follow
nocp-frontify's CLAUDE.md, "Widget: React kept, and Axiom is back — this
time for real," which documents that integration (esbuild CSS-splitting,
the font/CSP trap and its fix, verified component API) as a reusable
checklist rather than re-deriving it from scratch.

### Entry points

- `src/lambda.ts` — the handler; all routing, the frame-token gate, and the
  `/admin*` routes.
- `src/widget.ts` — client-side, runs inside the iframe. Bundled separately
  (`--format=iife`) to `dist/widget.txt`, then inlined into the HTML
  `lambda.ts` returns via esbuild's `--loader:.txt=text`. Same content-ID
  `postMessage` contract and sandbox assumptions as the nOCP app spec §5/§7.
- `src/settingsSchema.ts` / `settingsStore.ts` / `admin.ts` — the
  settings page; see "The settings page is a reusable pattern" above.
  `admin.ts` bundles the same way `widget.ts` does, to `dist/admin.txt`.
- `src/webhookStore.ts` — DynamoDB persistence for received webhooks.
- `deploy/deploy.sh` — provisioning + deploy in one script; see its header
  comment for the full env var list (all bootstrap-only — see "Commands"
  above). `deploy/trust-policy.json` is the Lambda execution role's
  assume-role policy, referenced by that script. `.env.example` is the
  template for the gitignored `.env` deploy.sh sources.
