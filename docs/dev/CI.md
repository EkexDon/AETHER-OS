# Continuous integration

Two GitHub Actions workflows live in `.github/workflows/`.

## `ci.yml` — every push and pull request

| Job | Runner | Steps |
| --- | --- | --- |
| `frontend` | `ubuntu-latest`, Node 22 | `npm ci` → `tsc --noEmit` → `vitest run` → `vite build` → assert `dist/` contains no mock backend |
| `rust` | `macos-latest`, stable Rust | `npm ci` → generate icons → `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test` |
| `linux-build-check` | `ubuntu-22.04`, stable Rust | Tauri 2 system packages (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `libssl-dev`, `libxdo-dev`, `build-essential`, `pkg-config`) → generate icons → `cargo check --all-targets` → `cargo clippy --all-targets -- -D warnings` → `cargo test --no-run` |
| `windows-check` | `windows-latest`, stable Rust | generate icons → `cargo check --all-targets` → `cargo clippy --all-targets -- -D warnings` (keeps the Windows `cfg` branches compiling and warning-free) |

Notes:

- **Icons.** PNG/ICNS/ICO icons are gitignored (`src-tauri/icons/*.png`,
  `icon.icns`, `icon.ico`), but `tauri::generate_context!()` embeds the
  window icon at compile time. Both Rust jobs therefore run
  `npx tauri icon src-tauri/icons/icon.svg`, which regenerates the whole set
  from the committed SVG. `tauri.conf.json → bundle.icon` lists the generated
  files, so local builds need the same command once after a fresh clone.
- **`dist/` placeholder.** Debug builds use `devUrl`, so the Rust jobs only
  create an empty `dist/` for safety; they never build the frontend.
- **Caching.** `Swatinem/rust-cache` caches `src-tauri/target` and the cargo
  registry; `actions/setup-node` caches the npm cache keyed on
  `package-lock.json`.
- **Concurrency.** A newer push to the same ref cancels the running CI.
- **`Cargo.lock` is committed**, so CI and release builds resolve the same
  dependency versions as local builds.
- **Linux and Windows locally.** The Linux jobs can be reproduced in a
  `rust:bookworm` container with the packages above; the Windows `cfg`
  branches can be checked from any machine with
  `rustup target add x86_64-pc-windows-gnu` plus the MinGW-w64 toolchain
  and `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`.

## Running the same gates locally

```sh
npm run check        # = sh test_runner.sh
```

`test_runner.sh` runs, in order and failing fast: `cargo fmt --check`,
`cargo clippy -- -D warnings`, `cargo test`, `tsc --noEmit`, `vitest run`,
`vite build`, and the mock-free bundle check.

## Vitest hygiene

- Node ≥ 25 enables its own Web Storage API and prints
  "`--localstorage-file` was provided without a valid path" when jsdom's
  environment touches `localStorage`. `vitest.config.ts` passes
  `--no-experimental-webstorage` to the fork workers (only when the running
  Node knows the flag), so jsdom's storage is used and the output is clean.
- `src/test-setup.ts` resets `IS_REACT_ACT_ENVIRONMENT` to `false` before
  each test. Testing Library turns it on inside its own `act()`/`render()`
  wrappers, so only the benign "not wrapped in act(...)" warnings of views
  that load data on mount are silenced.

## Releases

See [RELEASING.md](RELEASING.md) for the tag-driven `release.yml` workflow.
