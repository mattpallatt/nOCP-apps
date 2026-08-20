import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

export interface WebhookEvent {
  id: string;
  receivedUtc: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

const TABLE = process.env.NOCP_WEBHOOKS_TABLE ?? "";
const TTL_SECONDS = 7 * 24 * 60 * 60; // auto-expire after a week (DynamoDB TTL)
const PARTITION_KEY = "WEBHOOK";
const RECENT_LIMIT = 20;

const client = new DynamoDBClient({});

export async function putWebhookEvent(evt: WebhookEvent): Promise<void> {
  if (!TABLE) return; // table not configured — degrade to a no-op rather than 500 the caller
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: PARTITION_KEY },
        sk: { S: `${evt.receivedUtc}#${evt.id}` },
        id: { S: evt.id },
        receivedUtc: { S: evt.receivedUtc },
        method: { S: evt.method },
        headers: { S: JSON.stringify(evt.headers) },
        bodyText: evt.bodyText === null ? { NULL: true } : { S: evt.bodyText },
        ttl: { N: String(ttl) },
      },
    }),
  );
}

export async function listRecentWebhookEvents(): Promise<WebhookEvent[]> {
  if (!TABLE) return [];

  const result = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: PARTITION_KEY } },
      ScanIndexForward: false, // newest first (sk is receivedUtc-prefixed)
      Limit: RECENT_LIMIT,
    }),
  );

  return (result.Items ?? []).map((item) => ({
    id: item.id?.S ?? "",
    receivedUtc: item.receivedUtc?.S ?? "",
    method: item.method?.S ?? "",
    headers: item.headers?.S ? JSON.parse(item.headers.S) : {},
    bodyText: item.bodyText?.S ?? null,
  }));
}
