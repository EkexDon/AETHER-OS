#!/usr/bin/env sh
set -eu
(
  cd src-tauri
  cargo fmt --check
  cargo test
  cargo clippy -- -D warnings
)
npx tsc --noEmit
npm run test
npm run build
