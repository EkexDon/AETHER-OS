# Installing AETHER-OS

AETHER-OS is a desktop app for macOS, Windows and Linux. Every GitHub
release, starting with 0.2.0, ships ready-to-run installers — you do not
need Rust, Node.js or Ollama to use it.

- [Download](#download)
- [macOS](#macos) · [Windows](#windows) · [Linux](#linux)
- [First launch: the setup wizard](#first-launch-the-setup-wizard)
- [Local AI with Ollama (optional)](#local-ai-with-ollama-optional)
- [Tools from your shell](#tools-from-your-shell)
- [Where your data lives](#where-your-data-lives)
- [Updating](#updating) · [Uninstalling](#uninstalling) · [Troubleshooting](#troubleshooting)

## Download

Open the **[latest release](https://github.com/EkexDon/AETHER-OS/releases/latest)**
and pick the file for your system (`0.2.0` stands for the version):

| System | File | Notes |
| --- | --- | --- |
| macOS 12 Monterey or later, Apple Silicon **and** Intel | `AETHER-OS_0.2.0_universal.dmg` | one universal app for both chips |
| Windows 10 / 11, x64 | `AETHER-OS_0.2.0_x64-setup.exe` | installs for your user, no admin rights |
| | `AETHER-OS_0.2.0_x64_en-US.msi` | per-machine install (admin), for managed PCs |
| Linux x64, any distribution | `AETHER-OS_0.2.0_amd64.AppImage` | portable single file |
| Debian 12+, Ubuntu 22.04+, Mint 21+ | `AETHER-OS_0.2.0_amd64.deb` | installs the WebKitGTK runtime it needs |
| Fedora, openSUSE | `AETHER-OS-0.2.0-1.x86_64.rpm` | needs WebKitGTK 4.1 from the distribution |
| any | `SHA256SUMS.txt` | checksums of all files above |

The Linux builds are made on Ubuntu 22.04 and need glibc 2.35 or newer
(RHEL 9 and its rebuilds ship glibc 2.34, so they are not supported).
There are no ARM builds for Windows or Linux yet; build from source there
(see the README's *Quick start*).

### Verify the download (optional)

Put `SHA256SUMS.txt` next to the downloaded file and run, in that folder,
on macOS:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

on Linux:

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

On Windows (PowerShell), compare the output of
`Get-FileHash .\AETHER-OS_0.2.0_x64-setup.exe` with the matching line in
`SHA256SUMS.txt`. Each check must say `OK` / show the same hash.

## macOS

1. Open `AETHER-OS_0.2.0_universal.dmg` and drag **AETHER-OS** onto
   **Applications**. Eject the disk image.
2. Start AETHER-OS from Applications, Launchpad or Spotlight.

**The first start is blocked once.** The app is signed ad hoc but not
notarized (that needs a paid Apple Developer ID). Your browser marks the
download with macOS's *quarantine* flag, the app inside the disk image keeps
it when you drag it to Applications, and for a quarantined app that is not
notarized macOS says it "could not verify AETHER-OS is free of malware". To
allow it:

- **macOS 15 Sequoia and later:** click **Done**, open
  **System Settings → Privacy & Security**, scroll to *Security* and click
  **Open Anyway** next to "AETHER-OS was blocked…" (the button stays there
  for about an hour after the blocked start). Confirm the dialog that
  follows with **Open Anyway** and your password or Touch ID.
- **macOS 12–14:** right-click (Control-click) AETHER-OS in Applications →
  **Open** → **Open**.
- **Terminal alternative (any version):** remove the quarantine flag once,
  then open the app normally:

  ```sh
  xattr -cr /Applications/AETHER-OS.app
  ```

macOS remembers the decision for this copy of the app, so later starts open
directly. A new version you download is quarantined again, so after each
update you allow it once more.

**Check the app before you allow it (optional).** These commands show what
macOS sees. They are the checks that were run on a local 0.2.0 build of
the disk image, with the app copied out of it and quarantined the way
Safari does it:

```sh
xattr -p com.apple.quarantine /Applications/AETHER-OS.app
codesign --verify --deep --strict --verbose=2 /Applications/AETHER-OS.app
spctl --assess -vv /Applications/AETHER-OS.app
```

- `xattr -p` prints the quarantine flag, e.g. `0083;…;Safari;…`. This flag
  is what makes macOS show the dialog.
- `codesign` must print `valid on disk` and `satisfies its Designated
  Requirement`: the app is intact and signed ad hoc. That holds while it is
  still quarantined.
- `spctl` says `rejected`. That is expected, because the app is not
  notarized.

Then remove the flag and start the app. It opens without the dialog:

```sh
xattr -cr /Applications/AETHER-OS.app
open /Applications/AETHER-OS.app
```

If `codesign` reports anything else (for example "a sealed resource is
missing or invalid"), the app was damaged or changed after the build. Move
it to the Bin, download it again and compare the disk image with
`SHA256SUMS.txt` (see [Verify the download](#verify-the-download-optional)).

**Privacy prompts.** When the setup wizard looks for existing vaults, or you
open a vault or project in *Documents*, *Desktop* or *Downloads*, macOS asks
once whether AETHER-OS may access that folder. Allow it for the folders your
notes and projects live in (you can change this later in System Settings →
Privacy & Security → Files and Folders). Calendar reminders ask for
permission to show notifications.

## Windows

1. Run `AETHER-OS_0.2.0_x64-setup.exe`.
2. If SmartScreen shows **"Windows protected your PC"**, click
   **More info → Run anyway**. The installer is not signed with a paid
   code-signing certificate, so SmartScreen does not know it yet.
3. The installer puts the app into `%LOCALAPPDATA%\AETHER-OS` (no admin
   rights needed), adds a **Start menu** entry and offers a desktop
   shortcut on the last page.

AETHER-OS renders its UI with Microsoft Edge **WebView2**, which Windows 11
and current Windows 10 already include. If it is missing, the installer
downloads and installs it silently — this one step needs an internet
connection.

Prefer a per-machine install (for all users, `Program Files`)? Use the
`.msi` instead; it needs administrator rights.

## Linux

### AppImage (any distribution)

```sh
chmod +x AETHER-OS_0.2.0_amd64.AppImage
./AETHER-OS_0.2.0_amd64.AppImage
```

AppImages need FUSE 2. Ubuntu 22.04 and later do not install it by default:

```sh
sudo apt install libfuse2      # Ubuntu 22.04, Debian 12
sudo apt install libfuse2t64   # Ubuntu 24.04 and later
```

Without FUSE you can still start it with
`./AETHER-OS_0.2.0_amd64.AppImage --appimage-extract-and-run`. To get a
menu entry, use a helper such as AppImageLauncher or Gear Lever, or install
the `.deb` / `.rpm` instead.

### Debian / Ubuntu (`.deb`)

```sh
sudo apt install ./AETHER-OS_0.2.0_amd64.deb
```

`apt` pulls in WebKitGTK 4.1 and the other libraries the app needs. Start
**AETHER-OS** from the application menu (the command is `aether-core`).

### Fedora / openSUSE (`.rpm`)

```sh
sudo dnf install ./AETHER-OS-0.2.0-1.x86_64.rpm      # Fedora
sudo zypper install ./AETHER-OS-0.2.0-1.x86_64.rpm   # openSUSE
```

### Linux notes

- **Blank window with the NVIDIA driver:** WebKitGTK's DMA-BUF renderer
  can show an empty window with the proprietary NVIDIA driver (mostly on
  Wayland). AETHER-OS turns that renderer off automatically when the NVIDIA
  driver is loaded. On other GPUs with the same symptom start it once with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 aether-core` (or the AppImage path).
- **System-wide launcher shortcut:** the global shortcut (default
  Alt+Space) uses X11 key grabs. On a pure Wayland session it may not fire
  outside the app; Ctrl+K inside the app always works, and the shortcut can
  be changed or switched off in Settings → Search.
- **"Open in Terminal"** uses `$TERMINAL` when set, otherwise the first of
  `x-terminal-emulator`, GNOME Terminal, Konsole, Xfce Terminal, MATE
  Terminal, Tilix, Console, Ptyxis, kitty, Alacritty, WezTerm, foot and
  xterm that is installed.

## First launch: the setup wizard

The first start opens a short wizard. Every step can be skipped and re-run
later from the launcher (Ctrl+K / ⌘K → "Help: run setup again"):

1. **Vault** — connect an existing Obsidian, NoPes or plain Markdown folder
   (the wizard lists the ones it finds in *Documents* and your home folder)
   or create a new one (default: `Documents/AETHER Vault`). Your notes stay
   plain `.md` files in that folder.
2. **AI** — check for Ollama and download a recommended model, or paste an
   OpenRouter key for cloud models, or skip.
3. **Search** — download the `nomic-embed-text` embedding model (~0.27 GB)
   and index the vault for semantic search (needs Ollama).
4. **Tour** — six cards with the key shortcuts.

Nothing is uploaded: there is no account, no telemetry, and crash reports
stay on your machine.

## Local AI with Ollama (optional)

AETHER-OS works without any AI. For the local AI agent, chat with your
notes and semantic search, install [Ollama](https://ollama.com):

| System | Install |
| --- | --- |
| macOS | download the app from ollama.com, or `brew install ollama` |
| Windows | download and run the installer from ollama.com |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |

Start Ollama (the desktop app, or `ollama serve`). AETHER-OS talks to it
only at `http://localhost:11434`. The setup wizard (or Settings → AI)
recommends a chat model for your memory size and downloads it with a
progress bar:

| Memory | Recommended model |
| --- | --- |
| under 8 GB | `llama3.2:1b` |
| 8–16 GB | `llama3.2:3b` |
| 16–32 GB | `qwen2.5:7b` |
| 32 GB and more | `qwen2.5:14b` |

You can also pull models yourself, e.g.
`ollama pull llama3.2:3b && ollama pull nomic-embed-text`.

Cloud models are an alternative: paste an [OpenRouter](https://openrouter.ai)
API key in the wizard or Settings → AI. The key is stored in the app's data
folder on this machine only.

## Tools from your shell

The IDE's language servers (`typescript-language-server`, `pyright`,
`rust-analyzer`, `vscode-json-language-server` — all optional), Git, `npx`,
the built-in terminal and the agent's *run command* action use programs from
your `PATH`.

Apps started from Finder, the Dock, the Start menu or a Linux desktop menu
do not see the `PATH` your shell profile builds. On macOS and Linux
AETHER-OS therefore asks your login shell for its `PATH` once at start-up
(at most 3 seconds) and adds the usual tool folders that exist on your
machine (Homebrew, `/usr/local/bin`, `~/.cargo/bin`, `~/.local/bin`, nvm,
Volta, Bun, Deno, Go, Nix, Linuxbrew). The app log records what happened
(a line starting with `PATH:` — Settings → Data & Privacy → Application
log).

If a tool is still not found, make sure `which <tool>` finds it in a *new*
terminal window. A slow shell profile can skip heavy work for this lookup:

```sh
# ~/.zshrc or ~/.bashrc
[ -n "$AETHER_RESOLVING_ENVIRONMENT" ] && return
```

Windows apps always receive the full `PATH`, so nothing is needed there.

## Where your data lives

| Data | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Your notes (vault) | the folder you chose | the folder you chose | the folder you chose |
| App data: settings, indexes, AI notes, calendar, tasks, clipboard, plugins, sync state | `~/Library/Application Support/com.ekin.aetheros/` | `%APPDATA%\com.ekin.aetheros\` | `~/.local/share/com.ekin.aetheros/` |
| Log and crash reports | `<app data>/logs/aether.log`, `<app data>/crash-reports/` | same | same |
| UI preferences (theme, layout) — webview storage and cache | `~/Library/WebKit/com.ekin.aetheros/`, `~/Library/Caches/com.ekin.aetheros/` | `%LOCALAPPDATA%\com.ekin.aetheros\` | inside the app data folder |

On Linux `~/.local/share` is `$XDG_DATA_HOME` when that is set. The
README's *Where your data lives* section lists every file inside the app
data folder. Settings → Data & Privacy shows the folders with their sizes,
opens them, and can reset the app data (the folder is moved aside, never
deleted; the vault is never touched).

## Updating

Settings → Updates checks GitHub for a newer published release and links to
it. Download the new installer and install it over the old version — on
macOS drag the new app into Applications and choose *Replace*. Your vault
and app data are kept.

## Uninstalling

Removing the app never touches your vault.

- **macOS:** quit AETHER-OS and move `/Applications/AETHER-OS.app` to the
  Bin. To remove its data as well, delete
  `~/Library/Application Support/com.ekin.aetheros`,
  `~/Library/WebKit/com.ekin.aetheros` and
  `~/Library/Caches/com.ekin.aetheros`.
- **Windows:** Settings → Apps → Installed apps → **AETHER-OS** →
  Uninstall. Tick *Delete the application data* in the uninstaller to also
  remove `%APPDATA%\com.ekin.aetheros` and
  `%LOCALAPPDATA%\com.ekin.aetheros`.
- **Linux:** `sudo apt remove aether-os` (deb) or
  `sudo dnf remove aether-os` (rpm), or delete the AppImage. To remove the
  data as well, delete `~/.local/share/com.ekin.aetheros` (it also holds
  the webview storage).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| macOS: "AETHER-OS is damaged and can't be opened" | The quarantine flag is stuck: `xattr -cr /Applications/AETHER-OS.app`, then open it again. |
| macOS: "could not verify … free of malware" | Expected on the first start — see [macOS](#macos). |
| Windows: nothing happens after SmartScreen | Run the installer again and choose **More info → Run anyway**; check that WebView2 installed (Settings → Apps → "Microsoft Edge WebView2 Runtime"). |
| Linux: AppImage says `dlopen(): error loading libfuse.so.2` | Install `libfuse2` / `libfuse2t64` (see [AppImage](#appimage-any-distribution)). |
| Linux: empty white or grey window | Start with `WEBKIT_DISABLE_DMABUF_RENDERER=1`. |
| AI: "Ollama is not running" | Start Ollama and check `curl http://localhost:11434/api/tags` answers. |
| A language server or tool is not found | See [Tools from your shell](#tools-from-your-shell). |

Still stuck? Settings → Data & Privacy has the application log and local
crash reports — attach them (after reading them) to a
[GitHub issue](https://github.com/EkexDon/AETHER-OS/issues).
