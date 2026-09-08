// Verbatim port of the source app's src/backend/lib/transferEngine.ts —
// only the logger import swapped for the local shim. This is the most
// production-debugged code in the whole source app (schema-drift retry,
// soft-deleted-key recovery, media transfer, reference rewriting), all
// through plain CmapiCredentials/PreCheckItem[]/Map signatures with zero
// OCP dependency — "unchanged" was a hard requirement for this file during
// the port, not just a default. transferRunner.ts (the checkpoint-driven
// replacement for ContentTransferJob.ts) calls transferSingleItem exactly
// as ContentTransferJob.ts's own perform() did, one item per checkpoint.
import {logger} from './logger';
import {
  CmapiCredentials,
  ContentItem,
  ContentVersion,
  contentExists,
  createContent,
  createMediaContent,
  createVersion,
  describeProblem,
  getContent,
  getContentType,
  getMediaBinary,
  listVersions,
  ProblemDetails,
  publishVersion,
} from './cma';
import {findContentKeyByTitle} from './contentGraph';
import {classifyBaseType, extractReferencedKeys} from './dependencyScanner';
import {MAX_WRITE_ATTEMPTS} from './constants';
import {PreCheckItem} from './preCheck';

const MEDIA_NODE_TYPES = new Set(['Image', 'Video', 'Audio', 'Document']);

export interface TransferOptions {
  // 'Published' writes and publishes every version; 'CheckedOut' leaves the
  // target version in draft.
  status: 'Published' | 'CheckedOut';
  // undefined = transfer every locale the item has; otherwise only these
  // (the item's master/only locale, if it has just one, is always included).
  selectedLocales?: string[];
}

export interface TransferItemResult {
  sourceKey: string;
  targetKey: string;
  name: string;
  success: boolean;
  error?: string;
  failedDependencyKeys: string[];
}

const CMS_CONTENT_URI_PREFIX = 'cms://content/';
const CMS_CONTENT_URI_PATTERN = /cms:\/\/content\/([A-Za-z0-9-]+)/g;

/**
 * Rewrites every `cms://content/{key}` occurrence in a properties tree via
 * `idMap` (identity if a key isn't in the map) — needed only because a
 * top-level plan item can be assigned a different target key than its
 * source key (the `createNew` action, when the source key already exists on
 * target and the user didn't opt to overwrite it). Dependencies (blocks/
 * media) always keep their source key on target (see transferSingleItem),
 * so most keys pass through unchanged; this still walks every value so a
 * reference *to* a renamed top-level item, from anywhere, gets corrected.
 */
function rewriteReferences(value: unknown, idMap: Map<string, string>): unknown {
  if (value == null) return value;

  if (typeof value === 'string') {
    if (!value.startsWith(CMS_CONTENT_URI_PREFIX)) return value;
    const key = value.slice(CMS_CONTENT_URI_PREFIX.length);
    const mapped = idMap.get(key);
    return mapped ? `${CMS_CONTENT_URI_PREFIX}${mapped}` : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteReferences(item, idMap));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(obj)) {
      if (key === 'reference' && typeof nested === 'string') {
        const refKey = nested.startsWith(CMS_CONTENT_URI_PREFIX) ? nested.slice(CMS_CONTENT_URI_PREFIX.length) : null;
        const mapped = refKey ? idMap.get(refKey) : undefined;
        result[key] = mapped ? `${CMS_CONTENT_URI_PREFIX}${mapped}` : nested;
      } else if (key === 'html' && typeof nested === 'string') {
        result[key] = nested.replace(CMS_CONTENT_URI_PATTERN, (match, refKey: string) => {
          const mapped = idMap.get(refKey);
          return mapped ? `${CMS_CONTENT_URI_PREFIX}${mapped}` : match;
        });
      } else {
        result[key] = rewriteReferences(nested, idMap);
      }
    }
    return result;
  }

  return value;
}

interface BadPropertyRef {
  /** Top-level properties-map key — the only thing removable outright. */
  topLevelName: string;
  /** Full path segments after `properties.`, brackets normalized to plain segments (`value[0]` -> `value`, `0`). Length 1 means the error already points at the top level. */
  segments: string[];
}

/**
 * Extracts every property path a CMA 400 response blames — confirmed live
 * that `problem.errors` is an array of `{detail, field}` entries, `field`
 * being a dotted path like `initialVersion.properties.SeoSettings.GraphType`
 * (a *nested* required field inside a component-type property) or
 * `initialVersion.properties.MainContentArea.value[0].contentType` (one of
 * several array-index entries under the same property). Deduped across
 * every entry in one response is left to the caller (there were 5 separate
 * `errors` entries for one bad content-area property in one observed
 * case). Falls back to the first quoted identifier in `detail` (as a
 * bare, one-segment path) if `errors` isn't in this shape.
 */
function extractBadPropertyRefs(problem: ProblemDetails | null | undefined): BadPropertyRef[] {
  const refs: BadPropertyRef[] = [];

  const errorsArray = Array.isArray(problem?.errors) ? problem.errors : [];
  for (const entry of errorsArray) {
    const field = entry && typeof entry === 'object' ? (entry as {field?: unknown}).field : undefined;
    if (typeof field !== 'string') continue;
    const match = field.match(/\bproperties\.(.+)$/);
    if (!match) continue;
    const segments = match[1].replace(/\[(\d+)\]/g, '.$1').split('.');
    refs.push({topLevelName: segments[0], segments});
  }

  if (refs.length === 0 && problem?.detail) {
    const match = problem.detail.match(/'([^']+)'|"([^"]+)"/);
    const fallback = match?.[1] ?? match?.[2];
    if (fallback) refs.push({topLevelName: fallback, segments: [fallback]});
  }

  return refs;
}

/** Deletes the key at the end of `segments` from `root`, walking down through nested objects/arrays (numeric segments index arrays the same way plain object keys work in JS). Returns false if the path doesn't resolve to an existing key, leaving `root` untouched. */
function deleteAtPath(root: Record<string, unknown>, segments: string[]): boolean {
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[segments[i]];
  }
  if (current == null || typeof current !== 'object') return false;
  const obj = current as Record<string, unknown>;
  const lastKey = segments[segments.length - 1];
  if (!(lastKey in obj)) return false;
  delete obj[lastKey];
  return true;
}

/**
 * Deletes the first occurrence of `key` found anywhere in `root`'s subtree
 * (depth-first). Fallback for when a CMA error's `field` path doesn't match
 * the property's actual JSON shape — confirmed live for a component-type
 * property: the error named `SeoSettings.value.SharingImage.properties.value`
 * while the real structure nests it as `SeoSettings.value.properties.
 * SharingImage.value` (`SharingImage` and `properties` swapped) — so
 * deleteAtPath's exact walk found nothing there and returned false.
 */
function deleteKeyDeep(root: unknown, key: string): boolean {
  if (root == null || typeof root !== 'object') return false;
  if (Array.isArray(root)) {
    for (const item of root) {
      if (deleteKeyDeep(item, key)) return true;
    }
    return false;
  }
  const obj = root as Record<string, unknown>;
  if (key in obj) {
    delete obj[key];
    return true;
  }
  for (const value of Object.values(obj)) {
    if (deleteKeyDeep(value, key)) return true;
  }
  return false;
}

interface ParentRef {
  kind: 'container' | 'owner';
  key: string;
}

/**
 * `container` and `owner` are mutually exclusive on a content item —
 * confirmed live via a 400 ("Either 'container' or 'owner' need to be
 * specified when creating content") hit when this app was still always
 * sending `container` (frequently empty/undefined) for page-local "for
 * this page" assets, which CMS SaaS represents via `owner` instead: the
 * key of the page/block that owns them, not a folder to sit inside.
 */
function parentRefOf(content: {container?: string; owner?: string}): ParentRef | null {
  if (typeof content.owner === 'string' && content.owner) return {kind: 'owner', key: content.owner};
  if (typeof content.container === 'string' && content.container) return {kind: 'container', key: content.container};
  return null;
}

/**
 * Writes a content version (create-new-item or new-version-on-existing-item)
 * with a bounded retry loop that strips an offending property out of
 * `properties` and retries when CMA rejects the write over it — minus
 * placeholder-substitution and deferred-forward-reference passes (not
 * implemented — a write that needs those today just fails that item with
 * the CMA's error message surfaced, rather than silently losing data).
 *
 * Deliberately never sends `status` in the write body — confirmed live
 * that CMA rejects it on create ("Status cannot be assigned when creating
 * a new content item", `initialVersion.status`). Every write lands as a
 * draft; publishing is always a separate
 * `POST /v1/content/{key}/versions/{version}:publish` call (see
 * publishVersion), which every caller here makes explicitly once the
 * write succeeds, if publishing is wanted for that item.
 *
 * Returns the key the content actually landed on — normally the same as
 * `targetKey`, but a fresh, randomly minted key when `targetKey` turned
 * out to belong to a soft-deleted item on target (see the soft-deleted-key
 * handling below): every caller must use the *returned* key from here on,
 * not the one it originally passed in, for every subsequent reference to
 * this content (idMap, its own later writes, publishing, ...).
 */
async function writeWithRetry(
  targetConfig: CmapiCredentials,
  targetKey: string,
  isNew: boolean,
  contentType: string,
  // Used when isNew, and also if a soft-deleted-key recreate (see below)
  // switches an update mid-loop into a create — every caller now passes
  // this unconditionally rather than only on what it expects to be the
  // first write, so it's available if that switch happens.
  parent: ParentRef | undefined,
  properties: Record<string, unknown>,
  locale: string | undefined,
  displayName: string | undefined,
): Promise<string> {
  let currentKey = targetKey;
  let currentIsNew = isNew;
  let currentProperties = properties;
  // Top-level properties already removed outright — no further stripping
  // possible for these, so a re-implicated one is skipped rather than
  // looping forever.
  const strippedProperties = new Set<string>();
  // Top-level properties where a *surgical* (nested-leaf-only) delete has
  // already been tried once — see the two-tier strategy below.
  const surgicallyAttempted = new Set<string>();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const result = currentIsNew
      ? await createContent(targetConfig, parent?.kind === 'owner'
        ? {
          key: currentKey,
          contentType,
          owner: parent.key,
          initialVersion: {displayName, locale, properties: currentProperties},
        }
        : {
          key: currentKey,
          contentType,
          container: parent?.key ?? '',
          initialVersion: {displayName, locale, properties: currentProperties},
        })
      : await createVersion(targetConfig, currentKey, {displayName, locale, properties: currentProperties});

    if (result.response.ok) return currentKey;

    if (result.response.status === 400) {
      const refs = extractBadPropertyRefs(result.problem)
        .filter((ref) => currentProperties[ref.topLevelName] !== undefined && !strippedProperties.has(ref.topLevelName));

      if (refs.length > 0) {
        // Two-tier: a top-level property can be both required (can't be
        // removed outright) and hold a separate broken nested value (e.g. a
        // "SeoSettings" component with a required GraphType field *and* a
        // dangling SharingImage reference) — found live that stripping the
        // whole property to fix the nested issue then fails required-ness
        // instead. Try deleting just the offending leaf first; only escalate
        // to removing the whole property if that specific one is
        // implicated again on a later attempt (surgicallyAttempted already
        // has it), or the error already names the top level directly.
        const nextProperties = structuredClone(currentProperties) as Record<string, unknown>;
        const adjusted: string[] = [];

        for (const ref of refs) {
          if (ref.segments.length > 1 && !surgicallyAttempted.has(ref.topLevelName)) {
            surgicallyAttempted.add(ref.topLevelName);
            if (deleteAtPath(nextProperties, ref.segments)) {
              adjusted.push(ref.segments.join('.'));
              continue;
            }
            // Exact path didn't resolve — the error path can name segments
            // in a different order than the real JSON shape (confirmed
            // live for a component property). Fall back to finding the
            // specific named field anywhere within this top-level
            // property's own subtree: real property names are PascalCase
            // by convention throughout this schema (SharingImage,
            // GraphType, MainContentArea, ...), unlike the generic
            // lowercase wrapper words ("value", "properties") every
            // component/array property also has, so the last PascalCase
            // segment is the best guess at the actual offending field.
            const nestedSegments = ref.segments.slice(1); // exclude topLevelName itself
            let deepKey: string | undefined;
            for (let i = nestedSegments.length - 1; i >= 0; i--) {
              if (/^[A-Z]/.test(nestedSegments[i])) {
                deepKey = nestedSegments[i];
                break;
              }
            }
            if (deepKey && deleteKeyDeep(nextProperties[ref.topLevelName], deepKey)) {
              adjusted.push(`${ref.topLevelName}..${deepKey}`);
              continue;
            }
          }
          if (ref.topLevelName in nextProperties) {
            delete nextProperties[ref.topLevelName];
            strippedProperties.add(ref.topLevelName);
            adjusted.push(ref.topLevelName);
          }
        }

        if (adjusted.length > 0) {
          logger.warn(
            `[ContentTransfer] Adjusted (${adjusted.join(', ')}) on ${currentKey} after a 400 and retrying: ` +
            describeProblem(result.problem, ''),
          );
          currentProperties = nextProperties;
          continue;
        }
      }
    }

    const detail = result.problem?.detail ?? '';
    // A soft-deleted key on target rejects every future write against it —
    // confirmed live in two different shapes depending on which write hit
    // it: a 409 "must be undeleted" on createContent (a fresh create
    // targeting a key that was previously deleted), and a 400 "has been
    // deleted and can therefore not be modified" on createVersion (the
    // update path an Overwrite-matched key takes, since a soft-deleted item
    // still counts as "exists" for the contentExists check that decides
    // create vs. update). Neither is recoverable under the same key
    // regardless of which write hit it, so this always mints a fresh key
    // and switches to a create from here on — even for a write that started
    // out as an update — the same way this app already mints a fresh key at
    // pre-check time when a source key is occupied by something *else* on
    // target (see preCheck.ts's mintContentKey/createNew action). Every
    // property already stripped so far carries over unchanged; only the key
    // (and, if this was an update, the create-vs-update choice) changes.
    if (/must be undeleted|has been deleted and can therefore not be modified/i.test(detail)) {
      const newKey = mintContentKey();
      logger.warn(
        `[ContentTransfer] ${currentKey} was previously deleted on target — recreating under a new key ` +
        `${newKey} instead of failing.`,
      );
      currentKey = newKey;
      currentIsNew = true;
      continue;
    }

    if (result.response.status === 409) {
      // Mirrors treating "already exists under a different parent" as
      // logged (not silently swallowed), treated as already-there rather
      // than a hard failure for this write.
      logger.warn(`[ContentTransfer] 409 writing ${currentKey}: ${detail || 'conflict'} — treating as already present.`);
      return currentKey;
    }

    throw new Error(`Write to ${currentKey} failed (${result.response.status}): ${describeProblem(result.problem, '')}`);
  }

  throw new Error(`Write to ${currentKey} failed after ${MAX_WRITE_ATTEMPTS} attempts (properties kept getting rejected).`);
}

/** Same key-minting as preCheck.ts's own mintContentKey (kept local — that one is intentionally module-private, used only for its own createNew-vs-source-key decision at pre-check time; this one is for a key discovered to be unusable only once a write is actually attempted). */
function mintContentKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Creates a minimal placeholder for a top-level plan item that's needed as
 * a dependency's `container`/`owner` before its own turn comes up in
 * transferSingleItem — using that item's own already-resolved
 * targetParentKey (computed once by preCheck's ancestor-walk-with-root-
 * fallback), never a fresh walk of its raw source container/owner chain.
 * Overwritten with the item's real content moments later regardless (see
 * transferSingleItem), so sending its full current properties here (not an
 * empty object) just lets writeWithRetry's stripping converge correctly —
 * required properties with valid data survive, only genuinely broken ones
 * get dropped. See resolveParentOnTarget for why this replaced an earlier
 * design that also recursed into *non*-plan ancestors, recreating them too.
 */
async function stubPlanItem(ctx: TransferContext, planItem: PreCheckItem): Promise<void> {
  if (ctx.containerVisited.has(planItem.targetKey)) return;
  ctx.containerVisited.add(planItem.targetKey);
  if (await contentExists(ctx.targetConfig, planItem.targetKey)) return;

  const sourceContent = await getContent(ctx.sourceConfig, planItem.sourceKey);
  if (!sourceContent) return; // nothing to copy — let the caller's own write surface the resulting error, if any

  const [latestVersion] = await listVersions(ctx.sourceConfig, planItem.sourceKey, 1);
  // planItem.targetParentKey can itself name another batch sibling's
  // planned key (see preCheck.ts's batchTargetKeyByOwnKey) — resolve
  // through idMap in case that sibling was already recreated under a fresh
  // key earlier in this same batch (writeWithRetry's soft-deleted-key
  // handling), same reasoning as transferSingleItem's own parent lookup.
  const targetParentKey = planItem.targetParentKey ? (ctx.idMap.get(planItem.targetParentKey) ?? planItem.targetParentKey) : undefined;
  logger.warn(
    `[ContentTransfer] Creating placeholder for upcoming plan item ${planItem.sourceKey} as ${planItem.targetKey} ` +
    `(parent=${targetParentKey ?? 'none'}) so an earlier dependency can reference it — its real content ` +
    'overwrites this once its own turn comes.',
  );
  const rewrittenProperties = rewriteReferences(latestVersion?.properties ?? {}, ctx.idMap) as Record<string, unknown>;
  const writtenKey = await writeWithRetry(
    ctx.targetConfig,
    planItem.targetKey,
    true,
    sourceContent.contentType as string,
    targetParentKey ? {kind: 'container', key: targetParentKey} : undefined,
    rewrittenProperties,
    latestVersion?.locale,
    latestVersion?.displayName,
  );
  if (writtenKey !== planItem.targetKey) {
    // Recreated under a fresh key (see writeWithRetry's "must be
    // undeleted" handling) — this plan item's own eventual real write
    // (transferSingleItem) reads item.targetKey directly, and every other
    // reference to this source key goes through idMap, so both need to
    // point at the key it actually landed on from here on.
    ctx.idMap.set(planItem.sourceKey, writtenKey);
    planItem.targetKey = writtenKey;
  }
  // Not fatal: this stub gets overwritten with the item's real content (and
  // published then, per options.status) once its own turn comes regardless
  // — a publish hiccup here shouldn't abort the *dependency* that needed
  // this stub to exist as its parent in the first place. Found live: it
  // otherwise did exactly that (a publish failure here surfaced as the
  // dependency's own transfer failing, with a confusing "could not
  // determine version to publish" message that was actually about this
  // placeholder, not the dependency itself).
  try {
    await publishVersion(ctx.targetConfig, writtenKey);
  } catch (error) {
    logger.warn(`[ContentTransfer] Could not publish placeholder ${writtenKey} (non-fatal — it exists as a draft, which is enough for dependents to reference it):`, error);
  }
}

/**
 * Best-effort match for an ancestor that has no equivalent on target under
 * the same key and isn't one of this batch's own plan items: looks for an
 * existing Published page with the same title anywhere on target — not
 * scoped to any one container. Content transferred into a real, populated
 * site is not necessarily filed below whatever container happens to be
 * configured as the fallback root, so a search bounded to that container's
 * own children would miss real matches living elsewhere in the tree.
 *
 * Requires Content Graph credentials for this environment (see
 * environments.ts) — CMAPI itself has no cross-tree search by property
 * value, only per-container listing. Silently returns null (falls through
 * to the rootContainer fallback in resolveParentKeyOnTarget) if this
 * environment has none configured, or if the source ancestor's own latest
 * version has no locale to search with.
 */
async function findMatchingKeyByTitle(ctx: TransferContext, sourceAncestorKey: string): Promise<string | null> {
  if (!ctx.targetConfig.contentGraphKey || !ctx.targetConfig.contentGraphSecret) {
    logger.warn(`[ContentTransfer] No Content Graph credentials configured for this target — skipping title match for ${sourceAncestorKey}, going straight to the fallback root container.`);
    return null;
  }

  const [sourceVersion] = await listVersions(ctx.sourceConfig, sourceAncestorKey, 1);
  const title = sourceVersion?.displayName?.trim();
  const locale = sourceVersion?.locale;
  if (!title || !locale) {
    logger.warn(`[ContentTransfer] ${sourceAncestorKey}'s latest source version has no displayName/locale to search with (title=${JSON.stringify(title)}, locale=${JSON.stringify(locale)}) — skipping title match.`);
    return null;
  }

  logger.warn(`[ContentTransfer] Searching target via Content Graph for a Published page titled ${JSON.stringify(title)} (locale ${locale}) to stand in for ${sourceAncestorKey}...`);
  try {
    const match = await findContentKeyByTitle(
      {contentGraphKey: ctx.targetConfig.contentGraphKey, contentGraphSecret: ctx.targetConfig.contentGraphSecret},
      locale,
      title,
    );
    logger.warn(`[ContentTransfer] Content Graph title search for ${JSON.stringify(title)} → ${match ?? 'no match'}`);
    return match;
  } catch (error) {
    // Best-effort: a broken/rejected Graph query (bad credentials, an
    // unsupported filter, ...) shouldn't abort the dependency that needed
    // this lookup — same reasoning as stubPlanItem's non-fatal publish
    // above. Falls through to the rootContainer fallback instead.
    logger.warn(`[ContentTransfer] Content Graph title search for ${JSON.stringify(title)} failed — falling back to the root container instead:`, error);
    return null;
  }
}

/**
 * Resolves what a dependency's `container`/`owner` reference should point
 * at on target, given the same reference on source. Replaces an earlier
 * design that recursively recreated *every* ancestor's full content as a
 * "stub", all the way up to the site root if needed. Found live: for a
 * dependency several containers deep, that meant an unrelated real page
 * (the site's own homepage, several levels up) got needlessly recreated on
 * target just to give one small dependency somewhere to sit — and dragged
 * its own unrelated failures along with it (content-type mismatches for
 * blocks that don't exist on target, dangling references to assets never
 * transferred).
 *
 * New behavior: if the ancestor is itself one of this batch's own top-level
 * plan items, ensure a placeholder for it (via stubPlanItem, using that
 * item's own already-resolved targetParentKey — never its raw source
 * ancestor chain). Otherwise — a genuine "orphan" ancestor outside the
 * batch — it is never recreated: reused as-is if it already exists under
 * the same key, else matched by title anywhere on target via Content Graph
 * (findMatchingKeyByTitle), else the fallback root container itself is used
 * in its place. Returns null only if none of those resolve (no fallback
 * root configured either) — the dependency's write then proceeds without a
 * parent and fails with a clear CMA error rather than being silently
 * mis-parented.
 */
async function resolveParentOnTarget(ctx: TransferContext, parent: ParentRef): Promise<ParentRef | null> {
  const cached = ctx.parentResolutionCache.get(parent.key);
  if (cached !== undefined) return cached ? {kind: parent.kind, key: cached} : null;

  const resolved = await resolveParentKeyOnTarget(ctx, parent.key);
  ctx.parentResolutionCache.set(parent.key, resolved);
  return resolved ? {kind: parent.kind, key: resolved} : null;
}

async function resolveParentKeyOnTarget(ctx: TransferContext, sourceParentKey: string): Promise<string | null> {
  const targetKey = ctx.idMap.get(sourceParentKey) ?? sourceParentKey;
  if (await contentExists(ctx.targetConfig, targetKey)) return targetKey;

  const planItem = ctx.itemsBySourceKey.get(sourceParentKey);
  if (planItem && planItem.action !== 'unresolvable') {
    await stubPlanItem(ctx, planItem);
    return planItem.targetKey;
  }

  const titleMatch = await findMatchingKeyByTitle(ctx, sourceParentKey);
  if (titleMatch) {
    logger.warn(
      `[ContentTransfer] ${sourceParentKey} has no match on target — using existing target page ${titleMatch} ` +
      '(matched by title) instead of recreating it.',
    );
    return titleMatch;
  }

  if (ctx.targetConfig.rootContainer) {
    logger.warn(
      `[ContentTransfer] ${sourceParentKey} has no match on target and no title match was found — using the ` +
      'configured fallback root container instead of recreating it.',
    );
    return ctx.targetConfig.rootContainer;
  }

  logger.warn(
    `[ContentTransfer] ${sourceParentKey} has no match on target, no title match, and no fallback root ` +
    'container is configured — the dependent write may fail without a valid parent.',
  );
  return null;
}

/**
 * Downloads an existing media item's binary from source (confirmed via
 * CMA's own reference docs: `GET /v1/content/{key}/versions/{version}/media`)
 * and re-uploads it to target via createMediaContent — see that function's
 * doc comment for why plain JSON creation doesn't work for media content
 * types.
 *
 * Returns the key the media item actually landed on — see writeWithRetry's
 * doc comment for why this can differ from `key` (a soft-deleted key on
 * target).
 */
async function transferMediaBinary(
  ctx: TransferContext,
  key: string,
  sourceContent: ContentItem,
  latestVersion: ContentVersion | undefined,
  parent: ParentRef | undefined,
): Promise<string> {
  if (!parent) {
    throw new Error(`Cannot create media ${key} on target — no container/owner resolved for it on source.`);
  }
  if (!latestVersion?.version) {
    throw new Error(`No version number found on source for media ${key} — cannot download its binary.`);
  }

  const download = await getMediaBinary(ctx.sourceConfig, key, latestVersion.version);
  if (!download) {
    throw new Error(`Source binary for media ${key} (version ${latestVersion.version}) was not found.`);
  }

  const filename = latestVersion.displayName || key;
  let currentKey = key;

  // Bounded at 2 attempts (original key, then one rekey retry) — unlike
  // writeWithRetry's property-stripping loop, there's nothing else that
  // could still be wrong here after a rekey, so a second failure is a real
  // error, not something worth looping MAX_WRITE_ATTEMPTS times over.
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = parent.kind === 'owner'
      ? {key: currentKey, contentType: sourceContent.contentType as string, owner: parent.key, displayName: filename, locale: latestVersion.locale}
      : {key: currentKey, contentType: sourceContent.contentType as string, container: parent.key, displayName: filename, locale: latestVersion.locale};

    const {response, problem} = await createMediaContent(
      ctx.targetConfig,
      input,
      {filename, data: download.data, mimeType: download.contentType},
    );
    if (response.ok) {
      await publishVersion(ctx.targetConfig, currentKey);
      return currentKey;
    }

    // See writeWithRetry's matching 409 handling for why this specific
    // message gets a fresh key instead of a hard failure.
    if (response.status === 409 && /must be undeleted/i.test(problem?.detail ?? '')) {
      const newKey = mintContentKey();
      logger.warn(
        `[ContentTransfer] ${currentKey} was previously deleted on target — recreating media under a new key ` +
        `${newKey} instead of failing.`,
      );
      currentKey = newKey;
      continue;
    }

    // Not a property-level issue writeWithRetry's stripping loop could fix
    // — CMA is rejecting the owner assignment outright, most likely because
    // the owner's content type doesn't declare media/assets as an allowed
    // child on this environment (a real content-model difference between
    // source and target, not something a retry here can work around).
    // Dumping both environments' schema for the owner's content type so the
    // next report shows exactly what differs, rather than guessing.
    if (response.status === 400 && /doesn't support assets/i.test(problem?.detail ?? '')) {
      try {
        const ownerContent = await getContent(ctx.targetConfig, parent.key);
        const ownerType = ownerContent?.contentType as string | undefined;
        if (ownerType) {
          const [sourceSchema, targetSchema] = await Promise.all([
            getContentType(ctx.sourceConfig, ownerType),
            getContentType(ctx.targetConfig, ownerType),
          ]);
          logger.warn(`[ContentTransfer] Owner content type '${ownerType}' (${parent.key}) schema on source: ${JSON.stringify(sourceSchema)}`);
          logger.warn(`[ContentTransfer] Owner content type '${ownerType}' (${parent.key}) schema on target: ${JSON.stringify(targetSchema)}`);
        } else {
          logger.warn(`[ContentTransfer] Could not read owner ${parent.key}'s content type on target for diagnostics.`);
        }
      } catch (schemaError) {
        logger.warn('[ContentTransfer] Could not fetch owner content-type schema for diagnostics:', schemaError);
      }
    }

    throw new Error(`Media upload for ${currentKey} failed (${response.status}): ${describeProblem(problem, '')}`);
  }

  throw new Error(`Media upload for ${key} failed after retrying under a new key.`);
}

async function classifyDependencyNodeType(sourceConfig: CmapiCredentials, content: ContentItem): Promise<string> {
  if (typeof content.contentType !== 'string') return 'Unknown';
  const schema = await getContentType(sourceConfig, content.contentType);
  return classifyBaseType(schema?.baseType);
}

interface TransferContext {
  sourceConfig: CmapiCredentials;
  targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string};
  idMap: Map<string, string>;
  // Every top-level item in this transfer batch, keyed by its source key —
  // lets resolveParentOnTarget recognize when a dependency's container/
  // owner is itself something this batch is about to create for real,
  // rather than a genuine orphan ancestor outside the batch. Not just
  // `item` (the one being processed right now): a dependency can point at
  // any other plan item too, already-processed or not-yet-processed.
  itemsBySourceKey: Map<string, PreCheckItem>;
  // Memoizes resolveParentOnTarget's result per source ancestor key (null
  // for "couldn't resolve") so a container shared by many dependencies —
  // common for "for this page" owners — isn't re-resolved (and, for the
  // title-search path, re-queried) once per dependency.
  parentResolutionCache: Map<string, string | null>;
  visitedDependencies: Set<string>;
  containerVisited: Set<string>;
  onProgress?: () => void;
}

/** Depth-first: transfers every referenced dependency of a version's properties before the item itself is written. Dependencies always keep their source key on target and are always re-written (never skipped just because they already exist — a stale copy would otherwise never get corrected). */
async function transferDependencies(ctx: TransferContext, properties: Record<string, unknown> | undefined): Promise<string[]> {
  const failed: string[] = [];
  const referencedKeys = extractReferencedKeys(properties);

  for (const key of referencedKeys) {
    if (ctx.visitedDependencies.has(key)) continue;
    ctx.visitedDependencies.add(key);

    let sourceContent: Awaited<ReturnType<typeof getContent>> = null;
    let latestVersion: Awaited<ReturnType<typeof listVersions>>[number] | undefined;

    try {
      sourceContent = await getContent(ctx.sourceConfig, key);
      if (!sourceContent) continue; // dangling reference on source — nothing to transfer

      [latestVersion] = await listVersions(ctx.sourceConfig, key, 1);
      const childFailed = await transferDependencies(ctx, latestVersion?.properties as Record<string, unknown> | undefined);
      failed.push(...childFailed);

      const parent = parentRefOf(sourceContent);
      const remappedParent = parent ? (await resolveParentOnTarget(ctx, parent)) ?? undefined : undefined;

      const alreadyOnTarget = await contentExists(ctx.targetConfig, key);
      const nodeType = await classifyDependencyNodeType(ctx.sourceConfig, sourceContent);

      if (MEDIA_NODE_TYPES.has(nodeType) && !alreadyOnTarget) {
        // Plain JSON creation 400s for media content types — needs the
        // multipart upload path instead (see createMediaContent).
        const writtenKey = await transferMediaBinary(ctx, key, sourceContent, latestVersion, remappedParent);
        if (writtenKey !== key) ctx.idMap.set(key, writtenKey);
      } else if (MEDIA_NODE_TYPES.has(nodeType)) {
        // Already exists on target — re-uploading/updating an existing
        // media item's binary isn't implemented (unconfirmed whether/how
        // CMA supports replacing one), so this is left as-is rather than
        // risked with an unconfirmed write.
        logger.warn(`[ContentTransfer] Media ${key} already exists on target — leaving it as-is (binary re-upload for existing media isn't implemented).`);
      } else {
        const rewrittenProperties = rewriteReferences(latestVersion?.properties ?? {}, ctx.idMap) as Record<string, unknown>;
        const writtenKey = await writeWithRetry(
          ctx.targetConfig,
          key,
          !alreadyOnTarget,
          sourceContent.contentType as string,
          remappedParent,
          rewrittenProperties,
          latestVersion?.locale,
          latestVersion?.displayName,
        );
        if (writtenKey !== key) ctx.idMap.set(key, writtenKey);
        // Dependencies (blocks/media) are always published, independent of
        // the top-level item's chosen publish state — an unpublished block
        // referenced by a published page would leave that page broken.
        await publishVersion(ctx.targetConfig, writtenKey);
      }
      if (ctx.onProgress) ctx.onProgress();
    } catch (error) {
      logger.warn(`[ContentTransfer] Dependency ${key} failed to transfer:`, error);
      // Dumping the raw source content+version JSON on any failure — most
      // usefully for a media transfer that fails past the point
      // resolveBinaryUrlCandidates already logs its own candidate list, or
      // for any other still-unexplained rejection.
      if (sourceContent) {
        logger.warn(`[ContentTransfer] Raw source content for ${key}: ${JSON.stringify(sourceContent)}`);
        logger.warn(`[ContentTransfer] Raw source latest version for ${key}: ${JSON.stringify(latestVersion)}`);
      }
      failed.push(key);
    }
  }

  return failed;
}

/**
 * Transfers one top-level plan item: its dependencies first, then the item
 * itself (every selected locale), publishing unless options.status is
 * 'CheckedOut'. `allItems` is the full batch (not just `item`) — needed so
 * resolveParentOnTarget can recognize a dependency's container/owner as
 * another one of this batch's own plan items, not just the one currently
 * being processed.
 */
export async function transferSingleItem(
  sourceConfig: CmapiCredentials,
  targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string},
  item: PreCheckItem,
  allItems: PreCheckItem[],
  idMap: Map<string, string>,
  options: TransferOptions,
  visitedDependencies: Set<string>,
  containerVisited: Set<string>,
  onProgress?: () => void,
): Promise<TransferItemResult> {
  const ctx: TransferContext = {
    sourceConfig,
    targetConfig,
    idMap,
    itemsBySourceKey: new Map(allItems.map((i) => [i.sourceKey, i])),
    parentResolutionCache: new Map(),
    visitedDependencies,
    containerVisited,
    onProgress,
  };

  try {
    const sourceContent = await getContent(sourceConfig, item.sourceKey);
    if (!sourceContent) {
      return {sourceKey: item.sourceKey, targetKey: item.targetKey, name: item.name, success: false, error: 'Source content no longer exists.', failedDependencyKeys: []};
    }

    const versions = await listVersions(sourceConfig, item.sourceKey, 20);
    // listVersions returns revision history (most recent first), not one
    // entry per locale — multiple historical revisions can share the same
    // locale. Found live: writing every historical revision as if each were
    // a distinct locale produced a spurious "content item not found" 404 on
    // a later createVersion call once this got out of sync with reality.
    // Keep only the latest version per distinct locale — Map preserves
    // insertion order, and `versions[0]` (the master/latest) is inserted
    // first, so it stays first after the filter below too.
    const latestVersionByLocale = new Map<string, ContentVersion>();
    for (const version of versions) {
      const locale = typeof version.locale === 'string' ? version.locale : '';
      if (!latestVersionByLocale.has(locale)) latestVersionByLocale.set(locale, version);
    }
    const [latest] = versions;
    const masterLocale = typeof latest?.locale === 'string' ? latest.locale : '';
    const toWrite = options.selectedLocales
      ? Array.from(latestVersionByLocale.entries())
        .filter(([locale]) => locale === masterLocale || options.selectedLocales!.includes(locale))
        .map(([, version]) => version)
      : Array.from(latestVersionByLocale.values());

    const failedDependencyKeys: string[] = [];
    for (const version of toWrite) {
      const childFailed = await transferDependencies(ctx, version.properties as Record<string, unknown> | undefined);
      failedDependencyKeys.push(...childFailed);
    }

    // item.targetParentKey is a *target*-side key computed once by
    // preCheck's ancestor walk — for a batch sibling, that's the sibling's
    // planned targetKey at plan time, which for a 'create'/'overwrite'
    // sibling is just its sourceKey (see preCheck.ts's
    // batchTargetKeyByOwnKey). If that sibling's *actual* write later
    // recreated it under a fresh key (writeWithRetry's soft-deleted-key
    // handling), idMap — keyed by sourceKey — is exactly what already
    // tracks the replacement, so resolving through it here keeps a child
    // pointed at wherever its parent really landed instead of the
    // now-invalid key preCheck originally planned for it.
    const targetParentKey = item.targetParentKey ? (idMap.get(item.targetParentKey) ?? item.targetParentKey) : undefined;

    // By construction the resolved parent should already exist by the time
    // this item's own turn comes (a parent is always enumerated, and thus
    // processed, before its children — see collectItems). Just confirm that
    // invariant held rather than attempting to (re-)create anything.
    if (item.action !== 'overwrite' && targetParentKey && !(await contentExists(targetConfig, targetParentKey))) {
      logger.warn(
        `[ContentTransfer] Target parent ${targetParentKey} for ${item.sourceKey} does not exist yet — ` +
        'the write below will likely fail; expected it to already exist by this point in the batch.',
      );
    }

    const alreadyOnTarget = item.action === 'overwrite' || await contentExists(targetConfig, item.targetKey);

    for (const version of toWrite.length > 0 ? toWrite : [undefined]) {
      const rewrittenProperties = rewriteReferences(version?.properties ?? {}, idMap) as Record<string, unknown>;
      const isFirstWrite = !alreadyOnTarget && version === toWrite[0];
      // Top-level plan items are always pages, which are always
      // container-based (never `owner` — that's only for page/block-local
      // assets) — preCheck's ancestor-walk already resolved this to an
      // existing target key. Sent unconditionally (not just on
      // isFirstWrite): an `overwrite` write normally has no use for it
      // (isFirstWrite is always false there), but writeWithRetry needs it
      // on hand in case that overwrite's target key turns out to be
      // soft-deleted on target and it has to recreate under a fresh key —
      // a create it wasn't expecting to need when this loop started.
      const parent: ParentRef | undefined = targetParentKey
        ? {kind: 'container', key: targetParentKey}
        : undefined;

      const writtenKey = await writeWithRetry(
        targetConfig,
        item.targetKey,
        isFirstWrite,
        sourceContent.contentType as string,
        parent,
        rewrittenProperties,
        version?.locale,
        version?.displayName ?? item.name,
      );
      if (writtenKey !== item.targetKey) {
        // Recreated under a fresh key (see writeWithRetry's soft-deleted-key
        // handling) — every remaining locale version in this same loop, the
        // publish call below, and idMap for anything else that references
        // this item's source key must follow it.
        idMap.set(item.sourceKey, writtenKey);
        item.targetKey = writtenKey;
      }
    }

    if (options.status === 'Published') {
      await publishVersion(targetConfig, item.targetKey);
    }

    if (onProgress) onProgress();

    return {
      sourceKey: item.sourceKey,
      targetKey: item.targetKey,
      name: item.name,
      success: true,
      failedDependencyKeys,
    };
  } catch (error) {
    return {
      sourceKey: item.sourceKey,
      targetKey: item.targetKey,
      name: item.name,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      failedDependencyKeys: [],
    };
  }
}

/** Builds the source-key -> target-key map every write's reference-rewriting needs — see rewriteReferences. */
export function buildIdMap(items: PreCheckItem[]): Map<string, string> {
  const idMap = new Map<string, string>();
  for (const item of items) {
    idMap.set(item.sourceKey, item.targetKey);
  }
  return idMap;
}
