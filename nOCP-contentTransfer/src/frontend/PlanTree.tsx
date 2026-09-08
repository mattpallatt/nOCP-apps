// Verbatim port of the source app's src/cms-ui-extensions/content-transfer/
// PlanTree.tsx — pure presentation, no context dependency, nothing to
// change.
import {Box, Group, Text} from '@optiaxiom/react';
import {useState} from 'react';
import type {DependencyNode, PreCheckItem, TransferItemResult} from './types';

const ACTION_BADGE: Record<PreCheckItem['action'], {label: string; color: string}> = {
  overwrite: {label: '↺ Overwrite', color: '#2563eb'},
  createNew: {label: '⊕ Create (new key)', color: '#7c3aed'},
  create: {label: '+ Create', color: '#16a34a'},
  unresolvable: {label: '✕ Cannot transfer', color: '#dc2626'},
};

const NODE_TYPE_COLOR: Record<DependencyNode['nodeType'], string> = {
  Page: '#2563eb',
  Block: '#7c3aed',
  Image: '#0891b2',
  Video: '#0891b2',
  Audio: '#0891b2',
  Document: '#ca8a04',
  Unknown: '#6b7280',
};

function Badge({label, color}: {label: string; color: string}) {
  return (
    <Text
      fontSize="xs"
      fontWeight="600"
      style={{
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Text>
  );
}

function DependencyRow({node, depth}: {node: DependencyNode; depth: number}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <Box>
      <Group alignItems="center" gap="8" style={{paddingLeft: depth * 16, paddingTop: 4, paddingBottom: 4}}>
        {hasChildren ? (
          <Text
            fontSize="xs"
            onClick={() => setExpanded((e) => !e)}
            style={{cursor: 'pointer', width: 12}}
          >
            {expanded ? '▾' : '▸'}
          </Text>
        ) : (
          <Box style={{width: 12}} />
        )}
        <Badge color={NODE_TYPE_COLOR[node.nodeType]} label={node.nodeType} />
        <Text fontSize="sm">{node.name}</Text>
      </Group>
      {hasChildren && expanded && node.children.map((child) => (
        <DependencyRow depth={depth + 1} key={child.key} node={child} />
      ))}
    </Box>
  );
}

interface PlanItemRowProps {
  item: PreCheckItem;
  result?: TransferItemResult;
  transferring: boolean;
}

function statusGlyph(result: PlanItemRowProps['result'], transferring: boolean): string {
  if (!result) return transferring ? '…' : '○';
  return result.success ? '✓' : '✗';
}

function PlanItemRow({item, result, transferring}: PlanItemRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDependencies = item.dependencies.length > 0;
  const badge = ACTION_BADGE[item.action];

  return (
    <Box style={{borderBottom: '1px solid var(--ax-border-subtle, #eee)', paddingTop: 6, paddingBottom: 6}}>
      <Group alignItems="center" gap="8" style={{minWidth: 0}} title={item.targetParentPath} w="full">
        {hasDependencies ? (
          <Text fontSize="xs" onClick={() => setExpanded((e) => !e)} style={{cursor: 'pointer', width: 12}}>
            {expanded ? '▾' : '▸'}
          </Text>
        ) : (
          <Box style={{width: 12}} />
        )}
        <Text fontSize="sm" style={{width: 16}}>{statusGlyph(result, transferring)}</Text>
        <Badge color={badge.color} label={badge.label} />
        <Text
          fontSize="sm"
          fontWeight="600"
          style={{minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}
        >
          {item.name}
        </Text>
      </Group>
      {item.notes && (
        <Text
          color="fg.warning"
          fontSize="xs"
          style={{paddingLeft: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}
          title={item.notes}
        >
          {item.notes}
        </Text>
      )}
      {result && !result.success && (
        <Text
          color="fg.error"
          fontSize="xs"
          style={{paddingLeft: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}
          title={result.error}
        >
          {result.error}
        </Text>
      )}
      {result && result.failedDependencyKeys.length > 0 && (
        <Text color="fg.warning" fontSize="xs" style={{paddingLeft: 20}}>
          {result.failedDependencyKeys.length} dependenc{result.failedDependencyKeys.length === 1 ? 'y' : 'ies'} failed to transfer.
        </Text>
      )}
      {hasDependencies && expanded && item.dependencies.map((child) => (
        <DependencyRow depth={1} key={child.key} node={child} />
      ))}
    </Box>
  );
}

interface PlanTreeProps {
  items: PreCheckItem[];
  resultsBySourceKey?: Map<string, TransferItemResult>;
  transferring?: boolean;
}

export function PlanTree({items, resultsBySourceKey, transferring = false}: PlanTreeProps) {
  return (
    <Box style={{maxHeight: 320, outline: 'none', overflowY: 'auto'}} w="full">
      {items.map((item) => (
        <PlanItemRow
          item={item}
          key={item.sourceKey}
          result={resultsBySourceKey?.get(item.sourceKey)}
          transferring={transferring}
        />
      ))}
    </Box>
  );
}
