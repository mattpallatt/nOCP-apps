// Port of the source app's src/cms-ui-extensions/content-transfer/
// DestinationTree.tsx — only change is dropping the unused `context`
// prop/param (invokeAction no longer takes an ExtensionContext; the frame
// token it needs is set once at widget bootstrap — see invokeAction.ts).
import {Box, Group, Text} from '@optiaxiom/react';
import {useEffect, useState} from 'react';
import {describeEnvelopeError, invokeAction} from './invokeAction';
import type {ContainerChild, GetDestinationRootResult, ListContainerChildrenResult} from './types';

interface NodeProps {
  targetMatchPattern: string;
  node: ContainerChild;
  depth: number;
  selectedKey: string | null;
  onSelect: (key: string, name: string) => void;
  // Root-to-parent sequence of keys still to auto-expand, starting with
  // this node's own key — undefined/mismatched means "don't auto-expand
  // this node," not "collapse it" (a user's own click always wins).
  autoExpandPath?: string[];
}

/**
 * One row of the destination tree — fetches its own children lazily, on
 * first expand, rather than the whole tree up front (a target environment's
 * content tree has no known size ahead of time). Whether a row can expand
 * at all is only knowable once tried: CMAPI's children-listing endpoint
 * doesn't report a child count, so every row is optimistically shown as
 * expandable until an empty result proves otherwise.
 */
function TreeNode({targetMatchPattern, node, depth, selectedKey, onSelect, autoExpandPath}: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ContainerChild[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChildren = async (): Promise<ContainerChild[]> => {
    setLoading(true);
    const envelope = await invokeAction<ListContainerChildrenResult>('listContainerChildren', {
      targetMatchPattern,
      containerKey: node.key,
    });
    setLoading(false);
    const items = envelope.ok ? envelope.result.items : [];
    setChildren(items);
    return items;
  };

  const toggle = async () => {
    if (!expanded && children === null) await loadChildren();
    setExpanded((e) => !e);
  };

  // Auto-expands along the resolved-default-parent path as soon as it's
  // known — e.g. a fresh resolveDefaultParent result after switching target
  // environments. Only when there's a level below this one to reveal;
  // autoExpandPath.length === 1 means this node itself is the answer, and
  // it's already visible (and highlighted via selectedKey) with no
  // expansion needed.
  useEffect(() => {
    if (autoExpandPath && autoExpandPath[0] === node.key && autoExpandPath.length > 1 && children === null) {
      void loadChildren().then(() => setExpanded(true));
    }
    // Deliberately keyed on autoExpandPath alone — re-running this when
    // loadChildren/children change too would refetch on every expand.
  }, [autoExpandPath]);

  const isSelected = selectedKey === node.key;
  // Once a fetch has come back empty, this row is a confirmed leaf — no
  // point offering to expand it again.
  const canExpand = children === null || children.length > 0;

  return (
    <Box>
      <Group
        alignItems="center"
        gap="6"
        style={{
          paddingLeft: depth * 16,
          paddingTop: 3,
          paddingBottom: 3,
          borderRadius: 4,
          backgroundColor: isSelected ? 'var(--ax-bg-selected, #e0edff)' : undefined,
        }}
      >
        {canExpand ? (
          <Text fontSize="xs" onClick={() => void toggle()} style={{cursor: 'pointer', width: 12}}>
            {loading ? '…' : expanded ? '▾' : '▸'}
          </Text>
        ) : (
          <Box style={{width: 12}} />
        )}
        <Text
          fontSize="sm"
          fontWeight={isSelected ? '600' : undefined}
          onClick={() => onSelect(node.key, node.name)}
          style={{cursor: 'pointer', flex: 1}}
        >
          {node.name}
        </Text>
      </Group>
      {expanded && children && children.map((child) => (
        <TreeNode
          autoExpandPath={autoExpandPath && autoExpandPath[1] === child.key ? autoExpandPath.slice(1) : undefined}
          depth={depth + 1}
          key={child.key}
          node={child}
          onSelect={onSelect}
          selectedKey={selectedKey}
          targetMatchPattern={targetMatchPattern}
        />
      ))}
    </Box>
  );
}

interface Props {
  targetMatchPattern: string;
  selectedKey: string | null;
  onSelect: (key: string, name: string) => void;
  // See NodeProps — the first element must be the tree's own root key for
  // any expansion to happen.
  autoExpandPath?: string[];
}

/** Browsable tree of a target environment's content, rooted at that environment's configured Root Container Key itself (selectable, so content can be moved to the root) — lets an editor pick a different destination than preCheck's own automatic ancestor-walk would land on. */
export function DestinationTree({targetMatchPattern, selectedKey, onSelect, autoExpandPath}: Props) {
  const [root, setRoot] = useState<ContainerChild | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoot(undefined);
    setError(null);
    void (async () => {
      const envelope = await invokeAction<GetDestinationRootResult>('getDestinationRoot', {targetMatchPattern});
      if (cancelled) return;
      if (!envelope.ok) {
        setError(describeEnvelopeError(envelope) || 'Could not load this environment’s content tree.');
        setRoot(null);
        return;
      }
      setRoot(envelope.result);
    })();
    return () => {
      cancelled = true;
    };
  }, [targetMatchPattern]);

  if (error) return <Text color="fg.error" fontSize="xs">{error}</Text>;
  if (root === undefined) return <Text color="fg.secondary" fontSize="xs">Loading content tree…</Text>;
  if (root === null) return null;

  return (
    // maxHeight is viewport-relative (100vh is this extension's own iframe
    // viewport, not the host CMS page) rather than a flat number: a small
    // tree still shrinks to fit its content as before — this only ever
    // caps height, never stretches to fill it — while a large expanded
    // tree can grow to use most of the sidebar's visible height instead of
    // being stuck scrolling inside a tiny fixed box. The 360px subtracted
    // is an estimate of the surrounding chrome (tabs, source/content
    // lines, environment picker, description text, the checkboxes and
    // button below); nudge it if the tree still looks cramped or runs the
    // panel off-screen once seen live.
    <Box style={{maxHeight: 'clamp(160px, calc(100vh - 360px), 640px)', overflowY: 'auto', border: '1px solid var(--ax-border-subtle, #eee)', borderRadius: 4, padding: 4}} w="full">
      <TreeNode
        autoExpandPath={autoExpandPath && autoExpandPath[0] === root.key ? autoExpandPath : undefined}
        depth={0}
        node={root}
        onSelect={onSelect}
        selectedKey={selectedKey}
        targetMatchPattern={targetMatchPattern}
      />
    </Box>
  );
}
