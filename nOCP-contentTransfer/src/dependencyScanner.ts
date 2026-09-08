// Verbatim port of the source app's src/backend/lib/dependencyScanner.ts —
// no OCP SDK import in the original, only relative import paths changed.
import {CmapiCredentials, ContentTypeSchema, getContent, getContentType, listVersions} from './cma';

// CMS SaaS represents a reference to another content item as a
// `cms://content/{key}` URI. This scanner deliberately does NOT rely on a
// content type's declared property types to decide what's a reference — it
// walks every property value's actual JSON shape instead (see walkValue
// below), which is more robust to unconfirmed/varying type-name strings and
// handles inline "component" properties (embedded block data, not a
// separate content item) for free via plain recursion into their nested
// `properties`.
const CMS_CONTENT_URI_PREFIX = 'cms://content/';
const CMS_CONTENT_URI_PATTERN = /cms:\/\/content\/([A-Za-z0-9-]+)/g;

function keyFromUri(uri: string): string | null {
  if (!uri.startsWith(CMS_CONTENT_URI_PREFIX)) return null;
  const key = uri.slice(CMS_CONTENT_URI_PREFIX.length);
  return key || null;
}

function walkValue(value: unknown, referencedKeys: Set<string>): void {
  if (value == null) return;

  if (typeof value === 'string') {
    const key = keyFromUri(value);
    if (key) referencedKeys.add(key);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, referencedKeys);
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Dynamic "content" property referencing an existing item: {reference: "cms://content/{key}"}.
    if (typeof obj.reference === 'string') {
      const key = keyFromUri(obj.reference);
      if (key) referencedKeys.add(key);
    }

    // Rich text: {html: "<p>...</p>"} — scan the raw HTML for embedded
    // content-reference URIs. Whether SaaS rich text actually embeds these
    // (vs. plain relative/absolute URLs) is unconfirmed — see
    // transferEngine.ts's rich-text rewriting for the URL-based fallback.
    if (typeof obj.html === 'string') {
      for (const match of obj.html.matchAll(CMS_CONTENT_URI_PATTERN)) {
        referencedKeys.add(match[1]);
      }
    }

    // Inline component: {displayName, contentType, properties: {...}} — the
    // block's data is embedded directly, not a separate content item, so
    // this recurses into its nested properties rather than resolving `key`
    // as a dependency itself.
    if (obj.properties && typeof obj.properties === 'object') {
      walkProperties(obj.properties as Record<string, unknown>, referencedKeys);
    }

    // Generic recursion for everything else (notably the `{value: ...}`
    // wrapper every property type uses) — `properties`/`reference`/`html`
    // are skipped here since they were already handled explicitly above.
    for (const [key, nested] of Object.entries(obj)) {
      if (key === 'properties' || key === 'reference' || key === 'html') continue;
      walkValue(nested, referencedKeys);
    }
  }
}

function walkProperties(properties: Record<string, unknown>, referencedKeys: Set<string>): void {
  for (const propValue of Object.values(properties)) {
    walkValue(propValue, referencedKeys);
  }
}

/** Extracts every content-reference key found anywhere in a version's properties (no HTTP calls). */
export function extractReferencedKeys(properties: Record<string, unknown> | undefined): string[] {
  if (!properties) return [];
  const referencedKeys = new Set<string>();
  walkProperties(properties, referencedKeys);
  return Array.from(referencedKeys);
}

export type DependencyNodeType = 'Page' | 'Block' | 'Image' | 'Video' | 'Audio' | 'Document' | 'Unknown';

export interface DependencyNode {
  key: string;
  name: string;
  nodeType: DependencyNodeType;
  children: DependencyNode[];
}

// Confirmed live against a real tenant's full /v1/contenttypes listing (131
// content types): page-like base types are `_page`, `_experience`,
// `_section` (a Section within an Experience), and `_component` (blocks —
// e.g. BlockAccordion, ArticleListElement); asset-ish ones observed are
// `_image`, `_media`, `_video`, `_folder`. `_section` is mapped to Block
// (not Page) here since it's a compositional container within a page
// rather than a standalone transfer root, so this app should recurse into
// it like a block. `_media` covers non-image/video assets (documents,
// audio, etc.) — mapped to the closest existing bucket (Document) rather
// than adding an unconfirmed distinction.
const CONFIRMED_BASE_TYPES: Partial<Record<string, DependencyNodeType>> = {
  _page: 'Page',
  _experience: 'Page',
  _section: 'Block',
  _component: 'Block',
  _image: 'Image',
  _video: 'Video',
  _media: 'Document',
};

/**
 * Classifies a content type's baseType into a DependencyNodeType — checks
 * the confirmed exact values above first, then falls back to a substring
 * guess for anything else (e.g. a custom or as-yet-unobserved base type),
 * which is unconfirmed and should be verified against a live tenant before
 * trusting it for anything beyond the badges this drives in the transfer
 * plan UI.
 */
export function classifyBaseType(baseType: string | undefined): DependencyNodeType {
  if (!baseType) return 'Unknown';
  const confirmed = CONFIRMED_BASE_TYPES[baseType];
  if (confirmed) return confirmed;

  const type = baseType.toLowerCase();
  if (type.includes('page')) return 'Page';
  if (type.includes('image')) return 'Image';
  if (type.includes('video')) return 'Video';
  if (type.includes('audio')) return 'Audio';
  if (type.includes('media') || type.includes('document') || type.includes('file')) return 'Document';
  if (type.includes('component') || type.includes('block')) return 'Block';
  return 'Unknown';
}

export interface DependencyScanContext {
  config: CmapiCredentials;
  visited: Set<string>;
  contentTypeCache: Map<string, ContentTypeSchema | null>;
}

export function createScanContext(config: CmapiCredentials): DependencyScanContext {
  return {config, visited: new Set(), contentTypeCache: new Map()};
}

export interface ClassifiedContent {
  name: string;
  nodeType: DependencyNodeType;
  properties: Record<string, unknown> | undefined;
  status?: string;
  container?: string;
}

/** Fetches a content item + its latest version and classifies its content type's baseType — shared with preCheck.ts's tree-vs-dependency child filtering. */
export async function classifyContentKey(ctx: DependencyScanContext, key: string): Promise<ClassifiedContent | null> {
  const content = await getContent(ctx.config, key);
  if (!content) return null;

  const [latestVersion] = await listVersions(ctx.config, key, 1);
  const name = latestVersion?.displayName ?? content.displayName ?? key;

  let nodeType: DependencyNodeType = 'Unknown';
  const contentType = content.contentType;
  if (typeof contentType === 'string') {
    let schema = ctx.contentTypeCache.get(contentType);
    if (schema === undefined) {
      schema = await getContentType(ctx.config, contentType);
      ctx.contentTypeCache.set(contentType, schema);
    }
    nodeType = classifyBaseType(schema?.baseType);
  }

  return {
    name,
    nodeType,
    properties: latestVersion?.properties,
    status: latestVersion?.status,
    container: content.container,
  };
}

/**
 * Recursively discovers a content item's dependency tree: every property
 * value's referenced content, plus (for Block nodes only) that block's own
 * dependencies in turn — treats Page references as leaf nodes (resolved but
 * not recursed into) and only follows Block/component references
 * transitively. `ctx.visited` is shared across the whole scan (a whole
 * batch's worth of top-level items, not just one) to dedupe and guard
 * against cycles.
 */
export async function scanDependencies(
  ctx: DependencyScanContext,
  properties: Record<string, unknown> | undefined,
): Promise<DependencyNode[]> {
  const referencedKeys = extractReferencedKeys(properties);
  const nodes: DependencyNode[] = [];

  for (const key of referencedKeys) {
    if (ctx.visited.has(key)) continue;
    ctx.visited.add(key);

    const classified = await classifyContentKey(ctx, key);
    if (!classified) continue;

    const children = classified.nodeType === 'Block'
      ? await scanDependencies(ctx, classified.properties)
      : [];

    nodes.push({key, name: classified.name, nodeType: classified.nodeType, children});
  }

  return nodes;
}
