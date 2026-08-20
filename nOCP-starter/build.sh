#!/usr/bin/env bash
#
# Builds this starter's two runnable artifacts:
#   1. dist/function.zip — the AWS Lambda deployment package (src/lambda.ts,
#      the AWS-specific adapter around the portable src/app.ts).
#   2. dist/serve-local.mjs — a plain Node server running the exact same
#      src/app.ts, for local testing with zero cloud account needed. Run it
#      with: node dist/serve-local.mjs (see src/serve-local.ts's header).
#
# Both bundle src/widget.ts (the client-side widget) to dist/widget.txt
# first, then inline it into whichever adapter via esbuild's text loader —
# same pattern as the full nOCP-widget app one directory up.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npx tsc --noEmit

rm -rf dist
mkdir -p dist/lambda

echo "==> Bundling client widget"
npx esbuild src/widget.ts --bundle --minify --format=iife --target=es2020 --outfile=dist/widget.txt

echo "==> Bundling Lambda handler"
npx esbuild src/lambda.ts --bundle --minify --platform=node --target=node20 --format=esm \
  --loader:.txt=text \
  --outfile=dist/lambda/index.mjs

echo "==> Bundling local dev server"
npx esbuild src/serve-local.ts --bundle --minify --platform=node --target=node20 --format=esm \
  --loader:.txt=text \
  --outfile=dist/serve-local.mjs

echo "==> Packaging dist/function.zip"
( cd dist/lambda && zip -q -r ../function.zip . )

echo "==> Built dist/function.zip and dist/serve-local.mjs"
