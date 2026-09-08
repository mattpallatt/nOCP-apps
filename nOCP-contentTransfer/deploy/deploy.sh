#!/usr/bin/env bash
#
# One-command deploy of nocp-content-transfer to AWS Lambda behind a public
# Function URL — no API Gateway, no CloudFront, no S3. One DynamoDB table
# backs both this app's settings (pk="SETTINGS") and its checkpointed-job
# state (pk="JOB") — a single table with prefixed partition keys, same
# convention nocp-widget's settings+webhooks tables already use, rather
# than provisioning two tables for one small app.
#
# PAY_PER_REQUEST billing (not nocp-widget's PROVISIONED 1/1) — job
# checkpoint writes are bursty (roughly one per 1.5s poll tick while a
# transfer is actively running), not the steady low-rate traffic a
# provisioned table was sized for elsewhere in this project.
#
# Prereqs: AWS CLI v2, authenticated (`aws configure` or `aws configure sso`),
# Node.js/npm, `zip`, `jq`.
#
# Usage:
#   NOCP_FRAME_TOKEN=<secret> ./deploy/deploy.sh [function-name]
#   (or) cp .env.example .env, fill it in, then just: ./deploy/deploy.sh
#
# NOCP_FRAME_TOKEN/NOCP_ADMIN_TOKEN/NOCP_TITLE are BOOTSTRAP values only —
# read once, to seed the table on the function's very first invocation.
# After that, the settings page at https://<function-url>/admin is the
# live source of truth; redeploying with different values here does NOT
# overwrite what's live.
#
# Required env var:
#   NOCP_FRAME_TOKEN   Shared secret the nOCP extension sends as ?token=.
#                       Generate one with: openssl rand -hex 32
#
# Optional env vars:
#   NOCP_ADMIN_TOKEN   Shared secret for /admin (X-NOCP-Admin-Token header).
#                       Generated automatically if unset.
#   NOCP_TITLE         Browser tab title (default: Content Transfer)
#   AWS_REGION         Deploy region (default: us-east-1)
#
# Safe to re-run: updates code/config on an existing function instead of
# failing, and only creates the IAM role, DynamoDB table, and Function URL
# if missing. The DynamoDB access policy is re-applied every run regardless.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$REPO_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$REPO_DIR/.env"
fi

# mktemp/pwd produce POSIX-style paths under Windows Git Bash, but a native
# aws.exe can't resolve those in a file://.../fileb://... URI — cygpath -w
# converts; falls back unchanged wherever cygpath isn't available.
to_file_uri() {
  local prefix="$1" path="$2"
  if command -v cygpath >/dev/null 2>&1; then
    echo "${prefix}$(cygpath -w "$path")"
  else
    echo "${prefix}${path}"
  fi
}

FUNCTION_NAME="${1:-nocp-content-transfer}"
ROLE_NAME="${FUNCTION_NAME}-role"
TABLE_NAME="${FUNCTION_NAME}-data"
REGION="${AWS_REGION:-us-east-1}"

if [[ -z "${NOCP_FRAME_TOKEN:-}" ]]; then
  echo "NOCP_FRAME_TOKEN is required. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

NOCP_ADMIN_TOKEN="${NOCP_ADMIN_TOKEN:-$(openssl rand -hex 32)}"

echo "==> Building"
"$REPO_DIR/build.sh"

echo "==> Ensuring IAM role '$ROLE_NAME' exists"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "    role already exists"
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$(to_file_uri file:// "$SCRIPT_DIR/trust-policy.json")" \
    --output text >/dev/null
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "    created; waiting for IAM propagation..."
  sleep 10
fi

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

echo "==> Ensuring DynamoDB table '$TABLE_NAME' exists"
if aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "    table already exists"
else
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" \
    --output text >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
  aws dynamodb update-time-to-live \
    --table-name "$TABLE_NAME" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" \
    --region "$REGION" \
    --output text >/dev/null
  echo "    created — job-checkpoint rows carry a 24h TTL and expire on their own; settings row has none and stays forever"
fi

TABLE_ARN="$(aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" --query 'Table.TableArn' --output text)"

echo "==> Granting the function's role access to the table"
DYNAMO_POLICY_FILE="$(mktemp)"
ENV_VARS_FILE="$(mktemp)"
trap 'rm -f "$DYNAMO_POLICY_FILE" "$ENV_VARS_FILE"' EXIT

# UpdateItem (not just Put/Get/Query) matters here specifically — jobStore.ts's
# checkpoint lock is a conditional UpdateItem (ConditionExpression on `version`),
# not a plain overwrite.
jq -n --arg arn "$TABLE_ARN" '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Action: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
    Resource: $arn
  }]
}' > "$DYNAMO_POLICY_FILE"

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${FUNCTION_NAME}-dynamodb" \
  --policy-document "$(to_file_uri file:// "$DYNAMO_POLICY_FILE")" \
  --output text >/dev/null

jq -n \
  --arg token "$NOCP_FRAME_TOKEN" \
  --arg admin "$NOCP_ADMIN_TOKEN" \
  --arg title "${NOCP_TITLE:-Content Transfer}" \
  --arg table "$TABLE_NAME" \
  '{Variables: {
    NOCP_FRAME_TOKEN: $token,
    NOCP_ADMIN_TOKEN: $admin,
    NOCP_TITLE: $title,
    NOCP_TABLE: $table
  }}' \
  > "$ENV_VARS_FILE"

if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating existing function code"
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "$(to_file_uri fileb:// "$REPO_DIR/dist/function.zip")" \
    --region "$REGION" \
    --output text >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"

  echo "==> Updating configuration"
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --timeout 28 \
    --memory-size 1024 \
    --environment "$(to_file_uri file:// "$ENV_VARS_FILE")" \
    --region "$REGION" \
    --output text >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
else
  echo "==> Creating function"
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --zip-file "$(to_file_uri fileb:// "$REPO_DIR/dist/function.zip")" \
    --environment "$(to_file_uri file:// "$ENV_VARS_FILE")" \
    --timeout 28 \
    --memory-size 1024 \
    --region "$REGION" \
    --output text >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION_NAME" --region "$REGION"
fi

echo "==> Ensuring public Function URL exists"
if ! aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE \
    --region "$REGION" \
    --output text >/dev/null

  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region "$REGION" \
    --output text >/dev/null
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id FunctionURLInvokeAllowPublicAccess \
    --action lambda:InvokeFunction \
    --principal "*" \
    --invoked-via-function-url \
    --region "$REGION" \
    --output text >/dev/null
fi

URL="$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" --query 'FunctionUrl' --output text)"

echo ""
echo "✅ Deployed: $URL"
echo "   Health check (no gate):     ${URL}healthz"
echo "   Action router (frame-token gated): ${URL}content-transfer/api"
echo "   Settings page (admin):      ${URL}admin"
echo ""
echo "   In the nOCP extension's Options page, set this app's:"
echo "     URL         -> $URL"
echo "     Frame Token -> $NOCP_FRAME_TOKEN"
echo ""
echo "   Admin token (X-NOCP-Admin-Token header): $NOCP_ADMIN_TOKEN"
echo ""
echo "   Next: open ${URL}admin and configure at least Environment 1 —"
echo "   the app won't function until that's saved."
