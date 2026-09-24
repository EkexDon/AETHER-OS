# Releasing AETHER-OS

Releases are built by `.github/workflows/release.yml` whenever a tag
matching `v*` is pushed. The workflow creates a **draft** GitHub release,
attaches the installers for every platform and a `SHA256SUMS.txt`, and
waits for you to publish it. What users do with the files is documented in
[`docs/INSTALL.md`](../INSTALL.md).

| Job | Runner | Produces (for version `X.Y.Z`) |
| --- | --- | --- |
| `create-release` | `ubuntu-latest` | version check, draft release `AETHER-OS vX.Y.Z` with per-OS install notes |
| `build` · macOS (universal) | `macos-latest`, Rust targets `aarch64-apple-darwin` + `x86_64-apple-darwin`, `--target universal-apple-darwin` | `AETHER-OS_X.Y.Z_universal.dmg` (plus a `.app.tar.gz` of the app that tauri-action uploads next to it) |
| `build` · Linux (x64) | `ubuntu-22.04` (glibc 2.35 baseline) | `AETHER-OS_X.Y.Z_amd64.AppImage`, `AETHER-OS_X.Y.Z_amd64.deb`, `AETHER-OS-X.Y.Z-1.x86_64.rpm` |
| `build` · Windows (x64) | `windows-latest` | `AETHER-OS_X.Y.Z_x64-setup.exe` (NSIS), `AETHER-OS_X.Y.Z_x64_en-US.msi` (WiX) |
| `checksums` | `ubuntu-latest` | downloads every asset of the draft, checks that each platform produced its installer, uploads `SHA256SUMS.txt` |

File names come from `tauri-apps/tauri-action` and can change between its
versions. Anything that links to them (the website, scripts) must match by
pattern — e.g. `_universal\.dmg$`, `_x64-setup\.exe$`, `_amd64\.AppImage$`,
`_amd64\.deb$`, `\.x86_64\.rpm$` — never by exact name. The `checksums` job
fails when one of those patterns has no match.

## What makes the bundles run on other machines

| Platform | Setting (`src-tauri/tauri.conf.json` unless noted) | Why |
| --- | --- | --- |
| macOS | `bundle.macOS.signingIdentity: "-"` (ad-hoc), `hardenedRuntime: true` | Apple Silicon refuses to run unsigned arm64 code ("is damaged"). Ad-hoc signing makes Gatekeeper show the normal "could not verify" dialog with *Open Anyway* instead. |
| macOS | one universal binary (`--target universal-apple-darwin`) | one download for Apple Silicon and Intel |
| macOS | `minimumSystemVersion: "12.0"` → `LSMinimumSystemVersion` | older macOS versions refuse to start it with a clear message instead of crashing |
| macOS | `src-tauri/Info.plist` (merged by the Tauri CLI) | texts for the Documents / Desktop / Downloads / removable / network volume privacy prompts |
| macOS | DMG with the app and an *Applications* link (`bundle.macOS.dmg`) | drag-to-install; on CI (`CI=true`) the Finder window styling is skipped, the contents are the same |
| Windows | `bundle.windows.nsis.installMode: "currentUser"` | installs to `%LOCALAPPDATA%\AETHER-OS` without admin rights, Start menu entry, optional desktop shortcut |
| Windows | `webviewInstallMode: downloadBootstrapper` (silent) | installs WebView2 when missing (older Windows 10) |
| Linux | `bundle.linux.deb.depends`, `bundle.linux.rpm.depends` | runtime libraries beyond WebKitGTK/GTK that the binary links (see below) |
| all | `engine/shell_env.rs` | apps started from Finder / Dock / desktop menus get the user's login-shell `PATH`, so language servers, Git, `npx`, the terminal and agent commands find Homebrew, cargo, nvm, … tools |
| all | `engine/desktop.rs`, `lsp::find_in_path` | open URLs, editors, terminals and file managers per platform (`open`, `rundll32`/`explorer`/Windows Terminal, `xdg-open` + terminal emulators); `PATHEXT` lookup on Windows |

### Linux runtime dependencies

`tauri-bundler` declares WebKitGTK 4.1 and GTK 3 for the `.deb`
(`libwebkit2gtk-4.1-0, libgtk-3-0`) and the `.rpm` (by soname). Everything
else the binary links (`readelf -d … | grep NEEDED`) comes with those
packages or the base system — except OpenSSL 3 (`libssl.so.3`,
`libcrypto.so.3`, used by reqwest/native-tls and libgit2's HTTPS), which
is declared explicitly in `bundle.linux.*.depends`:

- `.deb`: `libssl3 | libssl3t64` (Ubuntu 24.04 renamed the package)
- `.rpm`: `libssl.so.3()(64bit)`, `libcrypto.so.3()(64bit)` (soname
  capabilities, so Fedora's `openssl-libs` and openSUSE's `libopenssl3`
  both satisfy them)

After dependency upgrades, re-check on a Linux build:
`readelf -d src-tauri/target/release/aether-core | grep NEEDED` and map
each library to its package with `dpkg -S`. A `.deb` can be smoke-tested in
a clean `debian:bookworm` container: `apt-get install ./AETHER-OS_*.deb`,
`ldd /usr/bin/aether-core | grep "not found"` (must print nothing), then
start `aether-core` under `xvfb-run` with an empty `HOME` and check
`~/.local/share/com.ekin.aetheros/logs/aether.log`.

## Cutting a release

1. **Green main.** CI must pass (`ci.yml`: frontend, Rust on macOS, Linux
   clippy/test build, Windows clippy) and `npm run check` locally.
2. **Bump the version in all three places** — `create-release` refuses to
   run when they disagree with the tag:
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version` (then `cargo check` so
     `Cargo.lock` follows)
3. **Changelog.** Move the *Unreleased* entries of `CHANGELOG.md` under a
   `## X.Y.Z — YYYY-MM-DD` heading (the in-app "What's new" dialog shows
   that section). Commit: `git commit -am "Release vX.Y.Z"`.
4. **Optional local smoke test on a Mac** (≈ 3–5 min on Apple Silicon).
   The code blocks have no trailing `# comments`: macOS zsh does not treat
   them as comments when pasted (`interactivecomments` is off by default).

   ```sh
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   CI=true npm run app:build:universal
   app=src-tauri/target/universal-apple-darwin/release/bundle/macos/AETHER-OS.app
   lipo -archs "$app/Contents/MacOS/aether-core"
   codesign -dv --verbose=2 "$app"
   codesign --verify --deep --strict "$app"
   ```

   `app:build:universal` is `tauri build --target universal-apple-darwin`.
   `lipo` must print `x86_64 arm64`, `codesign -dv` must show
   `Signature=adhoc` and `flags=0x10002(adhoc,runtime)`, and the last
   command must print nothing and exit 0. Then start it once with an empty
   home folder and the environment Finder gives an app:

   ```sh
   env -i HOME="$(mktemp -d)" USER="$USER" SHELL=/bin/zsh TMPDIR="$TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$app/Contents/MacOS/aether-core"
   ```

   The setup wizard must appear, and
   `<that HOME>/Library/Application Support/com.ekin.aetheros/logs/aether.log`
   must contain the `starting on` line and a `PATH: minimal GUI PATH (4
   entries) extended to N entries from login shell …` line. (WebKit keeps
   its storage in the *real* `~/Library/WebKit/com.ekin.aetheros` and
   `~/Library/Caches/com.ekin.aetheros` even with a fake `HOME`. If you do
   not use an installed copy yourself, move them away afterwards so the
   next run starts fresh; if you do, they hold that copy's UI settings.)

   Then check the DMG the way a downloaded copy behaves (what
   [`docs/INSTALL.md`](../INSTALL.md#macos) tells users):

   ```sh
   dmg=$(ls src-tauri/target/universal-apple-darwin/release/bundle/dmg/AETHER-OS_*_universal.dmg)
   mnt=$(mktemp -d)
   hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg"
   ls -l "$mnt"
   tmp=$(mktemp -d)
   cp -R "$mnt/AETHER-OS.app" "$tmp/"
   hdiutil detach "$mnt"
   xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" "$tmp/AETHER-OS.app"
   codesign --verify --deep --strict --verbose=2 "$tmp/AETHER-OS.app"
   spctl --assess -vv "$tmp/AETHER-OS.app"
   ```

   The disk image must hold `AETHER-OS.app` and an
   `Applications -> /Applications` link. `codesign` must report `valid on
   disk` and `satisfies its Designated Requirement` although the copy is
   quarantined; `spctl` reports `rejected` (expected: not notarized). Do
   not start the copy while it is quarantined: macOS then shows the
   Gatekeeper dialog, which needs a click. Remove the flag and start it —
   the wizard must appear:

   ```sh
   xattr -cr "$tmp/AETHER-OS.app"
   env -i HOME="$(mktemp -d)" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$tmp/AETHER-OS.app/Contents/MacOS/aether-core"
   ```
5. **Tag and push:**

   ```sh
   git tag -a vX.Y.Z -m "AETHER-OS vX.Y.Z"
   git push origin main vX.Y.Z
   ```

   Tags with a pre-release suffix become GitHub pre-releases. The suffix
   must be **numeric** (`v0.3.0-1`, with `0.3.0-1` in all three version
   fields): an `.msi` (WiX) version is numeric only (`0.3.0.1`), and the
   Tauri bundler refuses a non-numeric pre-release such as `0.3.0-rc.1`
   for the msi target, which fails the Windows leg (not tried in CI yet;
   `bundle.windows.wix.version` can override the MSI version instead).
   Pre-releases never reach the website or the in-app update check,
   which both read the latest *stable* release.
6. **Wait for the workflow** (the macOS and Windows legs take longest; each
   has a 75-minute limit). The `checksums` job
   runs last; if a build leg failed it is skipped and the draft is
   incomplete — fix, delete the draft and the tag, and tag again.
7. **Review the draft** on the Releases page: the body already contains
   the download table, first-launch notes and checksum instructions; add
   the highlights from `CHANGELOG.md` on top.
8. **Verify the checksums** of what you are about to publish:

   ```sh
   mkdir /tmp/aether-release && cd /tmp/aether-release
   gh release download vX.Y.Z --repo EkexDon/AETHER-OS
   sha256sum -c SHA256SUMS.txt
   ```

   `gh release download` also finds a draft when you have write access.
   Every line must say `OK` (on macOS `shasum -a 256 -c SHA256SUMS.txt`
   works as well). Optionally install
   the DMG / setup.exe / AppImage on a machine that never had AETHER-OS.
9. **Publish release.** Only published, non-pre-release releases are
   visible to users and to the in-app update check
   (`cmd_check_for_updates` reads `/repos/EkexDon/AETHER-OS/releases/latest`).

To redo a release: delete the GitHub release, delete the tag locally and
remotely (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix,
tag again. Re-running only the `checksums` job replaces `SHA256SUMS.txt`.

## Opening unsigned builds

The release body and [`docs/INSTALL.md`](../INSTALL.md) explain this to
users:

- **macOS 15+:** open once, then System Settings → Privacy & Security →
  *Open Anyway*. **macOS 12–14:** right-click the app → *Open* → *Open*.
  Any version: `xattr -cr /Applications/AETHER-OS.app`.
- **Windows:** SmartScreen → *More info* → *Run anyway*.
- **Linux:** `chmod +x AETHER-OS_*.AppImage` and run it (needs `libfuse2`
  on Ubuntu 22.04+), or install the `.deb` / `.rpm`.

## Adding code signing later

Nothing is faked today: there are no placeholder keys or secrets. When the
project gets certificates, add them as repository secrets and extend the
`tauri-apps/tauri-action` step's `env`:

### macOS (Developer ID + notarization)

1. Export the *Developer ID Application* certificate as `.p12`, base64
   encode it and store:
   - `APPLE_CERTIFICATE` (base64 `.p12`)
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`)
2. For notarization store either an App Store Connect API key
   (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) or an Apple ID
   (`APPLE_ID`, `APPLE_PASSWORD` = app-specific password, `APPLE_TEAM_ID`).
3. Pass them as `env:` to the tauri-action step and remove
   `signingIdentity: "-"` from `tauri.conf.json` (the env identity takes
   over). Tauri signs and notarizes automatically when these variables are
   present; the Gatekeeper prompt then disappears.

### Windows (Authenticode)

1. Import the code-signing certificate on the runner (or use Azure Trusted
   Signing / a cloud HSM) and set
   `bundle.windows.certificateThumbprint`, `digestAlgorithm: "sha256"` and
   `timestampUrl` in `tauri.conf.json`, or configure `bundle.windows.signCommand`.
2. Keep the certificate in secrets (`WINDOWS_CERTIFICATE`,
   `WINDOWS_CERTIFICATE_PASSWORD`) and import it in a step before the build.

### Auto-updates (optional)

The current updater only *checks* GitHub and links to the release page. To
ship in-app updates with `tauri-plugin-updater`, generate an update key pair
with `npx tauri signer generate`, store `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as secrets, put the public key into
`plugins.updater.pubkey` and enable `bundle.createUpdaterArtifacts`.
tauri-action then uploads the signed `latest.json` alongside the bundles.
