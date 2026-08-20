# nOCP-widget

The nOCP embedded widget (previously `reqCatch/nOCP`), hosted standalone on
AWS instead of inside reqcatch's ASP.NET Core app. reqcatch itself stays on
Azure — this is just the small iframe-embedded widget the nOCP Chrome
extension loads into its overlay panel.

This repo also doubles as the **reference template** for building a new
nOCP app: the settings-page pattern below (`settingsSchema.ts` →
`settingsStore.ts` → `admin.ts`) is written to be copied wholesale into a
new app and adapted by editing one file — see "Building a new nOCP app
from this template" below.

## Architecture

One AWS Lambda function behind a public Function URL — no API Gateway, no
CloudFront, no S3. The Lambda renders every page itself, same as
`reqcatch`'s `Program.cs` did:

- `src/widget.ts` — the client-side widget: a minimal "hello world" that
  just displays the current page's content ID (`Page ID <guid>`), received
  via the content-id `postMessage` contract. Runs inside the iframe.
- `src/lambda.ts` — the Function URL handler; all routing lives here. The
  main widget route re-implements reqcatch's gate: a `?token=` query param
  must match the current frame token, **and** `Sec-Fetch-Dest: iframe` must
  be set (Chrome sets this for a frame's own document load; a direct
  browser navigation can't fake it). Both required.
- `src/settingsSchema.ts` / `settingsStore.ts` / `admin.ts` — the
  live-editable settings page at `/admin`. See below.

Each client-side file (`widget.ts`, `admin.ts`) is bundled to a single
minified JS string and inlined directly into the HTML `lambda.ts` returns.

This is the "cheap and simple" option: everything free-tier-forever
(1M Lambda requests + 400,000 GB-seconds/month, and 25 RCU/WCU of DynamoDB,
permanently — not 12-month trials), zero dependencies at runtime beyond the
AWS SDK the Lambda runtime ships pre-installed, one function to reason about.

### The settings page

Modeled on how Optimizely Connect Platform (OCP) apps declare a settings
page — a plain data schema that a generic renderer turns into an actual
form, rather than hand-writing form markup per field — scaled down to fit
a single Lambda with no framework:

- `src/settingsSchema.ts` declares the fields (`title`, `frameToken`,
  `adminToken` today) as a plain array: key, label, `type`
  (`text`/`secret`/`toggle`), help text, and whether a field is
  `regenerable` (shows a "Regenerate" button that swaps in a fresh
  crypto-random value). This one module is imported by **both** the server
  and the client bundles — esbuild bundles it into each independently, so
  there's a single source of truth with no duplication.
- `src/settingsStore.ts` persists the current values in the same DynamoDB
  table `webhookStore.ts` already uses (a different partition — one small
  table, two purposes), with a short in-memory cache per warm Lambda
  container. The very first read after a fresh deploy finds nothing in
  DynamoDB yet and seeds it from the Lambda's own env vars (see "Deploy"
  below) — after that, DynamoDB is authoritative and redeploying with
  different env vars does **not** overwrite what's live.
- `src/admin.ts` is the settings page itself: prompts for the admin token
  client-side (there's no way for a plain page load to attach a custom
  header — see `NOCP_APP_SPEC.md` §2), then renders the form from
  `SETTINGS_SCHEMA` and does all real reads/writes as `fetch()` calls
  carrying `X-NOCP-Admin-Token`. Unlike OCP's own secret fields (which are
  masked and never redisplayed), tokens here are shown in plain text — the
  whole point of this page is making them easy to see, not hiding them.
  Also lists recent webhooks on the same page, folding in what used to be
  a bare `GET /admin/webhooks` JSON endpoint (still there, machine-
  readable, if you want it directly).

**Frame token bootstrapping**: the frame/admin tokens gate the settings
page itself, so they can't be *purely* settings-page-managed — a bootstrap
value has to come from somewhere before the page is even reachable. That's
still `deploy.sh`'s env vars, exactly as before. What's new: after that
first deploy, both tokens (and the title) become viewable and rotatable
from `/admin` without ever running `deploy.sh` again.

### Building a new nOCP app from this template

1. Copy `src/settingsSchema.ts`, `settingsStore.ts`, `admin.ts`, and the
   `/admin*` routes + `ADMIN_STYLE` block in `lambda.ts` as-is.
2. Edit `SETTINGS_SCHEMA` and `SettingsValues` in `settingsSchema.ts` to
   whatever fields your app actually needs — that's the only file the
   pattern expects you to change. `settingsStore.ts`'s DynamoDB read/write
   and `admin.ts`'s form rendering/regenerate flow are written against the
   schema generically.
3. Swap `src/widget.ts` for your app's actual widget logic.

## Build

```bash
./build.sh
```

Type-checks, bundles `widget.ts` + `admin.ts` + `lambda.ts` with esbuild,
and produces `dist/function.zip`.

## Deploy

Requires AWS CLI v2, authenticated (`aws configure` or `aws configure sso`).

```bash
cp .env.example .env   # fill in NOCP_FRAME_TOKEN (openssl rand -hex 32) and NOCP_TITLE
./deploy/deploy.sh
```

`.env` is gitignored; `deploy.sh` sources it for whatever isn't already set
on the command line, so `NOCP_FRAME_TOKEN=x ./deploy/deploy.sh` still works
too if you'd rather not keep a file around. These are **bootstrap values
only** — see "The settings page" above.

Optional: pass a function name as `$1` (default `nocp-widget`), and set
`AWS_REGION` (default `us-east-1`).

The script is safe to re-run — it creates the IAM role, DynamoDB table, and
Function URL only if missing, and otherwise updates the existing function's
code/config.

On success it prints the Function URL. Copy it into the nOCP extension's
**Options** page for this app (URL field — the extension appends `?token=`
itself, don't include it), then open `<Function URL>/admin` to see and
copy the current frame token into the extension's Frame Token field.

## Rotating a token

Open `/admin`, click **Regenerate** next to the token, then copy the
new value into the extension's Options page (frame token) or wherever else
consumes the admin token. No redeploy needed — this used to require
re-running `deploy.sh` with a new `NOCP_FRAME_TOKEN`; that path still works
for disaster recovery, but the settings page is the normal way now.
