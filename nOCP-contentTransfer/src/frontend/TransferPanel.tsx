// Port of the source app's src/cms-ui-extensions/content-transfer/
// TransferPanel.tsx. The one file needing genuinely new integration code:
// context.content.get()/.subscribe() (OCP's own "what's open in the CMS
// editor" RPC) has no nOCP equivalent — replaced with
// window.addEventListener('message', ...) for the nOCP content-ID
// postMessage contract (NOCP_APP_SPEC.md §5), the same contract
// nocp-base's own reference widget.ts consumes
// ({source:"nocp-host", type:"content-id", contentGuid, ...}). No origin
// check on the received message, matching that reference implementation.
// Everything else (phase state machine, 1500ms polling, stale-progress-read
// guards) ports verbatim.
import {Box, Button, Group, Separator, Text} from '@optiaxiom/react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {DestinationTree} from './DestinationTree';
import {fieldLabelStyle} from './formStyles';
import {describeEnvelopeError, invokeAction} from './invokeAction';
import {PlanTree} from './PlanTree';
import type {
  EnvironmentSummary,
  GetContentNameResult,
  ListEnvironmentsResult,
  PreCheckProgress,
  PreCheckResult,
  ResolveDefaultParentResult,
  TransferItemResult,
  TransferProgress,
} from './types';

const POLL_INTERVAL_MS = 1500;

// Same localhost/127.0.0.1 convention as the backend's own dev-mode
// detection (see environments.ts's findEnvironmentForHostname) — true only
// when this widget is loaded outside the real CMS SaaS admin (e.g.
// deployed Function URL opened directly). The Source/Content debug lines
// exist to help while testing and have no reason to be visible to a real
// editor in production.
const IS_LOCAL_DEV = typeof window !== 'undefined'
  && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

interface ContentIdMessage {
  source: 'nocp-host';
  type: 'content-id';
  contentGuid: string;
  name: string | null;
  contentLink: string | null;
  contentTypeName: string | null;
}

function isContentIdMessage(data: unknown): data is ContentIdMessage {
  return (
    typeof data === 'object'
    && data !== null
    && (data as Record<string, unknown>).source === 'nocp-host'
    && (data as Record<string, unknown>).type === 'content-id'
  );
}

/** Label for the "Check Transfer Plan" button while a precheck job is running — the tree's full size isn't known until the collect phase finishes, so "collecting" only has a running count, not a fraction. */
function describePreCheckProgress(progress: PreCheckProgress | null): string {
  if (!progress) return 'Checking…';
  if (progress.phase === 'collecting') return `Checking… ${progress.collected} found`;
  return `Checking… ${progress.resolved}/${progress.collected} resolved`;
}

const LOCALE_DISPLAY_NAMES = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], {type: 'language'})
  : null;

/** "Language Name (code)" for a BCP-47 locale like "es-ES" or "zh-Hant" — falls back to the bare code if the browser has no Intl.DisplayNames or the code isn't one it recognizes. */
function describeLocale(code: string): string {
  if (!LOCALE_DISPLAY_NAMES) return code;
  try {
    const name = LOCALE_DISPLAY_NAMES.of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

type Phase = 'form' | 'checking' | 'plan' | 'transferring' | 'done';

export function TransferPanel() {
  const [source, setSource] = useState<EnvironmentSummary | null>(null);
  const [targets, setTargets] = useState<EnvironmentSummary[]>([]);
  // The content currently open in the CMS, delivered via the nOCP content-ID
  // postMessage contract rather than asking the editor to paste a GUID.
  // `undefined` = no message received yet, `null` = a message arrived
  // naming no content.
  const [contentKey, setContentKey] = useState<string | null | undefined>(undefined);
  // The current content item's display name, shown instead of its raw key
  // once resolved — undefined while the lookup is in flight, falls back to
  // the key itself if the lookup fails (still useful, just less friendly).
  const [contentName, setContentName] = useState<string | undefined>(undefined);
  const [targetMatchPattern, setTargetMatchPattern] = useState('');
  // Where preCheck would place the item if the editor never touches the
  // destination tree — refetched whenever the source item or target
  // environment changes. 'unresolvable' mirrors preCheck's own "no matching
  // parent and no fallback root container configured" outcome.
  const [defaultParent, setDefaultParent] = useState<{key: string; name: string; expandPath: string[]} | 'loading' | 'unresolvable'>('loading');
  // The editor's explicit pick from the destination tree, overriding
  // defaultParent — null means "use the automatic one".
  const [destinationOverride, setDestinationOverride] = useState<{key: string; name: string} | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [overwriteMatchingKeys, setOverwriteMatchingKeys] = useState(false);
  const [publishOnTarget, setPublishOnTarget] = useState(true);
  const [selectedLocales, setSelectedLocales] = useState<Set<string>>(new Set());

  const [phase, setPhase] = useState<Phase>('form');
  const [plan, setPlan] = useState<PreCheckResult | null>(null);
  const [preCheckProgress, setPreCheckProgress] = useState<PreCheckProgress | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const preCheckPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void (async () => {
      const envelope = await invokeAction<ListEnvironmentsResult>('listEnvironments', {});
      if (envelope.ok) {
        setSource(envelope.result.source);
        setTargets(envelope.result.targets);
        if (envelope.result.targets.length > 0) setTargetMatchPattern(envelope.result.targets[0].matchPattern);
      } else {
        setError(describeEnvelopeError(envelope));
      }
    })();
  }, []);

  // Tracks the content currently open in the CMS via the nOCP content-ID
  // postMessage contract — a plan/progress from a *previous* page is
  // discarded when a new content-id message names a different item, but
  // only while nothing's actively running: a transfer already confirmed
  // keeps its own result visible even if the editor navigates away
  // mid-transfer, since it continues server-side regardless (see
  // transferRunner.ts).
  useEffect(() => {
    function handleMessage(event: MessageEvent): void {
      if (!isContentIdMessage(event.data)) return;
      const next = event.data.contentGuid || null;
      setContentKey((prev) => {
        if (next !== prev) {
          // A precheck in flight is just a preview computation, not a
          // committed write like a transfer — safe (and more sensible) to
          // cancel it rather than let it land a plan for content the
          // editor already navigated away from.
          if (preCheckPollRef.current) clearInterval(preCheckPollRef.current);
          setPhase((p) => (p === 'transferring' || p === 'done' ? p : 'form'));
          setPlan(null);
          setPreCheckProgress(null);
          setError(null);
          setContentName(undefined);
          setDestinationOverride(null);
        }
        return next;
      });
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Resolves the current content item's display name for the "Content:"
  // line — separate from the effect above since it needs its own
  // in-flight/cancellation tracking against a *value* (contentKey) rather
  // than the raw message-listener callback.
  useEffect(() => {
    if (!contentKey) return;
    let cancelled = false;
    setContentName(undefined);
    void (async () => {
      const envelope = await invokeAction<GetContentNameResult>('getContentName', {rootKey: contentKey});
      if (!cancelled) setContentName(envelope.ok ? envelope.result.name : contentKey);
    })();
    return () => {
      cancelled = true;
    };
  }, [contentKey]);

  // Resolves where the item would automatically land on the chosen target —
  // re-runs whenever the source item or target environment changes, and
  // drops any manual destination-tree pick made for a *different*
  // combination of the two (an override for one target doesn't carry over
  // to another).
  useEffect(() => {
    if (!contentKey || !targetMatchPattern) return;
    let cancelled = false;
    setDefaultParent('loading');
    setDestinationOverride(null);
    void (async () => {
      const envelope = await invokeAction<ResolveDefaultParentResult>('resolveDefaultParent', {
        rootKey: contentKey,
        targetMatchPattern,
      });
      if (cancelled) return;
      if (envelope.ok && envelope.result.targetParentKey && envelope.result.name) {
        setDefaultParent({key: envelope.result.targetParentKey, name: envelope.result.name, expandPath: envelope.result.expandPath});
      } else {
        setDefaultParent('unresolvable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentKey, targetMatchPattern]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (preCheckPollRef.current) clearInterval(preCheckPollRef.current);
  }, []);

  // preCheck runs as a checkpointed job (see preCheckRunner.ts), not a
  // synchronous call — a large "include child pages" tree does enough
  // sequential CMAPI round trips to exceed a single request's time budget.
  // startPreCheck only triggers it and returns a jobId; this polls the same
  // way handleConfirmTransfer polls an actual transfer's progress below.
  const pollPreCheckProgress = useCallback((jobId: string) => {
    preCheckPollRef.current = setInterval(() => {
      void (async () => {
        const envelope = await invokeAction<PreCheckProgress>('getPreCheckProgress', {jobId});
        if (!envelope.ok) return;
        // Same "not found yet" placeholder issue as pollProgress below —
        // getPreCheckProgress reports a zeroed-out 'collecting' state
        // whenever it can't find this job's progress record, which can
        // also happen on an occasional racy re-read after real progress
        // already existed. Ignore a read that looks like that reset.
        setPreCheckProgress((prev) => {
          const looksLikeMissingRecord = envelope.result.phase === 'collecting'
            && envelope.result.collected === 0 && envelope.result.resolved === 0 && !envelope.result.done;
          const hadRealProgress = prev && (prev.collected > 0 || prev.resolved > 0 || prev.phase === 'resolving');
          return looksLikeMissingRecord && hadRealProgress ? prev : envelope.result;
        });
        if (!envelope.result.done) return;

        if (preCheckPollRef.current) clearInterval(preCheckPollRef.current);
        if (envelope.result.error || !envelope.result.result) {
          setError(envelope.result.error || 'Pre-check failed.');
          setPhase('form');
          return;
        }
        setPlan(envelope.result.result);
        setSelectedLocales(new Set(envelope.result.result.availableLocales));
        setPhase('plan');
      })();
    }, POLL_INTERVAL_MS);
  }, []);

  const handleCheckPlan = useCallback(async () => {
    if (!contentKey || !targetMatchPattern) return;
    setPhase('checking');
    setError(null);
    setPreCheckProgress(null);
    const envelope = await invokeAction<{jobId: string}>('startPreCheck', {
      rootKey: contentKey,
      targetMatchPattern,
      includeChildren,
      overwriteMatchingKeys,
      destinationParentKey: destinationOverride?.key,
    });
    if (!envelope.ok) {
      setError(describeEnvelopeError(envelope) || 'Pre-check failed.');
      setPhase('form');
      return;
    }
    pollPreCheckProgress(envelope.result.jobId);
  }, [contentKey, targetMatchPattern, includeChildren, overwriteMatchingKeys, destinationOverride, pollPreCheckProgress]);

  const pollProgress = useCallback((jobId: string) => {
    pollRef.current = setInterval(() => {
      void (async () => {
        const envelope = await invokeAction<TransferProgress>('getTransferProgress', {jobId});
        if (!envelope.ok) return;
        // getTransferProgress reports {total: 0} as a placeholder whenever
        // it can't find this job's progress record yet — normal right at
        // the very start, but an occasional racy re-read of the same "not
        // found yet" state later on made the counter visibly flicker
        // backward (e.g. 0/1 -> 0/0 -> 0/1). A real total never shrinks
        // once known, so ignore any read that would make it do that.
        setProgress((prev) => (prev && prev.total > 0 && envelope.result.total === 0 ? prev : envelope.result));
        if (envelope.result.done) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase('done');
        }
      })();
    }, POLL_INTERVAL_MS);
  }, []);

  const handleConfirmTransfer = useCallback(async () => {
    if (!plan) return;
    setPhase('transferring');
    setError(null);
    const envelope = await invokeAction<{jobId: string}>('startTransfer', {
      targetMatchPattern,
      items: plan.items,
      options: {
        status: publishOnTarget ? 'Published' : 'CheckedOut',
        selectedLocales: plan.availableLocales.length > 0 ? Array.from(selectedLocales) : undefined,
      },
    });
    if (!envelope.ok) {
      setError(describeEnvelopeError(envelope) || 'Could not start the transfer.');
      setPhase('plan');
      return;
    }
    setProgress({processed: 0, total: plan.items.length, done: false, results: []});
    pollProgress(envelope.result.jobId);
  }, [plan, targetMatchPattern, publishOnTarget, selectedLocales, pollProgress]);

  const reset = useCallback(() => {
    setPhase('form');
    setPlan(null);
    setProgress(null);
    setError(null);
  }, []);

  const resultsBySourceKey = new Map<string, TransferItemResult>(
    (progress?.results ?? []).map((r) => [r.sourceKey, r]),
  );

  // The interactive target picker — computed once and placed differently
  // depending on IS_LOCAL_DEV: inline right after the "Target:" debug label
  // locally, or on its own in the main form otherwise (see below). Never
  // both — IS_LOCAL_DEV is fixed for a given deployment.
  const targetSelector = targets.length > 1 ? (
    <Group alignItems="center" gap="6">
      {targets.map((t, i) => {
        const active = t.matchPattern === targetMatchPattern;
        return (
          <Group alignItems="center" gap="6" key={t.matchPattern}>
            {i > 0 && <Text color="fg.secondary" fontSize="sm">/</Text>}
            {active ? (
              <Button appearance="default" size="sm">{t.name}</Button>
            ) : (
              <Text
                color="fg.secondary"
                fontSize="sm"
                onClick={() => phase !== 'checking' && setTargetMatchPattern(t.matchPattern)}
                style={{cursor: phase === 'checking' ? 'default' : 'pointer'}}
              >
                {t.name}
              </Text>
            )}
          </Group>
        );
      })}
    </Group>
  ) : (
    <Text fontSize="sm" fontWeight="600">{targets[0]?.name ?? '—'}</Text>
  );

  return (
    <Box w="full">
      <Group flexDirection="column" gap="12" w="full">
        {source && targets.length === 0 && (
          <Text color="fg.secondary" fontSize="xs">
            No other environments configured yet. Add one in Settings.
          </Text>
        )}

        {source && IS_LOCAL_DEV && (
          <Group flexDirection="column" gap="2" w="full">
            <Text color="fg.secondary" fontSize="xs">
              Source: <strong>{source.name}</strong>
            </Text>
            {targetMatchPattern && (
              <Group alignItems="center" gap="6">
                <Text color="fg.secondary" fontSize="xs">Target:</Text>
                {targetSelector}
              </Group>
            )}
            {contentKey && (
              <Text color="fg.secondary" fontSize="xs">
                Content: <strong>{contentName ?? contentKey}</strong>
              </Text>
            )}
          </Group>
        )}

        {contentKey === undefined && <Text fontSize="sm">Loading…</Text>}

        {contentKey === null && (
          <Text fontSize="sm">Open a content item in the CMS to transfer it.</Text>
        )}

        {contentKey && (phase === 'form' || phase === 'checking') && (
          <>
            <Box w="full">
              {!IS_LOCAL_DEV && (
                <Group alignItems="center" gap="6" style={{marginBottom: 6}}>
                  <Text color="fg.secondary" fontSize="xs">Target:</Text>
                  {targetSelector}
                </Group>
              )}
              {destinationOverride || typeof defaultParent === 'object' ? (
                <Group flexDirection="column" gap="2" style={{marginTop: 10, marginBottom: 6, minWidth: 0}}>
                  <Group alignItems="center" gap="6" style={{minWidth: 0}}>
                    <Text color="fg.secondary" fontSize="xs" style={{flexShrink: 0}}>Place Under:</Text>
                    <Text
                      fontSize="xs"
                      fontWeight="600"
                      style={{minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}
                    >
                      {destinationOverride?.name ?? (typeof defaultParent === 'object' ? defaultParent.name : '')}
                    </Text>
                  </Group>
                  {destinationOverride && (
                    <Text
                      color="fg.link.default"
                      onClick={() => setDestinationOverride(null)}
                      style={{cursor: 'pointer', fontSize: 11}}
                    >
                      Use automatic location
                    </Text>
                  )}
                </Group>
              ) : (
                <Text color="fg.secondary" fontSize="xs" style={{marginTop: 10, marginBottom: 6}}>
                  {defaultParent === 'loading' ? 'Resolving destination…' : 'No matching location found automatically — choose one below.'}
                </Text>
              )}
              <DestinationTree
                autoExpandPath={typeof defaultParent === 'object' ? defaultParent.expandPath : undefined}
                onSelect={(key, name) => setDestinationOverride({key, name})}
                selectedKey={destinationOverride?.key ?? (typeof defaultParent === 'object' ? defaultParent.key : null)}
                targetMatchPattern={targetMatchPattern}
              />
            </Box>

            <Group flexDirection="column" gap="8">
              <label style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <input
                  checked={includeChildren}
                  disabled={phase === 'checking'}
                  onChange={(e) => setIncludeChildren(e.target.checked)}
                  type="checkbox"
                />
                <Text fontSize="sm">Include child pages</Text>
              </label>
              <label style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <input
                  checked={overwriteMatchingKeys}
                  disabled={phase === 'checking'}
                  onChange={(e) => setOverwriteMatchingKeys(e.target.checked)}
                  type="checkbox"
                />
                <Text fontSize="sm">Overwrite matching content</Text>
              </label>
            </Group>

            {error && <Text color="fg.error" fontSize="sm">{error}</Text>}

            <Button
              appearance="primary"
              disabled={phase === 'checking' || !targetMatchPattern}
              onClick={() => void handleCheckPlan()}
            >
              {phase === 'checking' ? describePreCheckProgress(preCheckProgress) : 'Check Transfer Plan'}
            </Button>
          </>
        )}

        {plan && phase === 'plan' && (
          <>
            <Text fontSize="sm">
              {plan.createCount} to create, {plan.overwriteCount} to overwrite, {plan.createNewCount} to create under a new key,
              {' '}{plan.unresolvableCount} cannot be transferred.
            </Text>

            {plan.availableLocales.length > 1 && (
              <>
                <Box w="full">
                  <label style={fieldLabelStyle}>
                    <Text fontSize="xs" fontWeight="600">Languages</Text>
                  </label>
                  <Group flexDirection="column" gap="8">
                    {plan.availableLocales.map((locale) => (
                      <label key={locale} style={{display: 'flex', alignItems: 'center', gap: 6}}>
                        <input
                          checked={selectedLocales.has(locale)}
                          onChange={(e) => {
                            setSelectedLocales((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(locale); else next.delete(locale);
                              return next;
                            });
                          }}
                          type="checkbox"
                        />
                        <Text fontSize="sm">{describeLocale(locale)}</Text>
                      </label>
                    ))}
                  </Group>
                </Box>
                <Separator w="full" />
              </>
            )}

            <PlanTree items={plan.items} />

            <label style={{display: 'flex', alignItems: 'center', gap: 6}}>
              <input
                checked={publishOnTarget}
                onChange={(e) => setPublishOnTarget(e.target.checked)}
                type="checkbox"
              />
              <Text fontSize="sm">Publish on target (unchecked = leave as draft)</Text>
            </label>

            {error && <Text color="fg.error" fontSize="sm">{error}</Text>}

            <Group gap="8">
              <Button appearance="primary" disabled={plan.items.every((i) => i.action === 'unresolvable')} onClick={() => void handleConfirmTransfer()}>
                Confirm &amp; Transfer
              </Button>
              <Button appearance="default" onClick={reset}>Cancel</Button>
            </Group>
          </>
        )}

        {plan && (phase === 'transferring' || phase === 'done') && (
          <>
            <Text fontSize="sm" fontWeight="600">
              {phase === 'transferring'
                ? `Transferring… ${progress?.processed ?? 0}/${progress?.total ?? plan.items.length}`
                : 'Transfer complete.'}
            </Text>
            <PlanTree items={plan.items} resultsBySourceKey={resultsBySourceKey} transferring={phase === 'transferring'} />
            {phase === 'done' && (
              <Button appearance="default" onClick={reset}>Transfer another item</Button>
            )}
          </>
        )}
      </Group>
    </Box>
  );
}
