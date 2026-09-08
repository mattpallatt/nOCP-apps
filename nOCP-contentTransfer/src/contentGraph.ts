// Verbatim port of the source app's src/backend/lib/contentGraph.ts — no
// OCP SDK import at all in the original, so nothing needed to change here
// beyond the relative import path.
import {DEFAULT_GRAPH_ENDPOINT, GRAPHQL_FIELD_NAME_PATTERN} from './constants';

export class ContentGraphError extends Error {}

export interface ContentGraphCredentials {
  contentGraphKey: string;
  contentGraphSecret: string;
}

interface GraphResponse {
  data?: Record<string, {items?: unknown[]}>;
  errors?: Array<{message?: string}>;
}

async function queryGraph(credentials: ContentGraphCredentials, query: string): Promise<Record<string, {items?: unknown[]}>> {
  const basic = Buffer.from(`${credentials.contentGraphKey}:${credentials.contentGraphSecret}`).toString('base64');
  const response = await fetch(DEFAULT_GRAPH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({query}),
  });

  const body = (await response.json()) as GraphResponse;
  if (!response.ok || body.errors?.length) {
    const detail = body.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
    throw new ContentGraphError(`Content Graph query failed: ${detail}`);
  }
  return body.data ?? {};
}

/** Sanity-check credentials with a trivial introspection query. Throws ContentGraphError on failure. */
export async function validateContentGraphCredentials(credentials: ContentGraphCredentials): Promise<void> {
  await queryGraph(credentials, '{ __schema { queryType { name } } }');
}

/**
 * `locale` is a bare (unquoted) top-level argument in Optimizely Graph
 * queries. Graph's identifier syntax can't contain a hyphen, so a
 * BCP47-style code like `en-US` is converted to `en_US` — the conventional
 * GraphQL-safe substitution.
 */
function toGraphLocaleLiteral(locale: string): string {
  const literal = locale.replace(/-/g, '_');
  if (!GRAPHQL_FIELD_NAME_PATTERN.test(literal)) {
    throw new ContentGraphError(`Locale "${locale}" does not translate to a valid GraphQL identifier`);
  }
  return literal;
}

function graphqlStringLiteral(value: string): string {
  return JSON.stringify(value);
}

interface RawContentKeyItem {
  _metadata?: {key?: string};
}

/**
 * Finds a Published content item on this environment with an exact
 * (case-sensitive) title match, searching the entire content tree — not
 * scoped to any one container — via Graph's generic `_Content` query root.
 * CMAPI itself has no equivalent: only per-container listing
 * (`/v1/content/{key}/items`), no cross-tree search by property value —
 * this is the reason this app carries Graph credentials at all.
 *
 * Used as the fallback-parent matcher in transferEngine.ts's
 * resolveParentOnTarget: when a dependency's real ancestor on source has no
 * equivalent on target under the same key, this looks for an existing page
 * with the same title anywhere on target, rather than assuming it must live
 * directly under some configured root.
 *
 * Whether `_metadata.displayName` supports the `eq` operator in a `where`
 * clause the same way `_metadata.status` does is NOT confirmed live —
 * carried forward from the source app as an open question.
 */
export async function findContentKeyByTitle(
  credentials: ContentGraphCredentials,
  locale: string,
  title: string,
): Promise<string | null> {
  const localeLiteral = toGraphLocaleLiteral(locale);
  const query = `{
    _Content(
      locale: ${localeLiteral}
      where: {_metadata: {status: {eq: "Published"}, displayName: {eq: ${graphqlStringLiteral(title)}}}}
      limit: 1
    ) {
      items {
        _metadata { key }
      }
    }
  }`;

  const data = await queryGraph(credentials, query);
  const items = (data._Content?.items ?? []) as RawContentKeyItem[];
  return items[0]?._metadata?.key ?? null;
}
