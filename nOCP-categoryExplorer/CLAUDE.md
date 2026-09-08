# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A port of `OCPUIs/CategoryExplorerOCPUI` (a real, production Optimizely OCP
CMS UI extension — `app_id: category_explorer`) into the nOCP app format,
deployed as its own Lambda alongside its `nOCP apps/` siblings (`nOCP-widget`,
`nOCP-frontify`, `nOCP-contentTransfer`, `nOCP-starter`). Lets a CMS editor
browse Optimizely CMS categories (fetched live from Optimizely Graph) as a
tree, drill into a category to see the content items tagged with it, and
copy a published item's URL — without going through Optimizely's official
OCP app registration at all. This app is embedded via the nOCP Chrome
extension's registry-spoofing + overlay-iframe mechanism instead.

**This is effectively a full port, not a partial one** — unlike
`nOCP-frontify`'s deliberately-trimmed first pass, the source app is small
(one backend function, one settings field beyond the standard trio, one
sidebar component) and every piece of it made the crossing. The one thing
genuinely dropped is the settings form's "Test Connection" button — see
"What's not ported" below.

## Commands

```bash
./build.sh                                          # type-check, bundle widget + admin + lambda, zip
NOCP_FRAME_TOKEN=<secret> ./deploy/deploy.sh         # build + deploy
# or: cp .env.example .env, fill it in, then just ./deploy/deploy.sh
```

No test suite (`tsc --noEmit` is the correctness gate, same as every other
app in this family).

## Development workflow

Same as `nOCP-frontify`/`nOCP-widget`: no local dev server, no way to
meaningfully unit-test the frame-token gate or SSM reads/writes without
deploying and hitting the real Function URL with `curl`. `deploy.sh` is
safe to re-run.

**Verifying against a live Optimizely Graph instance requires a real Single
Key** — this port was built and its *routing/gating/settings-persistence*
structurally verified (`tsc --noEmit` clean, same shape as the two sibling
Function-URL apps), but the GraphQL query shapes themselves
(`LIST_CATEGORIES_QUERY`/`LIST_CONTENT_QUERY` in `actions.ts`) were carried
over from the source app's `GraphProxyFunction.ts` verbatim rather than
re-derived — that file represents real query shapes already exercised
against a live tenant in the source app. If a query breaks against a real
Graph instance, that's the first place to check before assuming this port
introduced a new bug — the field/argument names weren't changed, only the
transport around them.

## What's not ported (deferred, not forgotten)

- **"Test Connection" button.** The source app's `forms/settings.yml` had a
  bespoke button (wired to `Lifecycle.ts`'s `onSettingsForm` `test_connection`
  action) that validated the Graph Single Key against a trivial query
  *before* saving. nOCP's settings page (`admin.ts`) is a single generic,
  schema-driven core shared verbatim across every app in this family — text/
  secret/secret-masked/toggle/number/image fields plus Save and per-field
  Regenerate, deliberately with no per-app custom actions bolted on (see
  `nOCP-frontify`'s `CLAUDE.md`, "The settings page is a reusable pattern",
  for why that's a deliberate constraint, not an oversight). Adding a
  one-off Test Connection button here would mean forking that shared file
  for this app alone, which the pattern is explicitly designed to avoid —
  same tradeoff `nOCP-frontify` already made for its own third-party
  credentials (Frontify token, CMS client secret: neither gets a pre-save
  test either). An invalid key surfaces the same way those do: the widget's
  first real Graph call fails with a clear "Graph rejected the key" style
  message instead of a dedicated pre-save check.

## Architecture

### Same shape as nOCP-frontify: one Function URL handler, hand-rolled routing

`src/lambda.ts` is a single Function URL handler with hand-rolled routing,
same as every sibling app. The frame-token + `Sec-Fetch-Dest` gate on the
main widget document is identical (NOCP_APP_SPEC.md §1). The widget calls
back to its own backend after the initial page load (`POST
/category-explorer/api`, `{action, params}` → `{ok, result}`/`{ok:false,
error}`), gated by the frame token alone (sent back by the widget's own JS
via `X-Nocp-Frame-Token`, embedded into `window.__NOCP_CONFIG__` at initial
page load) — those are same-page `fetch()` calls, not frame navigations, so
they never carry `Sec-Fetch-Dest: iframe`.

### The settings page is the shared reusable pattern, on SSM

`src/settingsSchema.ts` / `settingsStore.ts` / `admin.ts` are the same
settings-page pattern documented in `nOCP-widget`'s `CLAUDE.md` ("The
settings page is a reusable pattern"), on SSM instead of DynamoDB — same
choice `nOCP-frontify` made, for the same reason: the Graph Single Key
needs SecureString's encryption-at-rest in a way `nOCP-widget`'s plaintext
tokens never did. `admin.ts` is copied unmodified from `nOCP-frontify`'s
copy (itself unmodified from `nOCP-widget`'s, minus the webhook-listing
section neither this app nor `nOCP-frontify` has) — this app's schema is
genuinely small: the standard title/icon/frameToken/adminToken quartet plus
one `secret-masked` field (`singleKey`), one section (`Optimizely Graph`).
No `number`- or `toggle`-typed field exists in this app's schema (unlike
`nOCP-frontify`'s `resultsPerPage`/`disableCopyUrl`), so `SettingField`/
`cleanValue`/`validateSettingsPatch` here don't carry the `min`/`max`
machinery or the toggle branch those types needed — trimmed, not just
unused: with every field in `SettingsValues` typed `string`, TypeScript
narrows `SettingsValues[keyof SettingsValues]` down to plain `string`, so
`cleanValue`'s old `return raw === true` toggle branch (returning a
`boolean`) stopped type-checking the moment the schema no longer had one.

Icon storage is its own SSM Standard parameter (`ICON_PARAM_NAME`, default
`/nocp-category-explorer/icon`), same split `nOCP-frontify` uses and for the
same reason: SSM Standard parameters cap at 4KB total, and a variable-size
uploaded icon sharing a parameter with credentials risks a save 502ing for
reasons unrelated to what was actually being changed (confirmed live on
`nOCP-frontify` the hard way — see that app's `CLAUDE.md`).

### Action router and Graph client: ported logic, swapped transport and storage

`actions.ts` is `GraphProxyFunction.ts`'s `list_categories`/`list_content`
handlers with the OCP-specific plumbing (`App.Function`, `App.Response`,
the try/catch inside `perform()`) replaced by the `handleAction(action,
params) -> {envelope, status}` shape `nOCP-frontify`'s `actions.ts`
established — same two actions, same query strings, same dedupe-by-key
logic for locale-variant collapsing (`dedupeByKey`/`dedupeContentByKey`),
same `TAXONOMY_URI_PREFIX`/`GRAPH_MAX_LIMIT`/`MAX_CATEGORY_PAGES` constants,
untouched.

`graphClient.ts` folds the source app's `OptimizelyGraphClient.ts` +
`GraphErrors.ts` + `GraphRequestError.ts` into one file (small enough not to
need three) — the only real change is `getSingleKey()` reading from this
app's own `settingsStore.getSettings()` instead of OCP's
`storage.settings.get('graph_credentials')`. `testSingleKey()` isn't
carried over — see "What's not ported" above.

### Widget: Axiom kept, no content-id listener needed

`widget.tsx` is `CategoryExplorer.sidebar.tsx` with the OCP-specific
plumbing swapped for the standard nOCP bootstrap
(`createRoot(...).render(...)` reading `window.__NOCP_CONFIG__`, following
`nOCP-frontify`'s `CLAUDE.md` "Widget: React kept, and Axiom is back"
checklist verbatim — same `@optiaxiom/react` dependency, same
`scripts/build-widget.mjs` CSS-splitting/font-CSP fix, same `build.sh`
`--loader:.css=text` step) and `context.extension.invokeFunction(...)`
swapped for `fetch('/category-explorer/api', ...)`. Tree-building
(`buildCategoryTree`), row rendering, and the clipboard-copy fallback
(`copyToClipboard` — Clipboard API first, `execCommand('copy')` fallback for
the sandboxed-iframe case) all ported verbatim, no OCP dependency in any of
them to begin with.

Two things this widget does *not* need that `nOCP-frontify`'s does:

- **No content-id `postMessage` listener.** This app is a pure category/
  content browser, not tied to whatever page happens to be open in the CMS
  editor — the original never called `context.content.get()`/`.subscribe()`
  either, so there's nothing to replace with NOCP_APP_SPEC.md §5's
  contract.
- **No `@optiaxiom/icons` dependency.** The original renders content-type
  glyphs as plain emoji (`getContentTypeIcon` — 🧩/🖼️/📁/📄/📝), not Axiom
  icon components, so `package.json` here is one dependency lighter than
  `nOCP-frontify`'s.

Outer widget padding is deliberately zero (`<Box>`, no `p="12"`) — the nOCP
Chrome extension's overlay iframe host already provides its own margin
around every embedded app's content; see `nOCP-contentTransfer`'s port for
the live bug this was fixed from (a doubled-up padding gap reported from
real CMS sidebar testing).

### `ui_extensions` → nOCP: what didn't need a decision

The source app's `app.yml` declares exactly one sidebar UI extension and one
backend function, both single-purpose (no shared function serving multiple
UI extensions, no `data_sync`/`opal_tools`/other OCP capability types in
play) — there was no architectural ambiguity to resolve in this port the
way `nOCP-contentTransfer`'s job-scheduling replacement needed one. `Test
Connection` (above) is the only place this port's shape genuinely diverges
from the source app's behavior.
