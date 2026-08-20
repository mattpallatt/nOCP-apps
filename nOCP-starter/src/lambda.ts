// The ONLY AWS-specific file in this starter. Everything it does is
// translate AWS Lambda Function URL's event/response shape (API Gateway v2
// payload format) to and from the standard Request/Response objects
// app.ts actually works with — see that file for why. A different host
// needs a different adapter this size, not a rewrite of the app; compare
// src/serve-local.ts (plain Node, no cloud account needed at all).
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { createApp } from "./app";
import { inMemoryWebhookStore } from "./webhookStore";

const handleRequest = createApp(
  {
    frameToken: process.env.NOCP_FRAME_TOKEN ?? "",
    title: process.env.NOCP_TITLE ?? "nOCP",
  },
  inMemoryWebhookStore,
);

function toRequest(event: APIGatewayProxyEventV2): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  // The host in this URL is never used (app.ts only reads path/search
  // params) — Request just requires an absolute URL to construct.
  const url = new URL(event.rawPath + query, "https://lambda.invalid");

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }

  const method = event.requestContext.http.method;
  // Request() throws if a body is present on a GET/HEAD request.
  const hasBody = method !== "GET" && method !== "HEAD" && event.body;
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body!, "base64")
      : event.body
    : undefined;

  return new Request(url, { method, headers, body });
}

async function fromResponse(response: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  return fromResponse(await handleRequest(toRequest(event)));
};
