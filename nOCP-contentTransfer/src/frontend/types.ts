// Verbatim port of the source app's src/cms-ui-extensions/content-transfer/
// types.ts — pure data shapes, no context dependency, nothing to change.
export type Envelope<T> =
  | {ok: true; result: T}
  | {ok: false; error: string; message?: string};

export interface EnvironmentSummary {
  matchPattern: string;
  name: string;
}

export interface ListEnvironmentsResult {
  source: EnvironmentSummary;
  targets: EnvironmentSummary[];
}

export interface GetContentNameResult {
  name: string;
}

export interface ResolveDefaultParentResult {
  targetParentKey: string | null;
  name: string | null;
  isRootFallback: boolean;
  // Root-to-parent sequence of container keys the destination tree should
  // auto-expand to reveal targetParentKey — empty if it's unreachable from
  // the tree's root, or if targetParentKey *is* the root (nothing to expand).
  expandPath: string[];
}

export interface ContainerChild {
  key: string;
  name: string;
}

export interface GetDestinationRootResult {
  key: string;
  name: string;
}

export interface ListContainerChildrenResult {
  containerKey: string;
  items: ContainerChild[];
}

export type DependencyNodeType = 'Page' | 'Block' | 'Image' | 'Video' | 'Audio' | 'Document' | 'Unknown';

export interface DependencyNode {
  key: string;
  name: string;
  nodeType: DependencyNodeType;
  children: DependencyNode[];
}

export type PreCheckAction = 'overwrite' | 'createNew' | 'create' | 'unresolvable';

export interface PreCheckItem {
  sourceKey: string;
  name: string;
  action: PreCheckAction;
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

export interface PreCheckProgress {
  phase: 'collecting' | 'resolving';
  collected: number;
  resolved: number;
  done: boolean;
  result?: PreCheckResult;
  error?: string;
}

export interface TransferOptions {
  status: 'Published' | 'CheckedOut';
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

export interface TransferProgress {
  processed: number;
  total: number;
  done: boolean;
  results: TransferItemResult[];
  error?: string;
}

export const MANIFEST_SECTIONS = ['locales', 'contentTypes', 'propertyGroups', 'displayTemplates'] as const;
export type ManifestSection = typeof MANIFEST_SECTIONS[number];

export interface ManifestDiffEntry {
  identity: string;
  item: Record<string, unknown>;
}

export interface ManifestSectionDiff {
  added: ManifestDiffEntry[];
  removed: ManifestDiffEntry[];
  changed: Array<{identity: string; source: Record<string, unknown>; target: Record<string, unknown>}>;
  unchanged: number;
}

export type ManifestDiff = Record<ManifestSection, ManifestSectionDiff>;

export interface ApplyItemResult {
  section: ManifestSection;
  identity: string;
  action: 'create' | 'update';
  success: boolean;
  error?: string;
}

export interface ApplyManifestResult {
  results: ApplyItemResult[];
}
