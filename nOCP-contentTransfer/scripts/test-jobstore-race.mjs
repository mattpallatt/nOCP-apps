#!/usr/bin/env node
// Standalone concurrency test for jobStore.ts's checkpoint lock — run
// manually against a REAL, already-deployed DynamoDB table (not part of
// build.sh/deploy.sh, since it needs live AWS credentials and writes real
// test rows). This is the verification the plan's build order calls for
// before anything else depends on jobStore.ts: forces two overlapping
// advanceJobOnce-style calls to race for the same job's lock, and confirms
// exactly one of them actually runs the checkpoint work.
//
// This duplicates jobStore.ts's lock-acquisition UpdateItem verbatim
// (rather than importing the compiled module) so it stays a plain, fast
// Node script with no bundler step — see jobStore.ts's own header comment
// for why the algorithm looks like this.
//
// Usage:
//   NOCP_TABLE=nocp-content-transfer-data AWS_REGION=us-east-1 \
//     node scripts/test-jobstore-race.mjs
//
// Exits non-zero (and prints why) if the race wasn't won exactly once.

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';

const TABLE = process.env.NOCP_TABLE;
if (!TABLE) {
  console.error('NOCP_TABLE is required — point this at a real, already-deployed table.');
  process.exit(1);
}

const STALE_LOCK_MS = 60_000;
const client = new DynamoDBClient({});
const jobId = `race-test-${Date.now()}`;

async function seed() {
  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: {S: 'JOB'},
      sk: {S: jobId},
      status: {S: 'running'},
      version: {N: '0'},
      lockedAt: {N: '0'},
      stateJson: {S: '{}'},
      progressJson: {S: '{}'},
      ttl: {N: String(Math.floor(Date.now() / 1000) + 300)},
    },
  }));
}

async function cleanup() {
  await client.send(new DeleteItemCommand({TableName: TABLE, Key: {pk: {S: 'JOB'}, sk: {S: jobId}}}));
}

// Mirrors jobStore.ts's advanceJobOnce lock-acquisition + "did I win" check
// exactly — see that file for the real, production version of this logic.
async function tryAcquire(callerLabel) {
  const row = await client.send(new GetItemCommand({TableName: TABLE, Key: {pk: {S: 'JOB'}, sk: {S: jobId}}}));
  const version = Number(row.Item.version.N);
  const now = Date.now();
  try {
    await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: {pk: {S: 'JOB'}, sk: {S: jobId}},
      UpdateExpression: 'SET lockedAt = :now, version = :nextVersion',
      ConditionExpression: 'version = :expectedVersion AND (lockedAt = :zero OR lockedAt < :staleThreshold)',
      ExpressionAttributeValues: {
        ':now': {N: String(now)},
        ':nextVersion': {N: String(version + 1)},
        ':expectedVersion': {N: String(version)},
        ':zero': {N: '0'},
        ':staleThreshold': {N: String(now - STALE_LOCK_MS)},
      },
    }));
    console.log(`  ${callerLabel}: acquired the lock (version ${version} -> ${version + 1})`);
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      console.log(`  ${callerLabel}: lost the race (ConditionalCheckFailedException) — correct, no double-processing`);
      return false;
    }
    throw error;
  }
}

async function main() {
  console.log(`Seeding job ${jobId} in table ${TABLE}...`);
  await seed();

  console.log('Firing 5 concurrent acquire attempts against the same job row...');
  const results = await Promise.all(
    Array.from({length: 5}, (_, i) => tryAcquire(`caller-${i}`)),
  );

  const winners = results.filter(Boolean).length;
  await cleanup();

  if (winners === 1) {
    console.log(`\n✅ PASS: exactly 1 of 5 concurrent callers acquired the lock.`);
    process.exit(0);
  } else {
    console.error(`\n❌ FAIL: ${winners} of 5 concurrent callers acquired the lock (expected exactly 1).`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Test script failed:', error);
  cleanup().finally(() => process.exit(1));
});
