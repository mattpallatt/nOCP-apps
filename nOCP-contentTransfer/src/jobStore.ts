// The one genuinely new piece of infrastructure in this whole port —
// replaces OCP's Job framework (jobs.trigger() + a platform-managed
// "call perform() repeatedly until complete:true" loop, state round-tripped
// by the platform between calls) with a checkpoint stored in the same
// DynamoDB table settingsStore.ts uses, and one HTTP round trip per
// checkpoint instead of a re-invocation loop nOCP has no equivalent for.
// See the plan's "The one real architectural problem" section for the
// full design rationale — this is that design, implemented.
//
// The core idea: the frontend already polls getPreCheckProgress/
// getTransferProgress every 1.5s (see invokeAction.ts's TransferPanel
// usage), so "do the next unit of work" just rides along on that same
// poll instead of needing its own re-invocation mechanism. startPreCheck/
// startTransfer create the job row and call advanceJobOnce() once inline
// so the UI's first paint already shows checkpoint #1; the two progress
// actions call advanceJobOnce() once before reading progressJson. Same
// function, two call sites.
//
// Concurrency safety: `version` is bumped atomically on lock *acquisition*
// (not just on the final write) via a single conditional UpdateItem that
// checks both the expected version AND that lockedAt is absent/stale in
// one ConditionExpression. Whichever concurrent advanceJobOnce call wins
// that UpdateItem is the exclusive holder until it writes lockedAt back to
// 0 (or STALE_LOCK_MS elapses without that happening, e.g. the Lambda
// invocation was hard-killed mid-checkpoint) — a losing call gets
// ConditionalCheckFailedException and returns the current progress with
// no work attempted, rather than retrying and risking two checkpoints
// racing on the same job. See jobStore.test.mjs (run manually against a
// real table — see its own header) for a script that deliberately forces
// this race and confirms exactly one caller does the work.

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import {STALE_LOCK_MS} from './constants';

const TABLE = process.env.NOCP_TABLE ?? '';
const PARTITION_KEY = 'JOB';
const JOB_TTL_SECONDS = 24 * 60 * 60;

const client = new DynamoDBClient({});

export type JobStatus = 'running' | 'done' | 'error';

interface JobRow {
  version: number;
  status: JobStatus;
  lockedAt: number;
  stateJson: string;
  progressJson: string;
}

export interface CheckpointResult<TState, TProgress> {
  state: TState;
  progress: TProgress;
  done: boolean;
  error?: string;
}

export type CheckpointFn<TState, TProgress> = (state: TState) => Promise<CheckpointResult<TState, TProgress>>;

export interface AdvanceResult<TProgress> {
  status: JobStatus;
  progress: TProgress;
}

async function readRow(jobId: string): Promise<JobRow | null> {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE,
    Key: {pk: {S: PARTITION_KEY}, sk: {S: jobId}},
  }));
  if (!result.Item) return null;
  return {
    version: Number(result.Item.version?.N ?? '0'),
    status: (result.Item.status?.S as JobStatus) ?? 'error',
    lockedAt: Number(result.Item.lockedAt?.N ?? '0'),
    stateJson: result.Item.stateJson?.S ?? '{}',
    progressJson: result.Item.progressJson?.S ?? '{}',
  };
}

/** Creates a new job row with status "running", version 0, no lock held. jobType is stored for operator visibility in the DynamoDB console only — nothing here branches on it, that's entirely preCheckRunner.ts's/transferRunner.ts's own concern via their own checkpointFn. */
export async function createJob<TState, TProgress>(
  jobId: string,
  jobType: 'precheck' | 'transfer',
  initialState: TState,
  initialProgress: TProgress,
): Promise<void> {
  const now = new Date();
  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: {S: PARTITION_KEY},
      sk: {S: jobId},
      jobType: {S: jobType},
      status: {S: 'running'},
      version: {N: '0'},
      lockedAt: {N: '0'},
      stateJson: {S: JSON.stringify(initialState)},
      progressJson: {S: JSON.stringify(initialProgress)},
      createdAt: {S: now.toISOString()},
      updatedAt: {S: now.toISOString()},
      ttl: {N: String(Math.floor(now.getTime() / 1000) + JOB_TTL_SECONDS)},
    },
  }));
}

/**
 * Runs exactly one checkpoint of a job, or returns the current progress
 * with no work attempted if the job is already done/errored, or if another
 * invocation currently holds the lock. Returns null if the job doesn't
 * exist at all (expired via TTL, or a bad jobId).
 */
export async function advanceJobOnce<TState, TProgress>(
  jobId: string,
  checkpointFn: CheckpointFn<TState, TProgress>,
): Promise<AdvanceResult<TProgress> | null> {
  const row = await readRow(jobId);
  if (!row) return null;

  if (row.status !== 'running') {
    return {status: row.status, progress: JSON.parse(row.progressJson) as TProgress};
  }

  const now = Date.now();
  const lockIsFresh = row.lockedAt > 0 && now - row.lockedAt < STALE_LOCK_MS;
  if (lockIsFresh) {
    return {status: 'running', progress: JSON.parse(row.progressJson) as TProgress};
  }

  const nextVersion = row.version + 1;
  try {
    await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: {pk: {S: PARTITION_KEY}, sk: {S: jobId}},
      UpdateExpression: 'SET lockedAt = :now, version = :nextVersion',
      ConditionExpression: 'version = :expectedVersion AND (lockedAt = :zero OR lockedAt < :staleThreshold)',
      ExpressionAttributeValues: {
        ':now': {N: String(now)},
        ':nextVersion': {N: String(nextVersion)},
        ':expectedVersion': {N: String(row.version)},
        ':zero': {N: '0'},
        ':staleThreshold': {N: String(now - STALE_LOCK_MS)},
      },
    }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      // Lost the race to acquire — another invocation's poll got there
      // first. No retry: the next 1.5s poll tick tries again.
      return {status: 'running', progress: JSON.parse(row.progressJson) as TProgress};
    }
    throw error;
  }

  // We now exclusively hold the lock (lockedAt is fresh under our write,
  // and version has moved past what any other reader saw) until we write
  // lockedAt back to 0 below, or STALE_LOCK_MS elapses without that
  // happening.
  const state = JSON.parse(row.stateJson) as TState;
  let result: CheckpointResult<TState, TProgress>;
  try {
    result = await checkpointFn(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: {pk: {S: PARTITION_KEY}, sk: {S: jobId}},
      UpdateExpression: 'SET #status = :status, lockedAt = :zero, updatedAt = :now, progressJson = :progressJson',
      ExpressionAttributeNames: {'#status': 'status'},
      ExpressionAttributeValues: {
        ':status': {S: 'error'},
        ':zero': {N: '0'},
        ':now': {S: new Date().toISOString()},
        ':progressJson': {S: JSON.stringify({...JSON.parse(row.progressJson), error: message})},
      },
    }));
    throw error;
  }

  const status: JobStatus = result.done ? (result.error ? 'error' : 'done') : 'running';
  await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: {pk: {S: PARTITION_KEY}, sk: {S: jobId}},
    UpdateExpression: 'SET stateJson = :stateJson, progressJson = :progressJson, #status = :status, lockedAt = :zero, updatedAt = :now',
    ExpressionAttributeNames: {'#status': 'status'},
    ExpressionAttributeValues: {
      ':stateJson': {S: JSON.stringify(result.state)},
      ':progressJson': {S: JSON.stringify(result.progress)},
      ':status': {S: status},
      ':zero': {N: '0'},
      ':now': {S: new Date().toISOString()},
    },
  }));

  return {status, progress: result.progress};
}
