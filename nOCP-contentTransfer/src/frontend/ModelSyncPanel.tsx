// Port of the source app's src/cms-ui-extensions/content-transfer/
// ModelSyncPanel.tsx — only change is dropping the unused `context`
// prop/param (invokeAction no longer takes an ExtensionContext).
import {Box, Button, Group, Separator, Text} from '@optiaxiom/react';
import {useCallback, useEffect, useState} from 'react';
import {fieldLabelStyle, inputStyle} from './formStyles';
import {describeEnvelopeError, invokeAction} from './invokeAction';
import {MANIFEST_SECTIONS} from './types';
import type {
  ApplyItemResult,
  ApplyManifestResult,
  EnvironmentSummary,
  ListEnvironmentsResult,
  ManifestDiff,
  ManifestSection,
} from './types';

const SECTION_LABELS: Record<ManifestSection, string> = {
  locales: 'Locales',
  contentTypes: 'Content Types',
  propertyGroups: 'Property Groups',
  displayTemplates: 'Display Templates',
};

function sectionCount(diff: ManifestDiff, section: ManifestSection): number {
  const d = diff[section];
  return d.added.length + d.removed.length + d.changed.length;
}

/** True if this item's own error names the data-loss guard specifically — CMA's own wording for this: "...Use the 'ignoreDataLossWarnings' option to apply the changes anyway." Per-item (each item is its own PATCH/POST call), so this only affects the item it's attached to, not the whole batch. */
function isDataLossError(result: ApplyItemResult): boolean {
  return Boolean(result.error?.toLowerCase().includes('ignoredatalosswarnings'));
}

/** Identifies one diff entry across the whole panel's selection state — identity alone isn't unique across sections (e.g. a locale and a content type could share a code/key). */
function entryKey(section: ManifestSection, identity: string): string {
  return `${section}::${identity}`;
}

// Fixed-width slot for a row's checkbox (or, for "only on target" rows which
// have none, an empty spacer of the same width) — guarantees every row's
// identity text lines up regardless of the browser's native checkbox size.
const CHECKBOX_SLOT_STYLE = {display: 'inline-flex', width: 16, flexShrink: 0, justifyContent: 'center'} as const;

export function ModelSyncPanel() {
  const [targets, setTargets] = useState<EnvironmentSummary[]>([]);
  const [targetMatchPattern, setTargetMatchPattern] = useState('');
  const [sections, setSections] = useState<Set<ManifestSection>>(new Set(MANIFEST_SECTIONS as unknown as ManifestSection[]));
  const [ignoreDataLossWarnings, setIgnoreDataLossWarnings] = useState(false);
  const [diff, setDiff] = useState<ManifestDiff | null>(null);
  // Which added/changed entries (keyed by entryKey) are checked to actually
  // be pushed on Apply — defaults to "everything" the moment a diff loads,
  // since unchecking specific entries is the exception, not the norm.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyManifestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Whether the "start a new comparison" form (intro text, target/sections
  // pickers, Preview button) is showing, vs. the diff/apply-result view.
  // Reset is the only way back to this once a diff has been loaded.
  const showSearchForm = diff === null && applyResult === null;

  useEffect(() => {
    void (async () => {
      const envelope = await invokeAction<ListEnvironmentsResult>('listEnvironments', {});
      if (envelope.ok && envelope.result.targets.length > 0) {
        setTargets(envelope.result.targets);
        setTargetMatchPattern(envelope.result.targets[0].matchPattern);
      }
    })();
  }, []);

  const handlePreview = useCallback(async () => {
    if (!targetMatchPattern) return;
    setChecking(true);
    setError(null);
    setApplyResult(null);
    const envelope = await invokeAction<ManifestDiff>('manifestDiff', {
      targetMatchPattern,
      sections: Array.from(sections),
    });
    setChecking(false);
    if (!envelope.ok) {
      setError(describeEnvelopeError(envelope) || 'Could not compare content models.');
      return;
    }
    setDiff(envelope.result);
    const allKeys = new Set<string>();
    for (const section of MANIFEST_SECTIONS as unknown as ManifestSection[]) {
      const d = envelope.result[section];
      for (const entry of d.added) allKeys.add(entryKey(section, entry.identity));
      for (const entry of d.changed) allKeys.add(entryKey(section, entry.identity));
    }
    setSelected(allKeys);
  }, [targetMatchPattern, sections]);

  const handleApply = useCallback(async () => {
    if (!targetMatchPattern || !diff) return;
    setApplying(true);
    setError(null);
    const selection: Partial<Record<ManifestSection, string[]>> = {};
    for (const section of MANIFEST_SECTIONS as unknown as ManifestSection[]) {
      const d = diff[section];
      selection[section] = [...d.added, ...d.changed]
        .map((entry) => entry.identity)
        .filter((identity) => selected.has(entryKey(section, identity)));
    }
    const envelope = await invokeAction<ApplyManifestResult>('manifestPush', {
      targetMatchPattern,
      sections: Array.from(sections),
      ignoreDataLossWarnings,
      selection,
    });
    setApplying(false);
    if (!envelope.ok) {
      setError(describeEnvelopeError(envelope) || 'Could not apply the content model to the target.');
      return;
    }
    setApplyResult(envelope.result);
    setDiff(null);
  }, [targetMatchPattern, sections, ignoreDataLossWarnings, diff, selected]);

  const handleReset = useCallback(() => {
    setDiff(null);
    setApplyResult(null);
    setSelected(new Set());
    setError(null);
  }, []);

  const toggleSection = (section: ManifestSection) => {
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  };

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSectionSelected = (keys: string[]) => {
    setSelected((prev) => {
      const allSelected = keys.length > 0 && keys.every((k) => prev.has(k));
      const next = new Set(prev);
      keys.forEach((k) => (allSelected ? next.delete(k) : next.add(k)));
      return next;
    });
  };

  const totalChanges = diff
    ? (Object.keys(diff) as ManifestSection[]).reduce((sum, s) => sum + sectionCount(diff, s), 0)
    : null;

  return (
    <Box w="full">
      <Group flexDirection="column" gap="12" w="full">
        <Box w="full">
          <label style={fieldLabelStyle}>
            <Text fontSize="xs" fontWeight="600">Destination Environment</Text>
          </label>
          <select
            disabled={!showSearchForm}
            onChange={(e) => setTargetMatchPattern(e.target.value)}
            style={inputStyle}
            value={targetMatchPattern}
          >
            {targets.map((t) => <option key={t.matchPattern} value={t.matchPattern}>{t.name}</option>)}
          </select>
        </Box>

        {showSearchForm && (
          <Box w="full">
            <label style={fieldLabelStyle}>
              <Text fontSize="xs" fontWeight="600">Sections</Text>
            </label>
            <Group flexDirection="column" gap="8">
              {(MANIFEST_SECTIONS as unknown as ManifestSection[]).map((section) => (
                <label key={section} style={{display: 'flex', alignItems: 'center', gap: 6}}>
                  <input
                    checked={sections.has(section)}
                    onChange={() => toggleSection(section)}
                    type="checkbox"
                  />
                  <Text fontSize="sm">{SECTION_LABELS[section]}</Text>
                </label>
              ))}
            </Group>
          </Box>
        )}

        {error && <Text color="fg.error" fontSize="sm">{error}</Text>}

        {showSearchForm && (
          <Group gap="8">
            <Button appearance="primary" disabled={checking || !targetMatchPattern || sections.size === 0} onClick={() => void handlePreview()}>
              {checking ? 'Comparing…' : 'Preview Differences'}
            </Button>
          </Group>
        )}

        {diff && (
          <>
            <Text fontSize="sm">
              {totalChanges === 0 ? 'No differences found.' : `${totalChanges} difference${totalChanges === 1 ? '' : 's'} found.`}
            </Text>
            {(Object.keys(diff) as ManifestSection[]).filter((s) => sections.has(s)).map((section) => {
              const d = diff[section];
              if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) return null;
              const actionableKeys = [...d.added, ...d.changed].map((entry) => entryKey(section, entry.identity));
              const allSelected = actionableKeys.length > 0 && actionableKeys.every((k) => selected.has(k));
              return (
                <Box key={section} w="full">
                  <Group alignItems="center" justifyContent="space-between" style={{marginBottom: 10}} w="full">
                    <Text fontSize="sm" fontWeight="600">{SECTION_LABELS[section]}</Text>
                    {actionableKeys.length > 0 && (
                      <Button appearance="default" onClick={() => toggleSectionSelected(actionableKeys)} size="sm">
                        {allSelected ? 'Select None' : 'Select All'}
                      </Button>
                    )}
                  </Group>
                  {d.added.map((entry) => {
                    const key = entryKey(section, entry.identity);
                    return (
                      <label key={key} style={{display: 'flex', alignItems: 'center', gap: 6}}>
                        <span style={CHECKBOX_SLOT_STYLE}>
                          <input checked={selected.has(key)} onChange={() => toggleSelected(key)} type="checkbox" />
                        </span>
                        <Text color="fg.success" fontSize="xs">+ {entry.identity}</Text>
                      </label>
                    );
                  })}
                  {d.changed.map((entry) => {
                    const key = entryKey(section, entry.identity);
                    return (
                      <label key={key} style={{display: 'flex', alignItems: 'center', gap: 6}}>
                        <span style={CHECKBOX_SLOT_STYLE}>
                          <input checked={selected.has(key)} onChange={() => toggleSelected(key)} type="checkbox" />
                        </span>
                        <Text color="fg.warning" fontSize="xs">~ {entry.identity}</Text>
                      </label>
                    );
                  })}
                  {d.removed.map((entry) => (
                    <Box key={`r-${entry.identity}`} style={{display: 'flex', alignItems: 'center', gap: 6}}>
                      <span style={CHECKBOX_SLOT_STYLE} />
                      <Text color="fg.error" fontSize="xs">− {entry.identity} (only on target)</Text>
                    </Box>
                  ))}
                </Box>
              );
            })}

            {totalChanges !== null && totalChanges > 0 && (
              <>
                <Separator w="full" />
                <label style={{display: 'flex', alignItems: 'center', gap: 6}}>
                  <input
                    checked={ignoreDataLossWarnings}
                    onChange={(e) => setIgnoreDataLossWarnings(e.target.checked)}
                    type="checkbox"
                  />
                  <Text fontSize="sm">Allow changes that may cause data loss</Text>
                </label>
                <Button appearance="primary" disabled={applying || selected.size === 0} onClick={() => void handleApply()}>
                  {applying ? 'Applying…' : `Apply to Target${selected.size > 0 ? ` (${selected.size})` : ''}`}
                </Button>
              </>
            )}
          </>
        )}

        {applyResult && (() => {
          const succeeded = applyResult.results.filter((r) => r.success);
          const failed = applyResult.results.filter((r) => !r.success);
          const anyDataLossRejections = failed.some((r) => isDataLossError(r)) && !ignoreDataLossWarnings;
          return (
            <Box w="full">
              <Text fontSize="sm">
                Applied {succeeded.length}/{applyResult.results.length} item(s) — each was created/updated via its
                own request, so a failure below only affected that one item; everything else listed as succeeded
                really did change on the target.
              </Text>
              {anyDataLossRejections && (
                <Text color="fg.warning" fontSize="sm">
                  One or more failures are breaking-change rejections. Check "Allow changes that may cause data
                  loss" above and try again to apply just those.
                </Text>
              )}
              {failed.length > 0 && (
                <Box style={{maxHeight: 200, overflowY: 'auto'}} w="full">
                  {failed.map((r) => (
                    <Text color="fg.error" fontSize="xs" key={`${r.section}-${r.identity}`}>
                      ✗ [{SECTION_LABELS[r.section]}] {r.identity} ({r.action}): {r.error}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        })()}

        {!showSearchForm && (
          <Button appearance="default" onClick={handleReset}>{applyResult ? 'Sync more models' : 'Reset'}</Button>
        )}
      </Group>
    </Box>
  );
}
