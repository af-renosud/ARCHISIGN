#!/bin/bash
set -euo pipefail

shopt -s globstar nullglob
files=(server/**/__tests__/*.test.ts)

if [ ${#files[@]} -eq 0 ]; then
  echo "No server Node test suites found under server/**/__tests__/*.test.ts" >&2
  exit 1
fi

echo "Running ${#files[@]} Node test suite(s):"
for f in "${files[@]}"; do
  echo "  - $f"
done

exec npx tsx --test "${files[@]}"
