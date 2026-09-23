#!/usr/bin/env sh
# Run every quality gate of SWARM-CONTRACT §0.2 in order and stop at the
# first failure. Usage: `npm run check` (or `sh test_runner.sh`).
set -eu

cd "$(dirname "$0")"

step() {
  printf '\n\033[1m▶ %s\033[0m\n' "$1"
}

step "cargo fmt --check"
(cd src-tauri && cargo fmt --check)

step "cargo clippy -- -D warnings"
(cd src-tauri && cargo clippy -- -D warnings)

step "cargo test"
(cd src-tauri && cargo test)

step "tsc --noEmit"
npx tsc --noEmit

step "vitest run"
npx vitest run

step "vite build"
npx vite build

step "production bundle is free of the mock backend"
if grep -rq "AETHER mock shell" dist; then
  echo "error: dist/ contains the DEV-only mock backend" >&2
  exit 1
fi

printf '\n\033[1;32m✔ all gates passed\033[0m\n'
