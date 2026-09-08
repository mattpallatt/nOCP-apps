// Action router — ported from CategoryExplorerOCPUI's
// src/backend/functions/GraphProxyFunction.ts. Same {action, params} in /
// {ok, result} | {ok:false, error, message?} out envelope and the same two
// actions (list_categories, list_content); only the transport and error-to-
// HTTP-status mapping moved out to match nocp-frontify's actions.ts/
// lambda.ts split (OCP's App.Function/invokeFunction RPC → a plain
// POST /category-explorer/api route in lambda.ts, handleAction() here
// instead of GraphProxyFunction.perform()'s try/catch).

import {GraphAuthError, GraphRequestError, graphQuery} from './graphClient';

export interface CategoryTerm {
  key: string;
  displayName: string;
  parentKey: string | null;
}

export interface ContentItem {
  key: string;
  displayName: string;
  types: string[];
  url: string | null;
}

export type Envelope<T> =
  | {ok: true; result: T}
  | {ok: false; error: string; message?: string};

function ok<T>(result: T): Envelope<T> {
  return {ok: true, result};
}

function fail(error: string, message?: string): Envelope<never> {
  return message ? {ok: false, error, message} : {ok: false, error};
}

const LIST_CATEGORIES_QUERY = `
  query ListCategories($skip: Int!, $limit: Int!) {
    _TaxonomyTerm(skip: $skip, limit: $limit) {
      items {
        _metadata {
          key
          displayName
          parent
        }
      }
    }
  }
`;

interface ListCategoriesData {
  _TaxonomyTerm: {items: Array<{_metadata: {key: string; displayName: string; parent: string | null}}>};
}

const LIST_CONTENT_QUERY = `
  query ListContent($categoryKey: String!, $skip: Int!, $limit: Int!) {
    _Content(
      where: {_itemMetadata: {categories: {eq: $categoryKey}}}
      skip: $skip
      limit: $limit
    ) {
      items {
        _metadata {
          key
          displayName
          types
          url {
            default
          }
        }
      }
    }
  }
`;

interface ListContentData {
  _Content: {
    items: Array<{
      _metadata: {key: string; displayName: string; types: string[]; url?: {default?: string | null} | null};
    }>;
  };
}

const GRAPH_MAX_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;
// Safety cap on how many _TaxonomyTerm pages we'll walk in one call — well
// beyond any realistic category count, just guards against a runaway loop.
const MAX_CATEGORY_PAGES = 20;
// _itemMetadata.categories / a term's identity on content items is stored as
// this URI, not the bare _TaxonomyTerm._metadata.key.
const TAXONOMY_URI_PREFIX = 'cms://taxonomy/categories/';

// Graph returns one row per locale variant when no locale filter is given —
// collapse those down to one entry per distinct key for display.
function dedupeByKey<T extends {key: string}>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(item.key)) {
      seen.set(item.key, item);
    }
  }
  return [...seen.values()];
}

// Same locale-duplicate problem as dedupeByKey, but a locale variant with no
// route (url: null) is worse than useless here — prefer whichever variant
// actually has a resolvable url over first-seen-wins.
function dedupeContentByKey(items: ContentItem[]): ContentItem[] {
  const seen = new Map<string, ContentItem>();
  for (const item of items) {
    const existing = seen.get(item.key);
    if (!existing || (!existing.url && item.url)) {
      seen.set(item.key, item);
    }
  }
  return [...seen.values()];
}

async function handleListCategories(): Promise<Envelope<CategoryTerm[]>> {
  const categories: CategoryTerm[] = [];
  for (let page = 0; page < MAX_CATEGORY_PAGES; page++) {
    const skip = page * GRAPH_MAX_LIMIT;
    const data = await graphQuery<ListCategoriesData>(LIST_CATEGORIES_QUERY, {skip, limit: GRAPH_MAX_LIMIT});
    const pageItems = data._TaxonomyTerm.items;
    categories.push(
      ...pageItems.map((item) => ({
        key: item._metadata.key,
        displayName: item._metadata.displayName,
        parentKey: item._metadata.parent,
      }))
    );
    if (pageItems.length < GRAPH_MAX_LIMIT) {
      break;
    }
  }
  const deduped = dedupeByKey(categories).sort((a, b) => a.displayName.localeCompare(b.displayName));
  return ok(deduped);
}

async function handleListContent(
  params: Record<string, unknown>,
): Promise<Envelope<{items: ContentItem[]; hasMore: boolean; nextSkip: number}>> {
  const categoryKey = typeof params.categoryKey === 'string' ? params.categoryKey : '';
  if (!categoryKey) return fail('missing_category_key');

  const skip = typeof params.skip === 'number' && params.skip >= 0 ? params.skip : 0;
  const requestedLimit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : DEFAULT_PAGE_SIZE;
  const limit = Math.min(requestedLimit, GRAPH_MAX_LIMIT);
  const categoryUri = `${TAXONOMY_URI_PREFIX}${categoryKey}`;

  const data = await graphQuery<ListContentData>(LIST_CONTENT_QUERY, {categoryKey: categoryUri, skip, limit});
  const rawItems = data._Content.items;
  const items: ContentItem[] = dedupeContentByKey(
    rawItems.map((item) => ({
      key: item._metadata.key,
      displayName: item._metadata.displayName,
      types: item._metadata.types ?? [],
      url: item._metadata.url?.default ?? null,
    }))
  );

  return ok({
    items,
    // hasMore/nextSkip are based on the raw (pre-dedupe) count — that's
    // what Graph's skip/limit pagination is actually counting against.
    hasMore: rawItems.length === limit,
    nextSkip: skip + rawItems.length,
  });
}

export async function handleAction(
  action: string,
  params: Record<string, unknown>,
): Promise<{envelope: Envelope<unknown>; status: number}> {
  try {
    if (action === 'list_categories') {
      const envelope = await handleListCategories();
      return {envelope, status: envelope.ok ? 200 : 400};
    }
    if (action === 'list_content') {
      const envelope = await handleListContent(params);
      return {envelope, status: envelope.ok ? 200 : 400};
    }
    return {envelope: fail('unknown_action', action), status: 400};
  } catch (error) {
    if (error instanceof GraphAuthError) {
      return {envelope: fail('not_configured', error.message), status: 400};
    }
    if (error instanceof GraphRequestError) {
      return {envelope: fail('graph_error', error.message), status: 502};
    }
    console.error('Action failed', action, error);
    return {envelope: fail('unexpected_error', error instanceof Error ? error.message : String(error)), status: 500};
  }
}
