#!/usr/bin/env bash
#
# Builds the nOCP-categoryExplorer Lambda deployment package:
#   1. Bundles src/widget.tsx (client-side React app, runs inside the
#      iframe) and src/admin.ts (the settings page) to single minified JS
#      strings.
#   2. Bundles src/lambda.ts (the Function URL handler), inlining both
#      bundles from step 1 via esbuild's text loader.
#   3. Zips the handler into dist/function.zip.
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
# scripts/build-widget.mjs (JS API, not the plain CLI) so a plugin can
# rewrite Axiom's bundled font CSS to jsDelivr URLs — see that file's header
# comment for why. --outdir (not --outfile) so esbuild splits out a
# companion CSS bundle from Axiom's component CSS side-effect imports.
node scripts/build-widget.mjs
if [[ ! -f dist/widgetbuild/widget.css ]]; then touch dist/widgetbuild/widget.css; fi
cp dist/widgetbuild/widget.js dist/widget.txt

echo "==> Bundling admin settings page"
npx esbuild src/admin.ts --bundle --minify --format=iife --target=es2020 --outfile=dist/admin.txt

echo "==> Bundling Lambda handler"
# @aws-sdk/* stays external — bundling it for ESM output crashes at runtime
# (dynamic require of Node builtins). The Node 22.x Lambda managed runtime
# ships AWS SDK v3 pre-installed.
npx esbuild src/lambda.ts --bundle --minify --platform=node --target=node20 --format=esm \
  --external:@aws-sdk/* \
  --loader:.txt=text \
  --loader:.css=text \
  --outfile=dist/lambda/index.mjs

echo "==> Packaging dist/function.zip"
( cd dist/lambda && zip -q -r ../function.zip . )

echo "==> Built dist/function.zip"
