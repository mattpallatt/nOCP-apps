// Ported from CategoryExplorerOCPUI's
// src/cms-ui-extensions/category-explorer/CategoryExplorer.sidebar.tsx.
// Tree/row rendering, dedupe-aware buildCategoryTree, and the copy-to-
// clipboard fallback are all kept verbatim — pure presentation/data logic
// with no OCP dependency. What changed, same shape as nocp-frontify's own
// widget.tsx port:
//   - context.extension.invokeFunction(...) -> fetch('/category-explorer/api', ...)
//     carrying X-Nocp-Frame-Token, same {action, params} in / envelope out
//     shape the original already used.
//   - OCP's register((context) => ...) mount -> createRoot(...).render(...)
//     reading window.__NOCP_CONFIG__ for the frame token (NOCP_APP_SPEC.md).
//   - context.extension.setReady() has no nOCP equivalent and is dropped —
//     there's no host-side "loading" state to signal here.
// This app never needs to know what content item is open in the CMS editor
// (it's a pure category/content browser, not tied to a specific page), so
// unlike nocp-frontify's widget there's no content-id postMessage listener.
//
// The "pin" button on each row is new — not part of the source app at all.
// It asks the ChromeApp host (running in the real CMS page, which this
// sandboxed cross-origin iframe has no DOM access to) to select this
// category in the page's own Categories field, via a postMessage bridge:
// this widget posts {source:'nocp-app', type:'insert-category', path,
// displayName} up to window.parent, and interceptor.js — which already has
// real DOM access to the CMS page — locates the field, types the leaf name
// into its search box, clicks the matching dropdown row, and posts back
// {source:'nocp-host', type:'category-insert-result', ok, message}. `path`
// is the full "Root > Child > ..." breadcrumb (built from this app's own
// flat categories list via buildBreadcrumbPath below) because the CMS
// field's dropdown displays that full path, not just the leaf name — two
// categories can share a leaf name under different parents, and only the
// full path disambiguates which row to click.
//
// Built on @optiaxiom/react — same real Optimizely Axiom design system the
// original widget uses (confirmed via its own AxiomProvider/Box/Button/
// Group/Spinner/Text imports). Follow nocp-frontify's CLAUDE.md "Widget:
// React kept, and Axiom is back" checklist before touching build.sh/
// scripts/build-widget.mjs — the CSS-splitting and font/CSP mechanics
// documented there apply here unchanged.

import {AxiomProvider, Box, Button, Group, Spinner, Text} from '@optiaxiom/react';
import {createRoot} from 'react-dom/client';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

const PAGE_SIZE = 25;
const INDENT_PER_DEPTH_PX = 16;
const COPIED_FEEDBACK_MS = 1500;
const INSERT_FEEDBACK_MS = 2500;
// interceptor.js's own match-and-click loop times out at 3s (see that
// file's CATEGORY_MATCH_TIMEOUT_MS) before it ever posts a response back —
// this needs enough headroom past that for a real failure response to
// still arrive before this widget gives up and reports its own generic
// "no response" instead of the host's actual, more specific error.
const INSERT_ACK_TIMEOUT_MS = 4500;

// Content types don't come back as a clean "Page"/"Block" pair — Graph's
// types array holds the whole ancestor chain (e.g. ["ImageTestPage", "Page"]).
// Match by substring across the whole array so this holds regardless of
// which entry happens to be first.
function getContentTypeIcon(types: string[]): string {
  const haystack = types.join(' ').toLowerCase();
  if (haystack.includes('block')) return '🧩';
  if (haystack.includes('image') || haystack.includes('media')) return '🖼️';
  if (haystack.includes('folder')) return '📁';
  if (haystack.includes('page')) return '📄';
  return '📝';
}

interface CategoryTerm {
  key: string;
  displayName: string;
  parentKey: string | null;
}

interface CategoryNode extends CategoryTerm {
  children: CategoryNode[];
}

interface ContentItem {
  key: string;
  displayName: string;
  types: string[];
  url: string | null;
}

type Envelope<T> =
  | {ok: true; result: T}
  | {ok: false; error: string; message?: string};

function errorMessage(envelope: Envelope<unknown> | undefined, statusCode: number): string {
  if (envelope && !envelope.ok) {
    if (envelope.error === 'not_configured') {
      return 'Optimizely Graph is not configured yet. Add a Graph Single Key in the app settings.';
    }
    return envelope.message ?? envelope.error;
  }
  return `Request failed (HTTP ${statusCode})`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy fallback below
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch {
    return false;
  }
}

// Categories arrive as a flat list with a parentKey reference — reassemble
// into a tree. A parentKey that isn't in the set (filtered/missing) is
// treated as a root rather than silently dropping the node.
function buildCategoryTree(categories: CategoryTerm[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const category of categories) {
    nodes.set(category.key, {...category, children: []});
  }
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const byDisplayName = (a: CategoryNode, b: CategoryNode) => a.displayName.localeCompare(b.displayName);
  const sortTree = (level: CategoryNode[]) => {
    level.sort(byDisplayName);
    level.forEach((node) => sortTree(node.children));
  };
  sortTree(roots);
  return roots;
}

// The CMS's own Categories field dropdown shows this exact "Root > Child"
// breadcrumb shape (confirmed from its live DOM) — built by walking
// parentKey up to the root, not just using this node's own displayName, so
// interceptor.js can disambiguate two categories that happen to share a
// leaf name under different parents. seen guards against a malformed
// cyclic parent chain (shouldn't happen, cheap to not trust it blindly).
function buildBreadcrumbPath(category: CategoryTerm, byKey: Map<string, CategoryTerm>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: CategoryTerm | undefined = category;
  while (current && !seen.has(current.key)) {
    seen.add(current.key);
    parts.unshift(current.displayName);
    current = current.parentKey ? byKey.get(current.parentKey) : undefined;
  }
  return parts.join(' > ');
}

interface CategoryInsertResult {
  source: 'nocp-host';
  type: 'category-insert-result';
  ok: boolean;
  message?: string | null;
}

function isCategoryInsertResult(data: unknown): data is CategoryInsertResult {
  return (
    typeof data === 'object' && data !== null &&
    (data as Record<string, unknown>).source === 'nocp-host' &&
    (data as Record<string, unknown>).type === 'category-insert-result'
  );
}

interface InsertStatus {
  key: string;
  ok: boolean;
  message?: string | null;
}

function CategoryTreeRow({
  node,
  depth,
  collapsedKeys,
  onToggle,
  onBrowse,
  onInsert,
  insertPendingKey,
  insertStatus,
}: {
  node: CategoryNode;
  depth: number;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
  onBrowse: (category: CategoryTerm) => void;
  onInsert: (category: CategoryTerm) => void;
  insertPendingKey: string | null;
  insertStatus: InsertStatus | null;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedKeys.has(node.key);
  const isPending = insertPendingKey === node.key;
  const myStatus = insertStatus && insertStatus.key === node.key ? insertStatus : null;

  return (
    <Group flexDirection="column" gap="2">
      <Group alignItems="center" gap="2" style={{paddingLeft: depth * INDENT_PER_DEPTH_PX}}>
        {hasChildren ? (
          <Button appearance="subtle" square onClick={() => onToggle(node.key)}>
            {isCollapsed ? '▸' : '▾'}
          </Button>
        ) : (
          <Box style={{width: 32, flexShrink: 0}} />
        )}
        <Button appearance="subtle" onClick={() => onBrowse(node)} flex="1" justifyContent="flex-start">
          {node.displayName}
        </Button>
        <Button
          appearance="subtle"
          square
          disabled={isPending}
          onClick={() => onInsert(node)}
          title={myStatus?.message ?? "Add to this page's Categories field"}
        >
          {isPending ? <Spinner size="sm" /> : myStatus ? (myStatus.ok ? '✓' : '⚠️') : '📌'}
        </Button>
      </Group>
      {hasChildren && !isCollapsed && (
        <Group flexDirection="column" gap="2">
          {node.children.map((child) => (
            <CategoryTreeRow
              key={child.key}
              node={child}
              depth={depth + 1}
              collapsedKeys={collapsedKeys}
              onToggle={onToggle}
              onBrowse={onBrowse}
              onInsert={onInsert}
              insertPendingKey={insertPendingKey}
              insertStatus={insertStatus}
            />
          ))}
        </Group>
      )}
    </Group>
  );
}

function ContentRow({
  item,
  copied,
  onCopy,
}: {
  item: ContentItem;
  copied: boolean;
  onCopy: (item: ContentItem) => void;
}) {
  return (
    <Group alignItems="center" gap="8">
      <Text style={{width: 20, flexShrink: 0, textAlign: 'center'}}>{getContentTypeIcon(item.types)}</Text>
      <Text fontSize="sm" flex="1">
        {item.displayName}
      </Text>
      {item.url ? (
        <Button appearance="subtle" square onClick={() => onCopy(item)} title="Copy page URL">
          {copied ? '✓' : '📋'}
        </Button>
      ) : (
        <Text color="fg.secondary" fontSize="xs" title="Not published — no live page yet">
          Draft
        </Text>
      )}
    </Group>
  );
}

interface NocpConfig {
  frameToken: string;
}

async function callAction<T>(frameToken: string, action: string, params: Record<string, unknown>): Promise<Envelope<T>> {
  const res = await fetch('/category-explorer/api', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Nocp-Frame-Token': frameToken},
    body: JSON.stringify({action, params}),
  });
  return (await res.json()) as Envelope<T>;
}

function CategoryExplorer({config}: {config: NocpConfig}) {
  const [categories, setCategories] = useState<CategoryTerm[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  const [selectedCategory, setSelectedCategory] = useState<CategoryTerm | null>(null);
  const [items, setItems] = useState<ContentItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextSkip, setNextSkip] = useState(0);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [insertPendingKey, setInsertPendingKey] = useState<string | null>(null);
  const [insertStatus, setInsertStatus] = useState<InsertStatus | null>(null);
  // No request id in the message contract (v1, one bridge call at a time) —
  // this ref is the single source of truth for "which category is the
  // in-flight request for," so a response (or the timeout fallback below)
  // can't misattribute to a request that's already been superseded by a
  // newer click.
  const pendingInsertKeyRef = useRef<string | null>(null);
  const insertAckTimeoutRef = useRef<number | null>(null);
  const insertFeedbackTimerRef = useRef<number | null>(null);

  const categoryByKey = useMemo(() => new Map((categories ?? []).map((c) => [c.key, c])), [categories]);

  const loadCategories = useCallback(async () => {
    setLoadingCategories(true);
    setCategoriesError(null);
    try {
      const envelope = await callAction<CategoryTerm[]>(config.frameToken, 'list_categories', {});
      if (!envelope.ok) {
        setCategoriesError(errorMessage(envelope, 200));
        setCategories(null);
        return;
      }
      setCategories(envelope.result);
    } catch (err) {
      setCategoriesError(err instanceof Error ? err.message : String(err));
      setCategories(null);
    } finally {
      setLoadingCategories(false);
    }
  }, [config]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const loadContent = useCallback(
    async (category: CategoryTerm, skip: number) => {
      setLoadingContent(true);
      setContentError(null);
      try {
        const envelope = await callAction<{items: ContentItem[]; hasMore: boolean; nextSkip: number}>(
          config.frameToken,
          'list_content',
          {categoryKey: category.key, skip, limit: PAGE_SIZE},
        );
        if (!envelope.ok) {
          setContentError(errorMessage(envelope, 200));
          return;
        }
        setItems((prev) => (skip === 0 ? envelope.result.items : [...prev, ...envelope.result.items]));
        setHasMore(envelope.result.hasMore);
        setNextSkip(envelope.result.nextSkip);
      } catch (err) {
        setContentError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingContent(false);
      }
    },
    [config],
  );

  const openCategory = useCallback(
    (category: CategoryTerm) => {
      setSelectedCategory(category);
      setItems([]);
      setHasMore(false);
      setNextSkip(0);
      void loadContent(category, 0);
    },
    [loadContent],
  );

  const backToCategories = useCallback(() => {
    setSelectedCategory(null);
    setItems([]);
    setContentError(null);
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const categoryTree = useMemo(() => buildCategoryTree(categories ?? []), [categories]);

  const handleCopy = useCallback((item: ContentItem) => {
    if (!item.url) return;
    void copyToClipboard(item.url).then((success) => {
      if (!success) return;
      setCopiedKey(item.key);
      setTimeout(() => setCopiedKey((current) => (current === item.key ? null : current)), COPIED_FEEDBACK_MS);
    });
  }, []);

  // Listens for interceptor.js's reply to an in-flight insert-category
  // request. Only the extension is a plausible sender of this exact
  // shape via window.parent, but this widget is embeddable on any host per
  // the nOCP spec, so a stray same-shaped message from an unrelated parent
  // page is at worst ignored (pendingInsertKeyRef.current is null except
  // during the few seconds a real request is actually in flight).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isCategoryInsertResult(event.data)) return;
      const key = pendingInsertKeyRef.current;
      if (!key) return;
      pendingInsertKeyRef.current = null;
      setInsertPendingKey(null);
      if (insertAckTimeoutRef.current !== null) {
        window.clearTimeout(insertAckTimeoutRef.current);
        insertAckTimeoutRef.current = null;
      }
      if (insertFeedbackTimerRef.current !== null) window.clearTimeout(insertFeedbackTimerRef.current);
      setInsertStatus({key, ok: event.data.ok, message: event.data.message ?? null});
      insertFeedbackTimerRef.current = window.setTimeout(() => {
        insertFeedbackTimerRef.current = null;
        setInsertStatus((prev) => (prev && prev.key === key ? null : prev));
      }, INSERT_FEEDBACK_MS);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => () => {
    if (insertAckTimeoutRef.current !== null) window.clearTimeout(insertAckTimeoutRef.current);
    if (insertFeedbackTimerRef.current !== null) window.clearTimeout(insertFeedbackTimerRef.current);
  }, []);

  const handleInsert = useCallback(
    (category: CategoryTerm) => {
      const path = buildBreadcrumbPath(category, categoryByKey);
      pendingInsertKeyRef.current = category.key;
      setInsertPendingKey(category.key);
      setInsertStatus(null);
      window.parent.postMessage(
        {source: 'nocp-app', type: 'insert-category', path, displayName: category.displayName},
        '*',
      );
      if (insertAckTimeoutRef.current !== null) window.clearTimeout(insertAckTimeoutRef.current);
      insertAckTimeoutRef.current = window.setTimeout(() => {
        insertAckTimeoutRef.current = null;
        // Only fires if no response ever arrived — a real ok/fail response
        // always clears pendingInsertKeyRef.current first (see the message
        // listener above), so this can't stomp a real result that happened
        // to land right at the deadline.
        if (pendingInsertKeyRef.current !== category.key) return;
        pendingInsertKeyRef.current = null;
        setInsertPendingKey(null);
        setInsertStatus({
          key: category.key,
          ok: false,
          message: 'No response from the extension — it may need updating to support this.',
        });
      }, INSERT_ACK_TIMEOUT_MS);
    },
    [categoryByKey],
  );

  return (
    <Box>
      <Group flexDirection="column" gap="12">
        {!selectedCategory && (
          <Group flexDirection="column" gap="8">
            <Group alignItems="center" gap="8">
              {loadingCategories && <Spinner size="sm" />}
              <Text color="fg.secondary" fontSize="sm">
                {loadingCategories ? 'Loading categories…' : `${categories?.length ?? 0} categories`}
              </Text>
            </Group>

            {categoriesError && (
              <Text color="fg.error" fontSize="sm">
                {categoriesError}
              </Text>
            )}

            {categories && categories.length === 0 && !loadingCategories && (
              <Text color="fg.secondary" fontSize="sm">
                No categories found. Create some under CMS Settings &gt; Categories.
              </Text>
            )}

            <Group flexDirection="column" gap="2">
              {categoryTree.map((node) => (
                <CategoryTreeRow
                  key={node.key}
                  node={node}
                  depth={0}
                  collapsedKeys={collapsedKeys}
                  onToggle={toggleCollapsed}
                  onBrowse={openCategory}
                  onInsert={handleInsert}
                  insertPendingKey={insertPendingKey}
                  insertStatus={insertStatus}
                />
              ))}
            </Group>
          </Group>
        )}

        {selectedCategory && (
          <Group flexDirection="column" gap="8">
            <Button appearance="default" onClick={backToCategories} w="full">
              ← Back
            </Button>
            <Text fontSize="md" fontWeight="600">
              {selectedCategory.displayName}
            </Text>

            {contentError && (
              <Text color="fg.error" fontSize="sm">
                {contentError}
              </Text>
            )}

            {items.length === 0 && !loadingContent && !contentError && (
              <Text color="fg.secondary" fontSize="sm">
                No content assigned to this category.
              </Text>
            )}

            <Group flexDirection="column" gap="2">
              {items.map((item) => (
                <ContentRow key={item.key} item={item} copied={copiedKey === item.key} onCopy={handleCopy} />
              ))}
            </Group>

            <Group flexDirection="column" alignItems="stretch" gap="8">
              {loadingContent && <Spinner size="sm" />}
              {hasMore && !loadingContent && (
                <Button appearance="default" onClick={() => void loadContent(selectedCategory, nextSkip)} w="full">
                  Load more
                </Button>
              )}
            </Group>
          </Group>
        )}
      </Group>
    </Box>
  );
}

function renderBlocked(): void {
  const target = document.getElementById('app');
  if (target) target.textContent = 'This app can only be opened from within the CMS sidebar.';
}

// Client-side backstop only — the server already refuses to serve real
// content outside an iframe. See NOCP_APP_SPEC.md §1.
if (window.top === window.self) {
  renderBlocked();
} else {
  const config: NocpConfig = (window as unknown as {__NOCP_CONFIG__?: NocpConfig}).__NOCP_CONFIG__ ?? {frameToken: ''};
  const target = document.getElementById('app');
  if (target) {
    createRoot(target).render(
      <AxiomProvider>
        <CategoryExplorer config={config} />
      </AxiomProvider>,
    );
  }
}
