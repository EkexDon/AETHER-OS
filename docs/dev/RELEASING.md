# Releasing AETHER-OS

Releases are built by `.github/workflows/release.yml` whenever a tag
matching `v*` is pushed. The workflow creates a **draft** GitHub release and
attaches **unsigned** bundles for:

| Runner | Target | Bundles |
| --- | --- | --- |
| `macos-latest` | `aarch64-apple-darwin` | `.dmg`, `.app.tar.gz` |
| `macos-latest` | `x86_64-apple-darwin` | `.dmg`, `.app.tar.gz` |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb`, `.rpm` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`, `-setup.exe` (NSIS) |

## Cutting a release

1. Make sure `main` is green (CI) and `npm run check` passes locally.
2. Bump the version in **all three** places — the workflow refuses to run
   when they disagree with the tag:
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
3. Update the changelog / release notes and commit:
   `git commit -am "Release v0.2.0"`.
4. Tag and push:

   ```sh
   git tag -a v0.2.0 -m "AETHER-OS v0.2.0"
   git push origin main v0.2.0
   ```

   Tags with a pre-release suffix (`v0.3.0-rc.1`) become GitHub
   pre-releases.
5. Wait for the four build jobs, then open the draft on the Releases page,
   paste the release notes and click **Publish release**.

The in-app update check (`cmd_check_for_updates`) reads
`/repos/EkexDon/AETHER-OS/releases/latest`, which only returns
**published**, non-pre-release releases — drafts are invisible to users
until you publish them.

## Opening unsigned builds

- **macOS:** right-click the app → *Open* → *Open* (once), or
  `xattr -dr com.apple.quarantine /Applications/AETHER-OS.app`.
- **Windows:** SmartScreen → *More info* → *Run anyway*.
- **Linux:** `chmod +x AETHER-OS_*.AppImage` and run it.

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
3. Pass them as `env:` to the tauri-action step. Tauri signs and notarizes
   automatically when these variables are present.

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
