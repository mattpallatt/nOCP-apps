# nOCP starter

The minimum set of files needed to build a new nOCP app from scratch — an app the nOCP Chrome extension can embed in Optimizely's SaaS CMS sidebar. Copy this folder out and start from here.

This is deliberately the small starting point, not the fuller reference — that fuller app, `nocp-widget`, isn't included in this folder (this is meant to be copied out and distributed on its own), so nothing below assumes you have it. Where it's mentioned, it's just for context on what a more complete nOCP app looks like: a live-editable settings page, DynamoDB-backed persistence for it, bespoke app-icon upload, a `GET /admin/webhooks` listing. This starter has none of that (frame token and title are plain env vars, no admin surface at all). See "Deliberately not included" below for what that specifically means for the admin surface.

## Quick start

No cloud account needed to see this running:

```bash
npm install
cp .env.example .env    # then set NOCP_FRAME_TOKEN to any value, e.g. `dev`
./build.sh
node dist/serve-local.mjs
```

```bash
curl http://localhost:8787/healthz
# {"status":"ok"}
```

The gated widget route needs a real browser (it checks for `Sec-Fetch-Dest: iframe`, which curl can't send), but this proves the app itself runs — same code, same behavior, zero AWS.

## Architecture

Three files carry the entire app:

- **`src/app.ts`** — the whole app, as one function against the standard `Request`/`Response` objects (the same shapes `fetch()` uses), not any platform-specific event type. This is the part you'd actually edit to add routes or change behavior. It imports nothing AWS-specific — keep it that way.
- **`src/lambda.ts`** — a thin adapter translating AWS Lambda Function URL's event/response shape to and from `Request`/`Response`, then calling `app.ts`. ~50 lines, all mechanical translation.
- **`src/serve-local.ts`** — a second adapter, this one for plain Node's `http` module. Proof that `app.ts` is genuinely host-agnostic, not just in theory — see [Quick start](#quick-start) above.

Plus:

- **`src/widget.ts`** — the client-side script that runs inside the iframe. Renders `Page ID <contentGuid>`, sourced from the content-id `postMessage` contract the extension sends (`{source: "nocp-host", type: "content-id", contentGuid, name, contentLink, contentTypeName}`, per `NOCP_APP_SPEC.md` §5 — see "What this satisfies from the nOCP app spec" below). This is the one thing a real app almost always replaces first.
- **`src/webhookStore.ts`** — an interface (`WebhookStore`) plus one implementation (`inMemoryWebhookStore`) backing the spec-mandated webhook receiver. See [Swapping the webhook store](#swapping-the-webhook-store).

`build.sh` bundles `widget.ts` to a JS string, inlines it into whichever adapter you're building via esbuild's text loader, and produces two runnable outputs: `dist/function.zip` (Lambda) and `dist/serve-local.mjs` (plain Node).

## What this satisfies from the nOCP app spec

The full contract lives in `NOCP_APP_SPEC.md`, published alongside the nOCP Chrome extension — ask whoever gave you this starter for a copy if you need the complete spec text; the bullets below cover what each section requires closely enough to build against on their own. This starter implements:

- **§1 Frame token** — `app.ts` rejects any request to the widget route unless `?token=` matches `NOCP_FRAME_TOKEN` *and* `Sec-Fetch-Dest: iframe` is present. Both checks, server-side, ahead of anything else.
- **§4 Blocked-state response** — a small, clearly-labeled HTML page, not a blank screen or a framework error, when either check fails.
- **§5 Content-ID message contract** — `widget.ts` listens for it and shows the current content GUID. Optional per spec; kept here because almost every real app wants it.
- **§6 Webhook endpoint** — `POST /nocp/webhook`, open at the route level, handing off to `processWebhook` in `app.ts`.
- **§7 App metadata endpoint** — `GET /nocp/meta` returns `{specVersion: 1, name: config.title, displayMode: "sidebar", hasIcon: false}`, so the nOCP Chrome extension picks up this app's name automatically instead of it being hand-typed on the app's card (and, as of a later update, keeps it in sync automatically in the background — no manual re-save needed after a redeploy). `hasIcon` is always `false` and `/nocp/icon` isn't implemented at all — this starter has nowhere to persist an uploaded icon (see below); add the settings-page pattern back first if you want one.

**Deliberately not included: §2, the admin surface.** The spec only requires one when an app has runtime configuration — this starter has none (frame token and title are plain env vars, nothing to edit live). The moment you add a setting a user should be able to change without a redeploy, you need that back: independently token-gated per spec §2 (`X-NOCP-Admin-Token` header, never a query param), backed by whatever persistence you choose (see "Swapping the webhook store" below for the same host-agnostic-interface idea applied to settings), with a form rendered from a small schema (field key/label/type) rather than hand-written per field — that's a reusable shape, not something this starter needs to dictate up front.

## Deploying to AWS Lambda

The same shape as `nocp-widget` — one Lambda behind a public Function URL, no API Gateway, no database:

```bash
NOCP_FRAME_TOKEN=$(openssl rand -hex 32) ./deploy/deploy.sh
```

or `cp .env.example .env`, fill it in, then just `./deploy/deploy.sh`. Safe to re-run — see `deploy/deploy.sh`'s header comment for the full option list. This is free within Lambda's always-free tier.

## Hosting somewhere other than AWS Lambda

This is the actual point of splitting `app.ts` from `lambda.ts`: nothing in `app.ts` — no import, no API call, no type — knows AWS exists. Every host that can run Node (or ships a `fetch`-compatible `Request`/`Response`, which by now is most of them) needs only a small adapter, the same shape as `lambda.ts` or `serve-local.ts`:

```ts
import { createApp } from "./app";
import { inMemoryWebhookStore } from "./webhookStore";

const handleRequest = createApp(
  { frameToken: process.env.NOCP_FRAME_TOKEN ?? "", title: process.env.NOCP_TITLE ?? "nOCP" },
  inMemoryWebhookStore,
);

// However your host wants to receive requests, call handleRequest(request)
// and return what it gives back.
```

Concretely:

- **Cloudflare Workers / Deno Deploy** — both hand you a real `Request` and expect a real `Response` from your entry point already; the adapter is close to `export default { fetch: handleRequest }`.
- **Vercel / Netlify Edge Functions** — same story, both are built on the Request/Response fetch API directly.
- **A plain VM or container** — `src/serve-local.ts` already does this for local dev; harden it (proper logging, don't crash on a bad request) and it's your production adapter too.
- **AWS Lambda but behind API Gateway instead of a Function URL** — API Gateway's payload format v1 is shaped differently than v2 (what `lambda.ts` targets); adjust `toRequest`/`fromResponse` for the v1 field names, same idea.

Whatever the host, the module-load-time setup (`createApp(...)` called once, reused for every request) matters for cold-start performance — don't rebuild it per-request.

## Swapping the webhook store

`inMemoryWebhookStore` (in `src/webhookStore.ts`) is the simplest thing that satisfies the `WebhookStore` interface: zero setup, runs anywhere, but doesn't survive a process restart, and most serverless hosts (Lambda included) don't guarantee the same instance handles the next request — so treat it as a local-dev/demo default, not a real store.

To use a real one, implement the same interface and pass it to `createApp` instead:

```ts
export interface WebhookStore {
  record(event: WebhookEvent): Promise<void>;
}
```

A DynamoDB-backed implementation needs: a table (`pk`/`sk` keys work well — partition on a fixed string like `"WEBHOOK"`, sort on `{receivedUtc}#{id}` so a `Query` with `ScanIndexForward: false` returns newest-first), a TTL attribute for automatic pruning instead of hand-rolled "keep last N" logic, and an IAM policy on the Lambda's execution role granting it `dynamodb:PutItem` (plus `Query`/`GetItem` if you also want to read events back) scoped to that table's ARN — `deploy/deploy.sh` is the place to provision both and grant that access, following the same pattern it already uses for the Lambda function and its role.
