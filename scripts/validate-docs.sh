#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

python3 scripts/test-validate-docs.py
python3 scripts/validate-docs.py "$@"
npx --yes markdownlint-cli2@0.23.2 '**/*.md' '#node_modules'
git diff --check
git diff --cached --check
