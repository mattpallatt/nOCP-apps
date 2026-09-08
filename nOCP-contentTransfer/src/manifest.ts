// Near-verbatim port of the source app's src/backend/lib/manifest.ts —
// only the logger import swapped for the local shim.
import {logger} from './logger';
import {CmapiCredentials, describeProblem, rawRequest} from './cma';

export const MANIFEST_SECTIONS = ['locales', 'contentTypes', 'propertyGroups', 'displayTemplates'] as const;
export type ManifestSection = typeof MANIFEST_SECTIONS[number];

// A manifest section item's shape isn't fully confirmed against a live
// tenant — the export/import docs describe the four sections and a
// `lastModified` timestamp, but not each item's exact field names. `key` is
// assumed as the identity field (matching every other CMA resource this app
// touches — content, content types), with `name` as a fallback for locales,
// which more plausibly identify by locale code than by a `key`. See
// identityOf below — confirm both assumptions against a live tenant.
export type ManifestItem = Record<string, unknown>;

export interface Manifest {
  locales?: ManifestItem[];
  contentTypes?: ManifestItem[];
  propertyGroups?: ManifestItem[];
  displayTemplates?: ManifestItem[];
  lastModified?: string;
}

function sectionCounts(manifest: Manifest): string {
  return MANIFEST_SECTIONS.map((section) => `${section}=${manifest[section]?.length ?? 0}`).join(', ');
}

/** GET /v1/manifest — exports content-model definitions (not content items). Optionally scoped to a subset of sections. */
export async function getManifest(
  config: CmapiCredentials,
  sections?: ManifestSection[],
  includeReadOnly = false,
): Promise<Manifest> {
  const params = new URLSearchParams();
  if (sections) {
    for (const section of sections) params.append('sections', section);
  }
  if (includeReadOnly) params.set('includeReadOnly', 'true');
  const query = params.toString();

  const path = `/v1/manifest${query ? `?${query}` : ''}`;
  const {response, problem} = await rawRequest(config, path);
  logger.warn(`[ContentTransfer:manifest] GET ${path} -> ${response.status}`);
  if (!response.ok) {
    throw new Error(`Failed to export manifest (${response.status}): ${describeProblem(problem, await response.text().catch(() => ''))}`);
  }
  const manifest = (await response.json()) as Manifest;
  logger.warn(`[ContentTransfer:manifest] Exported from this environment: ${sectionCounts(manifest)} (lastModified=${manifest.lastModified ?? 'n/a'})`);
  return manifest;
}

function identityOf(section: ManifestSection, item: ManifestItem): string {
  const candidate = section === 'locales' ? (item.name ?? item.key) : (item.key ?? item.name);
  return typeof candidate === 'string' ? candidate : JSON.stringify(item);
}

export interface ManifestDiffEntry {
  identity: string;
  item: ManifestItem;
}

export interface ManifestSectionDiff {
  added: ManifestDiffEntry[];
  removed: ManifestDiffEntry[];
  changed: Array<{identity: string; source: ManifestItem; target: ManifestItem}>;
  unchanged: number;
}

export type ManifestDiff = Record<ManifestSection, ManifestSectionDiff>;

/** Diffs two manifests section-by-section, keyed by identityOf. Equality is a deep JSON comparison — good enough for a human-readable summary, not a semantic schema diff. */
export function diffManifests(source: Manifest, target: Manifest): ManifestDiff {
  const diff = {} as ManifestDiff;

  for (const section of MANIFEST_SECTIONS) {
    const sourceItems = source[section] ?? [];
    const targetItems = target[section] ?? [];
    const targetByIdentity = new Map(targetItems.map((item) => [identityOf(section, item), item]));
    const sourceIdentities = new Set(sourceItems.map((item) => identityOf(section, item)));

    const added: ManifestDiffEntry[] = [];
    const changed: ManifestSectionDiff['changed'] = [];
    let unchanged = 0;

    for (const item of sourceItems) {
      const identity = identityOf(section, item);
      const targetItem = targetByIdentity.get(identity);
      if (!targetItem) {
        added.push({identity, item});
      } else if (JSON.stringify(item) !== JSON.stringify(targetItem)) {
        changed.push({identity, source: item, target: targetItem});
      } else {
        unchanged++;
      }
    }

    const removed: ManifestDiffEntry[] = targetItems
      .filter((item) => !sourceIdentities.has(identityOf(section, item)))
      .map((item) => ({identity: identityOf(section, item), item}));

    diff[section] = {added, removed, changed, unchanged};
  }

  return diff;
}

// Confirmed live against a real tenant's API reference: each of these four
// sections has its own standalone CRUD resource — List/Create/Get/Patch/
// Delete — independent of the /v1/manifest bulk endpoint. Paths follow the
// convention confirmed elsewhere in the CMAPI (`/v1/contenttypes` etc.):
// lowercase, no separator, pluralized.
const RESOURCE_PATH: Record<ManifestSection, string> = {
  locales: '/v1/locales',
  contentTypes: '/v1/contenttypes',
  propertyGroups: '/v1/propertygroups',
  displayTemplates: '/v1/displaytemplates',
};

// Locales and property groups are the more "primitive" definitions (content
// types plausibly reference property groups and localized properties
// plausibly require the locale to already exist); display templates are
// applied before content types on the same reasoning. Not confirmed against
// a live tenant whether the API actually enforces this ordering — a
// reasonable dependency-direction guess, not a proven requirement.
const APPLY_ORDER: ManifestSection[] = ['locales', 'propertyGroups', 'displayTemplates', 'contentTypes'];

export interface ApplyItemResult {
  section: ManifestSection;
  identity: string;
  action: 'create' | 'update';
  success: boolean;
  error?: string;
}

async function applyOne(
  config: CmapiCredentials,
  section: ManifestSection,
  identity: string,
  action: 'create' | 'update',
  item: ManifestItem,
  ignoreDataLossWarnings: boolean,
): Promise<ApplyItemResult> {
  const basePath = RESOURCE_PATH[section];
  const path = action === 'create' ? basePath : `${basePath}/${encodeURIComponent(identity)}`;

  const {response, problem} = await rawRequest(config, path, {
    method: action === 'create' ? 'POST' : 'PATCH',
    headers: {
      'Content-Type': action === 'create' ? 'application/json' : 'application/merge-patch+json',
      // Confirmed applying to /v1/contenttypes specifically; assumed to
      // apply the same way to the other three resources' PATCH — not yet
      // confirmed for those.
      'cms-ignore-data-loss-warnings': ignoreDataLossWarnings ? 'true' : 'false',
    },
    body: JSON.stringify(item),
  });

  if (response.ok) {
    logger.warn(`[ContentTransfer:manifest] ${action} ${path} -> ${response.status}`);
    return {section, identity, action, success: true};
  }

  const detail = describeProblem(problem, await response.text().catch(() => ''));
  logger.warn(`[ContentTransfer:manifest] ${action} ${path} -> ${response.status}: ${detail}`);
  return {section, identity, action, success: false, error: detail};
}

/**
 * Applies a diff (see diffManifests) item-by-item against each section's own
 * standalone endpoint, instead of one bulk `POST /v1/manifest` — the bulk
 * endpoint's `cms-ignore-data-loss-warnings` flag gates the *entire*
 * request, so a single breaking change anywhere blocked everything else in
 * the same call (confirmed live: a breaking ArticleListElement content-type
 * change blocked an otherwise-clean import). Applying per item means one
 * item's failure no longer affects any other item's outcome, at the cost of
 * one HTTP call per changed/added item instead of one call for the whole
 * batch.
 *
 * `removed` entries (present on target, absent from source) are
 * deliberately left alone — this mirrors the bulk import's own "import"
 * framing (upsert, not full replace) rather than treating an environment's
 * own independently-added definitions as something to delete.
 *
 * `selection`, when provided, restricts which added/changed entries are
 * actually pushed — the UI lets an editor uncheck individual entries
 * instead of applying the whole diff. A section missing from `selection`
 * (or present with an empty array) means nothing in that section was
 * checked, not "no restriction" — `selection` being entirely absent is the
 * only case that means "apply everything," preserving the old all-or-nothing
 * behavior for any caller that doesn't pass it.
 */
export async function applyManifestDiff(
  config: CmapiCredentials,
  diff: ManifestDiff,
  options: {ignoreDataLossWarnings?: boolean; selection?: Partial<Record<ManifestSection, string[]>>} = {},
): Promise<ApplyItemResult[]> {
  const ignoreDataLossWarnings = Boolean(options.ignoreDataLossWarnings);
  const results: ApplyItemResult[] = [];

  for (const section of APPLY_ORDER) {
    const sectionDiff = diff[section];
    const selectedIdentities = options.selection ? (options.selection[section] ?? []) : null;
    const isSelected = (identity: string) => selectedIdentities === null || selectedIdentities.includes(identity);
    for (const entry of sectionDiff.added) {
      if (!isSelected(entry.identity)) continue;
      results.push(await applyOne(config, section, entry.identity, 'create', entry.item, ignoreDataLossWarnings));
    }
    for (const entry of sectionDiff.changed) {
      if (!isSelected(entry.identity)) continue;
      results.push(await applyOne(config, section, entry.identity, 'update', entry.source, ignoreDataLossWarnings));
    }
  }

  logger.warn(`[ContentTransfer:manifest] Apply complete: ${results.filter((r) => r.success).length}/${results.length} succeeded.`);
  return results;
}
