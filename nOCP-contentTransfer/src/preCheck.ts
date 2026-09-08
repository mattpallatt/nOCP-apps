// Near-verbatim port of the source app's src/backend/lib/preCheck.ts — only
// the logger import swapped for the local shim. preCheckRunner.ts (the
// checkpoint-driven replacement for PreCheckJob.ts) calls collectStep/
// resolveStep exactly as PreCheckJob.ts's own prepare()/perform() did, one
// entry per checkpoint — nothing about the algorithm itself changed.
import {logger} from './logger';
import {CmapiCredentials, contentExists, listChildren, listVersions} from './cma';
import {findContentKeyByTitle} from './contentGraph';
import {classifyContentKey, createScanContext, DependencyNode, DependencyScanContext, scanDependencies} from './dependencyScanner';

export type PreCheckAction = 'overwrite' | 'createNew' | 'create' | 'unresolvable';

export interface PreCheckItem {
  sourceKey: string;
  name: string;
  action: PreCheckAction;
  // Minted only when action === 'createNew' — the key this item will
  // actually be created under on target, since its source key already
  // belongs to something else there. See mintContentKey.
  targetKey: string;
  targetParentKey?: string;
  targetParentPath: string;
  isRootFallback?: boolean;
  notes?: string;
  dependencies: DependencyNode[];
}

export interface PreCheckResult {
  items: PreCheckItem[];
  overwriteCount: number;
  createNewCount: number;
  createCount: number;
  unresolvableCount: number;
  availableLocales: string[];
}

export interface PreCheckOptions {
  includeChildren: boolean;
  overwriteMatchingKeys: boolean;
}

function mintContentKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export interface CollectedItem {
  key: string;
  name: string;
  directParentSourceKey: string | null;
  properties: Record<string, unknown> | undefined;
}

export interface CollectQueueEntry {
  key: string;
  directParentSourceKey: string | null;
}

const MAX_ANCESTOR_DEPTH = 50;

/**
 * Processes exactly one BFS queue entry of the tree walk below: classifies
 * it, and — if includeChildren — fetches and classifies its own children to
 * find which ones belong in the queue next (Page-classified, Published;
 * blocks/media/folders are dependencies, not tree nodes, mirrors excluding
 * unpublished children too). Split out from the loop that used to drive
 * this directly so preCheckRunner.ts can run one entry per checkpoint
 * instead of draining the whole queue in one call — a large "include child
 * pages" tree did enough sequential CMAPI round trips (2-3 per node, times
 * every node *and* every candidate child) to exceed a single invocation's
 * time budget.
 */
export async function collectStep(
  scanCtx: DependencyScanContext,
  config: CmapiCredentials,
  entry: CollectQueueEntry,
  includeChildren: boolean,
): Promise<{item: CollectedItem | null; children: CollectQueueEntry[]}> {
  const classified = await classifyContentKey(scanCtx, entry.key);
  if (!classified) return {item: null, children: []};

  const item: CollectedItem = {
    key: entry.key,
    name: classified.name,
    directParentSourceKey: entry.directParentSourceKey,
    properties: classified.properties,
  };
  if (!includeChildren) return {item, children: []};

  const children: CollectQueueEntry[] = [];
  let pageIndex = 0;
  const pageSize = 100;
  for (;;) {
    const {items, totalCount} = await listChildren(config, entry.key, pageIndex, pageSize);
    if (items.length === 0) break;

    for (const child of items) {
      if (!child.key) continue;
      const childClassified = await classifyContentKey(scanCtx, child.key);
      if (!childClassified) continue;
      if (childClassified.nodeType !== 'Page') continue;
      if ((childClassified.status ?? '').toLowerCase() !== 'published') continue;
      children.push({key: child.key, directParentSourceKey: entry.key});
    }

    const seenSoFar = (pageIndex + 1) * pageSize;
    pageIndex++;
    if (items.length < pageSize || (totalCount !== undefined && seenSoFar >= totalCount)) break;
  }

  return {item, children};
}

/** Breadth-first enumeration of the transfer batch, draining collectStep in one uninterrupted pass — the synchronous preCheck's own use below; preCheckRunner.ts instead runs collectStep across many checkpointed advanceJob calls. */
async function collectItems(
  config: CmapiCredentials,
  rootKey: string,
  includeChildren: boolean,
): Promise<CollectedItem[]> {
  const scanCtx = createScanContext(config);
  const result: CollectedItem[] = [];
  const queue: CollectQueueEntry[] = [{key: rootKey, directParentSourceKey: null}];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const {item, children} = await collectStep(scanCtx, config, entry, includeChildren);
    if (item) result.push(item);
    queue.push(...children);
  }

  return result;
}

/** Walks `container` links upward from a content item, nearest ancestor first, stopping at MAX_ANCESTOR_DEPTH or when a container is missing. */
async function buildAncestorChain(config: CmapiCredentials, key: string): Promise<string[]> {
  const chain: string[] = [];
  const scanCtx = createScanContext(config);
  let current: string | undefined = key;

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (!current) break;
    const classified = await classifyContentKey(scanCtx, current);
    const container: string | undefined = classified?.container;
    if (!container) break;
    chain.push(container);
    current = container;
  }

  return chain;
}

/**
 * Content Graph title+locale search for a source ancestor's equivalent on
 * target — used when the ancestor doesn't exist there under its own key.
 * That happens whenever the ancestor was itself transferred by an *earlier*,
 * separate transfer operation and landed under a different key there (e.g.
 * writeWithRetry's soft-deleted-key recreate, or a same-key collision that
 * forced a 'createNew' action) — this app has no persistent record of that
 * across separate transfers (idMap only lives for one transfer's duration),
 * so a same-key check alone can't find it. Mirrors transferEngine.ts's own
 * findMatchingKeyByTitle, used there for a dependency's *direct* parent
 * during an active transfer; this is the same idea applied at every level
 * while walking up the ancestor chain, since any one of them could be the
 * one that got rekeyed.
 */
async function findAncestorByTitle(
  sourceConfig: CmapiCredentials,
  targetConfig: {contentGraphKey?: string; contentGraphSecret?: string},
  sourceAncestorKey: string,
): Promise<string | null> {
  if (!targetConfig.contentGraphKey || !targetConfig.contentGraphSecret) return null;

  const [sourceVersion] = await listVersions(sourceConfig, sourceAncestorKey, 1);
  const title = sourceVersion?.displayName?.trim();
  const locale = sourceVersion?.locale;
  if (!title || !locale) return null;

  try {
    const match = await findContentKeyByTitle(
      {contentGraphKey: targetConfig.contentGraphKey, contentGraphSecret: targetConfig.contentGraphSecret},
      locale,
      title,
    );
    if (match) {
      logger.warn(`[ContentTransfer] ${sourceAncestorKey} has no match on target under its own key — using ${match} (matched by title "${title}") instead.`);
    }
    return match;
  } catch (error) {
    logger.warn(`[ContentTransfer] Content Graph title search for ${JSON.stringify(title)} failed — continuing up the ancestor chain:`, error);
    return null;
  }
}

/**
 * Root-to-parent sequence of *target*-side container keys the destination
 * tree needs to expand, one level at a time, to reveal `resolvedKey` —
 * walks target-side `container` links upward from resolvedKey itself,
 * independent of how it was resolved (a same-key match or a Content Graph
 * title match — see findAncestorByTitle above). That independence matters:
 * a title-matched key can be a completely different GUID than anything in
 * the *source* ancestor chain that led to it, so reusing that source chain
 * here would silently produce no expand path at all for exactly the cases
 * title-matching exists to handle. Empty when resolvedKey isn't reachable
 * from the configured root (or *is* the root — nothing to expand).
 */
async function buildExpandPath(
  targetConfig: CmapiCredentials & {rootContainer?: string},
  resolvedKey: string,
): Promise<string[]> {
  if (!targetConfig.rootContainer || resolvedKey === targetConfig.rootContainer) return [];
  const targetAncestors = await buildAncestorChain(targetConfig, resolvedKey);
  const rootIndex = targetAncestors.indexOf(targetConfig.rootContainer);
  if (rootIndex === -1) return [];
  return [resolvedKey, ...targetAncestors.slice(0, rootIndex + 1)].reverse();
}

export interface AncestorParentResolution {
  targetParentKey?: string;
  targetParentPath: string;
  isRootFallback: boolean;
  unresolvable: boolean;
  notes?: string;
  expandPath: string[];
}

/**
 * The "no explicit destination chosen" resolution for a single content item:
 * walk source-side ancestors nearest-first, using the first one that also
 * exists on target (same key, by this app's create-under-same-key design) —
 * else the environment's configured Fallback Root Container — else give up.
 * Factored out of preCheck's main loop so the sidebar's destination-tree
 * preview (see actions.ts's resolveDefaultParent action) can show an editor
 * the same answer preCheck would land on, before they've committed to
 * anything, using the exact same logic rather than a re-guessed copy of it.
 */
export async function resolveAncestorTargetParent(
  sourceConfig: CmapiCredentials,
  targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string},
  sourceKey: string,
): Promise<AncestorParentResolution> {
  const ancestorChain = await buildAncestorChain(sourceConfig, sourceKey);
  for (const ancestorKey of ancestorChain) {
    if (await contentExists(targetConfig, ancestorKey)) {
      return {
        targetParentKey: ancestorKey,
        targetParentPath: ancestorKey,
        isRootFallback: false,
        unresolvable: false,
        expandPath: await buildExpandPath(targetConfig, ancestorKey),
      };
    }
    const titleMatch = await findAncestorByTitle(sourceConfig, targetConfig, ancestorKey);
    if (titleMatch) {
      return {
        targetParentKey: titleMatch,
        targetParentPath: titleMatch,
        isRootFallback: false,
        unresolvable: false,
        expandPath: await buildExpandPath(targetConfig, titleMatch),
      };
    }
  }
  if (targetConfig.rootContainer) {
    return {
      targetParentKey: targetConfig.rootContainer,
      targetParentPath: targetConfig.rootContainer,
      isRootFallback: true,
      unresolvable: false,
      notes: 'No matching parent found on target — will be created under the configured fallback root container.',
      expandPath: [],
    };
  }
  return {
    targetParentPath: '',
    isRootFallback: false,
    unresolvable: true,
    notes: 'No matching parent found on target, and no fallback root container is configured for this environment.',
    expandPath: [],
  };
}

/**
 * Cross-item state the resolve phase accumulates as it goes — which batch
 * siblings have been assigned a target key so far (and which of those were
 * forced onto a new one, e.g. a 'createNew' key collision), and every
 * distinct locale seen across the batch's versions. Threaded through
 * resolveStep by reference (mutated in place) rather than returned, since
 * later items' resolution depends on earlier ones' results within the same
 * run — exactly the kind of state preCheckRunner.ts has to serialize
 * between checkpointed advanceJob calls (see serializeAcc/deserializeAcc).
 */
export interface ResolveAccumulators {
  batchTargetKeyByOwnKey: Map<string, string>;
  batchForcedNew: Set<string>;
  availableLocales: Set<string>;
}

export function createResolveAccumulators(): ResolveAccumulators {
  return {batchTargetKeyByOwnKey: new Map(), batchForcedNew: new Set(), availableLocales: new Set()};
}

/**
 * Resolves one collected item into its PreCheckItem — the create/overwrite/
 * create-new-key/unresolvable decision plus its target parent, adapted for
 * CMS SaaS's key-based identity: "exists on target" is just
 * `GET /v1/content/{key}`, and this app deliberately creates fresh target
 * content under the *same* key as source, rather than needing to reconcile
 * a separate environment-local integer ID. Split out from preCheck's main
 * loop so preCheckRunner.ts can run one item per checkpoint.
 */
export async function resolveStep(
  sourceConfig: CmapiCredentials,
  targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string},
  scanCtx: DependencyScanContext,
  collectedItem: CollectedItem,
  options: PreCheckOptions,
  acc: ResolveAccumulators,
  // Explicit destination the editor chose in the sidebar's destination
  // tree, overriding the automatic ancestor-walk resolution below — only
  // ever applied to the batch's own root item (directParentSourceKey ===
  // null); any included child pages still nest under wherever the root
  // item itself lands, same as always.
  destinationParentKeyOverride?: string,
): Promise<PreCheckItem> {
  const versions = await listVersions(sourceConfig, collectedItem.key, 20);
  for (const version of versions) {
    if (typeof version.locale === 'string' && version.locale) acc.availableLocales.add(version.locale);
  }

  const dependencies = await scanDependencies(scanCtx, collectedItem.properties);

  const parentForcedNew = collectedItem.directParentSourceKey !== null
    && acc.batchForcedNew.has(collectedItem.directParentSourceKey);

  const existsOnTarget = !parentForcedNew && await contentExists(targetConfig, collectedItem.key);

  let action: PreCheckAction;
  let targetKey: string;
  if (existsOnTarget && options.overwriteMatchingKeys) {
    action = 'overwrite';
    targetKey = collectedItem.key;
  } else if (existsOnTarget) {
    action = 'createNew';
    targetKey = mintContentKey();
  } else {
    action = 'create';
    targetKey = collectedItem.key;
  }

  let targetParentKey: string | undefined;
  let targetParentPath = '';
  let isRootFallback = false;
  let notes: string | undefined;

  if (action === 'overwrite') {
    targetParentPath = 'In place';
  } else if (collectedItem.directParentSourceKey === null && destinationParentKeyOverride) {
    targetParentKey = destinationParentKeyOverride;
    targetParentPath = destinationParentKeyOverride;
  } else if (collectedItem.directParentSourceKey && acc.batchTargetKeyByOwnKey.has(collectedItem.directParentSourceKey)) {
    // Prefer another item in this same batch if its direct parent is
    // being transferred alongside it — bypasses a target lookup entirely.
    targetParentKey = acc.batchTargetKeyByOwnKey.get(collectedItem.directParentSourceKey);
    targetParentPath = targetParentKey ?? '';
  } else {
    const resolution = await resolveAncestorTargetParent(sourceConfig, targetConfig, collectedItem.key);
    targetParentKey = resolution.targetParentKey;
    targetParentPath = resolution.targetParentPath;
    isRootFallback = resolution.isRootFallback;
    notes = resolution.notes;
    if (resolution.unresolvable) action = 'unresolvable';
  }

  acc.batchTargetKeyByOwnKey.set(collectedItem.key, targetKey);
  if (action !== 'overwrite') acc.batchForcedNew.add(collectedItem.key);

  return {
    sourceKey: collectedItem.key,
    name: collectedItem.name,
    action,
    targetKey,
    targetParentKey,
    targetParentPath,
    isRootFallback,
    notes,
    dependencies,
  };
}

/** Aggregates resolved items into the final PreCheckResult — shared by the synchronous preCheck below and preCheckRunner.ts's own checkpointed run, so the counts/locale list are computed identically either way. */
export function summarizePreCheck(items: PreCheckItem[], availableLocales: Set<string>): PreCheckResult {
  return {
    items,
    overwriteCount: items.filter((i) => i.action === 'overwrite').length,
    createNewCount: items.filter((i) => i.action === 'createNew').length,
    createCount: items.filter((i) => i.action === 'create').length,
    unresolvableCount: items.filter((i) => i.action === 'unresolvable').length,
    availableLocales: Array.from(availableLocales),
  };
}

/**
 * Builds a transfer plan for a root content item (and optionally its
 * published page descendants) in one uninterrupted pass — draining
 * collectItems then resolveStep per collected item. Kept as a plain,
 * synchronous reference implementation of the algorithm; preCheckRunner.ts
 * runs the same collectStep/resolveStep primitives across many checkpointed
 * advanceJob calls instead, since a large "include child pages" tree can
 * take longer than a single invocation's time budget. Not currently called
 * from actions.ts (kept for parity with the source app and as a reference
 * implementation to diff preCheckRunner.ts's checkpoint math against).
 */
export async function preCheck(
  sourceConfig: CmapiCredentials,
  targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string},
  rootKey: string,
  options: PreCheckOptions,
  destinationParentKeyOverride?: string,
): Promise<PreCheckResult> {
  const collected = await collectItems(sourceConfig, rootKey, options.includeChildren);

  const scanCtx = createScanContext(sourceConfig);
  const acc = createResolveAccumulators();
  const items: PreCheckItem[] = [];
  for (const collectedItem of collected) {
    items.push(await resolveStep(sourceConfig, targetConfig, scanCtx, collectedItem, options, acc, destinationParentKeyOverride));
  }

  return summarizePreCheck(items, acc.availableLocales);
}
