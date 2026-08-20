#!/usr/bin/env bash
#
# Builds the nocp-widget Lambda deployment package:
#   1. Bundles src/widget.ts and src/admin.ts (both client-side — the gated
#      widget and the settings/admin page, respectively) to single minified
#      JS strings.
#   2. Bundles src/lambda.ts (the Function URL handler), inlining both
#      bundles from step 1 via esbuild's text loader.
#   3. Zips the handler into dist/function.zip, ready for
#      `aws lambda create-function` / `update-function-code`.
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

echo "==> Bundling admin settings page"
npx esbuild src/admin.ts --bundle --minify --format=iife --target=es2020 --outfile=dist/admin.txt

echo "==> Bundling Lambda handler"
# @aws-sdk/* stays external: esbuild's ESM output can't safely bundle its
# CJS internals (they dynamic-require Node builtins like "node:https",
# which throws at runtime once wrapped for ESM — see esbuild#1921-style
# issues). The Node 20.x Lambda managed runtime ships AWS SDK v3
# pre-installed, so this resolves fine at runtime without being in the zip.
npx esbuild src/lambda.ts --bundle --minify --platform=node --target=node20 --format=esm \
  --external:@aws-sdk/* \
  --loader:.txt=text \
  --outfile=dist/lambda/index.mjs

echo "==> Packaging dist/function.zip"
( cd dist/lambda && zip -q -r ../function.zip . )

echo "==> Built dist/function.zip"
