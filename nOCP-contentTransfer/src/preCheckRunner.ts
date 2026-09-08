// Replaces the source app's src/backend/jobs/PreCheckJob.ts (an OCP `Job`
// subclass) with a jobStore.ts checkpointFn — same collect-then-resolve
// algorithm (collectStep/resolveStep from preCheck.ts, unchanged), same
// time-boxed-per-checkpoint approach ("Include child pages" on a large tree
// does a CMAPI round trip (2-3 calls) per node *and* per candidate child
// just to classify it, all sequential, comfortably exceeding a single
// invocation's time budget), restructured around jobStore.advanceJobOnce
// instead of the platform's prepare()/perform() loop. Credentials are
// re-resolved from settings on every checkpoint (never carried in job
// state), same as the source app re-read storage.secrets fresh on every
// prepare() call.
import {logger} from './logger';
import {CmapiCredentials} from './cma';
import {createScanContext} from './dependencyScanner';
import {resolveEnvironmentCredentials} from './environments';
import {createJob, advanceJobOnce} from './jobStore';
import {PERFORM_TIME_BUDGET_MS} from './constants';
import {
  collectStep,
  resolveStep,
  summarizePreCheck,
  CollectedItem,
  CollectQueueEntry,
  PreCheckItem,
  PreCheckOptions,
  PreCheckResult,
  ResolveAccumulators,
} from './preCheck';

export interface PreCheckProgress {
  phase: 'collecting' | 'resolving';
  collected: number;
  resolved: number;
  done: boolean;
  result?: PreCheckResult;
  error?: string;
}

// Plain-JSON-safe shape of ResolveAccumulators (Map/Set don't survive
// JSON.stringify) — serializeAcc/deserializeAcc below convert between the
// two on every checkpoint, same idea as PreCheckJob.ts's own
// serializeAcc/deserializeAcc, just carried as real array fields on the
// job state object instead of separately-stringified ValueHash entries
// (jobStore.ts already JSON.stringifies the whole state once).
interface SerializedAcc {
  batchTargetKeyByOwnKey: Array<[string, string]>;
  batchForcedNew: string[];
  availableLocales: string[];
}

function serializeAcc(acc: ResolveAccumulators): SerializedAcc {
  return {
    batchTargetKeyByOwnKey: Array.from(acc.batchTargetKeyByOwnKey.entries()),
    batchForcedNew: Array.from(acc.batchForcedNew),
    availableLocales: Array.from(acc.availableLocales),
  };
}

function deserializeAcc(serialized: SerializedAcc): ResolveAccumulators {
  return {
    batchTargetKeyByOwnKey: new Map(serialized.batchTargetKeyByOwnKey),
    batchForcedNew: new Set(serialized.batchForcedNew),
    availableLocales: new Set(serialized.availableLocales),
  };
}

interface PreCheckJobState {
  sourceMatchPattern: string;
  targetMatchPattern: string;
  rootKey: string;
  destinationParentKey?: string;
  options: PreCheckOptions;
  phase: 'collect' | 'resolve';
  queue: CollectQueueEntry[];
  collected: CollectedItem[];
  resolveIndex: number;
  items: PreCheckItem[];
  acc: SerializedAcc;
}

export interface StartPreCheckParams {
  sourceMatchPattern: string;
  targetMatchPattern: string;
  rootKey: string;
  includeChildren: boolean;
  overwriteMatchingKeys: boolean;
  destinationParentKey?: string;
}

function newJobId(): string {
  return crypto.randomUUID();
}

export async function startPreCheck(params: StartPreCheckParams): Promise<{jobId: string}> {
  const jobId = newJobId();
  const options: PreCheckOptions = {
    includeChildren: params.includeChildren,
    overwriteMatchingKeys: params.overwriteMatchingKeys,
  };
  const state: PreCheckJobState = {
    sourceMatchPattern: params.sourceMatchPattern,
    targetMatchPattern: params.targetMatchPattern,
    rootKey: params.rootKey,
    destinationParentKey: params.destinationParentKey,
    options,
    phase: 'collect',
    queue: [{key: params.rootKey, directParentSourceKey: null}],
    collected: [],
    resolveIndex: 0,
    items: [],
    acc: serializeAcc({batchTargetKeyByOwnKey: new Map(), batchForcedNew: new Set(), availableLocales: new Set()}),
  };
  const initialProgress: PreCheckProgress = {phase: 'collecting', collected: 0, resolved: 0, done: false};
  await createJob(jobId, 'precheck', state, initialProgress);
  // Run the first checkpoint inline so the UI's first paint already shows
  // real progress instead of a frozen "0 found" for a full poll round trip.
  await advanceJobOnce(jobId, checkpoint);
  return {jobId};
}

export async function getPreCheckProgress(jobId: string): Promise<PreCheckProgress> {
  const result = await advanceJobOnce(jobId, checkpoint);
  if (!result) {
    return {phase: 'collecting', collected: 0, resolved: 0, done: true, error: 'Job not found — it may have expired.'};
  }
  return result.progress;
}

async function checkpoint(state: PreCheckJobState): Promise<{state: PreCheckJobState; progress: PreCheckProgress; done: boolean; error?: string}> {
  let sourceConfig: CmapiCredentials;
  let targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string};
  try {
    sourceConfig = await resolveEnvironmentCredentials(state.sourceMatchPattern);
    targetConfig = await resolveEnvironmentCredentials(state.targetMatchPattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state,
      progress: {phase: 'collecting', collected: state.collected.length, resolved: state.resolveIndex, done: true, error: message},
      done: true,
      error: message,
    };
  }

  const deadline = Date.now() + PERFORM_TIME_BUDGET_MS;
  let phase = state.phase;
  const queue = [...state.queue];
  const collected = [...state.collected];

  if (phase === 'collect') {
    const scanCtx = createScanContext(sourceConfig);
    while (queue.length > 0 && Date.now() < deadline) {
      const entry = queue.shift()!;
      const {item, children} = await collectStep(scanCtx, sourceConfig, entry, state.options.includeChildren);
      if (item) collected.push(item);
      queue.push(...children);
    }

    if (queue.length === 0) phase = 'resolve';
    const progress: PreCheckProgress = {
      phase: phase === 'resolve' ? 'resolving' : 'collecting',
      collected: collected.length,
      resolved: 0,
      done: false,
    };
    return {
      state: {...state, phase, queue, collected},
      progress,
      done: false,
    };
  }

  // phase === 'resolve'
  let resolveIndex = state.resolveIndex;
  const items = [...state.items];
  const acc = deserializeAcc(state.acc);
  const scanCtx = createScanContext(sourceConfig);

  while (resolveIndex < collected.length && Date.now() < deadline) {
    const resolved = await resolveStep(
      sourceConfig,
      targetConfig,
      scanCtx,
      collected[resolveIndex],
      state.options,
      acc,
      state.destinationParentKey,
    );
    items.push(resolved);
    resolveIndex++;
  }

  const done = resolveIndex >= collected.length;
  const progress: PreCheckProgress = done
    ? {phase: 'resolving', collected: collected.length, resolved: items.length, done: true, result: summarizePreCheck(items, acc.availableLocales)}
    : {phase: 'resolving', collected: collected.length, resolved: items.length, done: false};

  logger.info(`[ContentTransfer:precheck] checkpoint: phase=resolve resolved=${items.length}/${collected.length}`);

  return {
    state: {...state, resolveIndex, items, acc: serializeAcc(acc)},
    progress,
    done,
  };
}
