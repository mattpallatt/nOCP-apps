#!/usr/bin/env bash
#
# One-command deploy of nOCP-categoryExplorer to AWS Lambda behind a public
# Function URL — same "one Lambda, no API Gateway/CloudFront/S3" shape as
# every other app in this family. Settings (title, frame/admin tokens,
# Optimizely Graph Single Key) persist in a single SSM SecureString
# parameter — free (no per-secret cost, unlike Secrets Manager), encrypted
# under the default AWS-managed key, live-editable via /admin without a
# redeploy.
#
# Prereqs: AWS CLI v2, authenticated (`aws configure` or `aws configure sso`),
# Node.js/npm, `zip`, `jq`.
#
# Usage:
#   NOCP_FRAME_TOKEN=<secret> ./deploy/deploy.sh [function-name]
#   (or) cp .env.example .env, fill it in, then just: ./deploy/deploy.sh
#
# NOCP_FRAME_TOKEN/NOCP_ADMIN_TOKEN/NOCP_TITLE are BOOTSTRAP values only —
# read once, to seed the SSM parameter on the function's very first
# invocation. After that, the settings page at https://<function-url>/admin
# is the live source of truth for all three; redeploying with different
# values here does NOT overwrite what's live. This only matters again for a
# genuine disaster-recovery redeploy (the SSM parameter itself was deleted).
#
# Required env var:
#   NOCP_FRAME_TOKEN   Shared secret the nOCP extension sends as ?token=.
#                       Generate one with: openssl rand -hex 32
#
# Optional env vars:
#   NOCP_ADMIN_TOKEN   Shared secret for /admin (sent as header
#                       X-NOCP-Admin-Token). Generated automatically if unset.
#   NOCP_TITLE         Browser tab title (default: Category Explorer)
#   AWS_REGION         Deploy region (default: us-east-1)
#
# Safe to re-run: updates code/config on an existing function instead of
# failing, and only creates the IAM role, SSM parameters, and Function URL
# if missing. The SSM access policy is re-applied every run regardless.
#
# The Optimizely Graph Single Key itself is NOT set here — after deploying,
# open https://<function-url>/admin and use the admin token this script
# prints to enter it.
#
set -euo pipefail

# Windows Git Bash auto-converts any argument LOOKING like a POSIX absolute
# path (starts with /) into a Windows path when it's passed to a native
# (non-MSYS) executable — jq.exe and aws.exe both qualify. SETTINGS_PARAM/
# ICON_PARAM below (SSM parameter names, which by convention start with /)
# are exactly that shape — see nocp-frontify's deploy.sh for the full story
# on how this silently corrupted a deployed env var the hard way.
# MSYS_NO_PATHCONV=1 turns this conversion off for the whole script;
# harmless everywhere else, since the actual file paths that still need
# conversion go through to_file_uri() below explicitly.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# .env is optional and gitignored — see .env.example. Only fills in vars
# not already set, so `NOCP_FRAME_TOKEN=x ./deploy.sh` on the command line
# still wins over whatever .env has.
if [[ -f "$REPO_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$REPO_DIR/.env"
fi

# mktemp/pwd produce POSIX-style paths (/tmp/..., /c/Users/...) under
# Windows Git Bash, but a native (non-MSYS) aws.exe can't resolve those when
# they're embedded in a file:// or fileb:// URI - it needs the real Windows
# path. cygpath -w does that conversion; falls back to the path unchanged
# wherever cygpath isn't available (Linux/macOS, or a Linux-native aws CLI).
to_file_uri() {
  local prefix="$1" path="$2"
  if command -v cygpath >/dev/null 2>&1; then
    echo "${prefix}$(cygpath -w "$path")"
  else
    echo "${prefix}${path}"
  fi
}

FUNCTION_NAME="${1:-nocp-category-explorer}"
ROLE_NAME="${FUNCTION_NAME}-role"
SETTINGS_PARAM="/${FUNCTION_NAME}/settings"
# Separate from SETTINGS_PARAM, deliberately — SSM Standard parameters cap
# out at 4KB per value; see settingsStore.ts's own comment on ICON_PARAM_NAME.
ICON_PARAM="/${FUNCTION_NAME}/icon"
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
ACCOUNT_ID="$(aws sts get-caller-identity --query 'Account' --output text)"
SETTINGS_PARAM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SETTINGS_PARAM}"
ICON_PARAM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${ICON_PARAM}"

echo "==> Granting the function's role access to $SETTINGS_PARAM and $ICON_PARAM"
SSM_POLICY_FILE="$(mktemp)"
ENV_VARS_FILE="$(mktemp)"
trap 'rm -f "$SSM_POLICY_FILE" "$ENV_VARS_FILE"' EXIT

jq -n --arg settingsArn "$SETTINGS_PARAM_ARN" --arg iconArn "$ICON_PARAM_ARN" '{
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:PutParameter"],
      Resource: $settingsArn
    },
    {
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
      Resource: $iconArn
    }
  ]
}' > "$SSM_POLICY_FILE"

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${FUNCTION_NAME}-ssm" \
  --policy-document "$(to_file_uri file:// "$SSM_POLICY_FILE")" \
  --output text >/dev/null

jq -n \
  --arg token "$NOCP_FRAME_TOKEN" \
  --arg admin "$NOCP_ADMIN_TOKEN" \
  --arg title "${NOCP_TITLE:-Category Explorer}" \
  --arg param "$SETTINGS_PARAM" \
  --arg iconParam "$ICON_PARAM" \
  '{Variables: {
    NOCP_FRAME_TOKEN: $token,
    NOCP_ADMIN_TOKEN: $admin,
    NOCP_TITLE: $title,
    NOCP_SETTINGS_PARAM: $param,
    NOCP_ICON_PARAM: $iconParam
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
    --timeout 10 \
    --memory-size 128 \
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
echo "   Health check (no gate):  ${URL}healthz"
echo "   Settings page (admin):   ${URL}admin"
echo ""
echo "   In the nOCP extension's Options page, set this app's:"
echo "     URL         -> $URL"
echo "     Frame Token -> open ${URL}admin to see the current value (only"
echo "                     guaranteed to match the bootstrap value below on"
echo "                     a brand new deploy, not a re-run against an"
echo "                     already-bootstrapped app)"
echo ""
echo "   Bootstrap frame token (this run's NOCP_FRAME_TOKEN): $NOCP_FRAME_TOKEN"
echo "   Bootstrap admin token (X-NOCP-Admin-Token header):   $NOCP_ADMIN_TOKEN"
echo ""
echo "   Next: open ${URL}admin and enter your Optimizely Graph Single Key —"
echo "   the app won't function until that's saved."
