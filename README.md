# nOCP apps

Reference apps for building against the **nOCP** contract — a small, spec-based way to embed your own tools into Optimizely SaaS CMS's admin sidebar without registering an official Optimizely extension. A companion Chrome extension reads a per-app URL and frame token, docks your app's iframe into the CMS's native sidebar/full-page extensions UI, and (optionally) relays the currently-open content item's ID into it.

Two apps live here, side by side:

- **[`nocp-widget/`](nocp-widget/)** — the full reference implementation: a live-editable settings page, DynamoDB-backed persistence, bespoke app-icon upload, a webhook receiver with an admin listing view. Start here if you want the complete pattern, or to see a real implementation of every optional piece of the spec.
- **[`nOCP-starter/`](nOCP-starter/)** — the minimum set of files needed to build a new nOCP app from scratch, with no runtime-configurable settings and no cloud account required to try it locally. Start here if you're building something simple, or want to pick your own persistence/host from day one.

Both deploy the same way: one AWS Lambda behind a public Function URL, no API Gateway, no server to manage, free within Lambda's (and, for `nocp-widget/`, DynamoDB's) always-free tier. Each has its own README with a quick-start.

## The contract, in short

An embeddable app needs to:

1. Gate its main page behind a shared frame token (`?token=`) **and** `Sec-Fetch-Dest: iframe` — both required, since only the second stops someone pasting the URL into a normal browser tab even with the token.
2. If it has any live-editable settings, put them behind a *separate* token, sent as a header (`X-NOCP-Admin-Token`), never a query param.
3. Serve HTTPS only.
4. Return a small, clearly-labeled "not authorized" page when either gate fails — never a blank screen or a raw framework error.
5. *(Optional)* Listen for a `postMessage` telling it which content item is currently open in the CMS editor, shaped `{source: "nocp-host", type: "content-id", contentGuid, name, contentLink, contentTypeName}`.
6. Expose `POST /nocp/webhook`, open at the route level — the caller is some external service with its own auth scheme, so a shared secret in front would just conflict with it.
7. *(Optional, but recommended)* Expose `GET /nocp/meta` (`{specVersion, name, displayMode, hasIcon}`) and, if `hasIcon` is true, `GET /nocp/icon` — so the extension picks up the app's real name/icon/display mode automatically instead of it being hand-typed into the extension's own settings. Both need `Access-Control-Allow-Origin: *`, since the extension reads them via a plain cross-origin `fetch()`.

Both apps here implement 1–4 and 6 in full; `nocp-widget/` implements 5 and 7 completely (including the icon upload); `nOCP-starter/` implements 5 and a `hasIcon: false` version of 7 (it has nowhere to persist an uploaded icon — see its own README for exactly what would need to be added back).

## A note on the extension side

The Chrome extension that actually docks these apps into the CMS isn't part of this repo. If you have access to it, its own spec document is the authoritative source for the full contract above — treat this README's summary as a quick reference, not a replacement for that.
