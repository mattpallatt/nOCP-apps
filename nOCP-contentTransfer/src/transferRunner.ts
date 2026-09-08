// Replaces the source app's src/backend/jobs/ContentTransferJob.ts (an OCP
// `Job` subclass) with a jobStore.ts checkpointFn — one top-level plan item
// transferred per checkpoint, calling transferSingleItem exactly as
// ContentTransferJob.ts's own perform() did. Credentials are re-resolved
// from settings on every checkpoint (never carried in job state), same as
// the source app re-read storage.secrets fresh on every prepare() call.
//
// visitedDependencies/containerVisited are fresh per checkpoint, same as
// the source app's Job instances being reconstructed every perform() cycle
// — a dependency shared by two top-level items gets re-transferred once per
// item rather than once per whole job, wasteful but not incorrect, since
// every write in transferEngine.ts is idempotent by design.
import {CmapiCredentials} from './cma';
import {resolveEnvironmentCredentials} from './environments';
import {createJob, advanceJobOnce} from './jobStore';
import {PreCheckItem} from './preCheck';
import {buildIdMap, transferSingleItem, TransferItemResult, TransferOptions} from './transferEngine';

export interface TransferProgress {
  processed: number;
  total: number;
  done: boolean;
  results: TransferItemResult[];
  error?: string;
}

interface TransferJobState {
  sourceMatchPattern: string;
  targetMatchPattern: string;
  items: PreCheckItem[];
  options: TransferOptions;
  cursor: number;
  results: TransferItemResult[];
}

export interface StartTransferParams {
  sourceMatchPattern: string;
  targetMatchPattern: string;
  items: PreCheckItem[];
  options: TransferOptions;
}

function newJobId(): string {
  return crypto.randomUUID();
}

export async function startTransfer(params: StartTransferParams): Promise<{jobId: string}> {
  const jobId = newJobId();
  const state: TransferJobState = {
    sourceMatchPattern: params.sourceMatchPattern,
    targetMatchPattern: params.targetMatchPattern,
    items: params.items,
    options: params.options,
    cursor: 0,
    results: [],
  };
  const initialProgress: TransferProgress = {processed: 0, total: params.items.length, done: params.items.length === 0, results: []};
  await createJob(jobId, 'transfer', state, initialProgress);
  await advanceJobOnce(jobId, checkpoint);
  return {jobId};
}

export async function getTransferProgress(jobId: string): Promise<TransferProgress> {
  const result = await advanceJobOnce(jobId, checkpoint);
  if (!result) {
    return {processed: 0, total: 0, done: true, results: [], error: 'Job not found — it may have expired.'};
  }
  return result.progress;
}

async function checkpoint(state: TransferJobState): Promise<{state: TransferJobState; progress: TransferProgress; done: boolean; error?: string}> {
  if (state.cursor >= state.items.length) {
    const progress: TransferProgress = {processed: state.results.length, total: state.items.length, done: true, results: state.results};
    return {state, progress, done: true};
  }

  let sourceConfig: CmapiCredentials;
  let targetConfig: CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string};
  try {
    sourceConfig = await resolveEnvironmentCredentials(state.sourceMatchPattern);
    targetConfig = await resolveEnvironmentCredentials(state.targetMatchPattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state,
      progress: {processed: state.results.length, total: state.items.length, done: true, results: state.results, error: message},
      done: true,
      error: message,
    };
  }

  const idMap = buildIdMap(state.items);
  const item = state.items[state.cursor];
  const result = await transferSingleItem(
    sourceConfig,
    targetConfig,
    item,
    state.items,
    idMap,
    state.options,
    new Set<string>(),
    new Set<string>(),
  );

  const results = [...state.results, result];
  const nextCursor = state.cursor + 1;
  const done = nextCursor >= state.items.length;

  return {
    state: {...state, cursor: nextCursor, results},
    progress: {processed: results.length, total: state.items.length, done, results},
    done,
  };
}
