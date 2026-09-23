# Sync & Backup — encrypted multi-device sync without a cloud account (roadmap 5.3)

## What

AETHER-OS syncs your vault — and, if you want, its app data (memory facts,
calendar events, tasks, saved AI notes) — between devices through **any
folder you already have**: iCloud Drive, Dropbox, Syncthing, a USB stick or a
NAS share. Everything that reaches the folder is **end-to-end encrypted**;
other devices running AETHER-OS decrypt it with the same passphrase. On top
of that you get one-click **encrypted backups** (`.aetherbak`) that can be
verified and restored anywhere, plus scheduled backups with retention.

There is no relay server and no account. The on-disk format is documented
below so a future relay (or a mobile client) can reuse it unchanged.

## Why

Your notes should be on every device without trusting a provider with their
content. The sync tool you already use becomes a dumb transport for
unreadable blobs; the passphrase never leaves your head (unless you opt in
to remembering the derived key on a device).

## How to use

Open **Sync & Backup** in the rail (System group), click the sync item in the
status bar, or use the command palette (⌘K).

1. **Set up sync** → choose the shared folder (Browse… opens the folder
   dialog). AETHER-OS tells you whether the folder already holds a store
   (then you *join* it) or a new one will be created.
2. Read the three-point model (encrypted on this device · the sync tool sees
   only noise · same passphrase everywhere, no reset) and decide whether app
   data is included.
3. Enter the passphrase — twice with a strength meter when creating a new
   one; once when joining. Optionally **Remember on this device** (see
   *Security*). The first sync runs immediately, then every minute.

On another device: install AETHER-OS, point it at the same folder, enter the
same passphrase. That's it.

| Shortcut | Command |
| --- | --- |
| ⌥⌘Y | Sync: sync now (asks to unlock or set up first when needed) |
| ⌥⌘L | Sync: lock (forget the key) |
| ⌥⇧⌘B | Backup: create now (into the configured backup folder) |
| — | Sync: unlock |

**Status bar** — cloud icon: *Synced*, *Syncing n%* (spinner), *Locked*,
*Sync error*, *n conflicts* or *Sync off*; the tooltip explains the state and
the last sync time; click opens the view. When sync is on but locked, the
passphrase prompt appears once at app start (the default — nothing is stored).

**View** — status card (state, folder, last sync, pending ↑/↓, conflicts,
last round report with skipped files), conflicts, backups, devices, schedule
and encryption settings.

**Conflicts** — when two devices changed the same file since their last
common version, the newer version (by modification time, device id as a tie
break) keeps the path and the other one is written next to it as
`Note (conflict from <device> <YYYY-MM-DD HHMMSS>).md`. Nothing is lost. The
conflict list opens a side-by-side line diff; *Keep the note* moves the copy
to the trash, *Use the copy* writes the copy's content into the note (and
trashes the copy), *Keep both files* just closes the conflict. Resolutions
sync to every device. Edit-vs-delete is not a conflict: the edit wins.

**Backups** — *Back up now* writes `aether-backup-<timestamp>.aetherbak`
into the chosen folder (an external drive is ideal). The list shows every
backup in the folder (no passphrase needed — the manifest is plaintext).
*Verify* decrypts every file and checks its hash. *Restore* shows a dry-run
preview (files, size, device, date, filterable file list), then asks for the
target folder and mode:

- **Merge** adds missing files; files that differ are kept and the backup
  version is saved next to them as `Note (restored <ts>).md`. App-data files
  that differ are kept.
- **Replace** restores exactly the backup. The existing folder is first
  renamed to `<name>.pre-restore-<ts>` (never deleted); app data is moved to
  `<data_dir>/sync/pre-restore-<ts>/`. Replace is only allowed on the current
  vault or an empty/new folder.

**Schedule** — sync interval (30 s … 1 h), scheduled backups (off, every 6 h,
12 h, daily, weekly) with retention (keep 3 … 90). Overdue backups run right
after unlock (catch-up on launch). Only *scheduled* backups are pruned;
manual ones are never deleted automatically.

**Settings → Sync & Backup** has everything in compact form: folder, on/off,
interval and scope, device name, backup schedule, lock/unlock, remember, change
passphrase.

## Security model

| Piece | Choice |
| --- | --- |
| Key derivation | Argon2id v1.3, m = 64 MiB, t = 3, p = 1, 16-byte random salt → 32-byte master key |
| Sub-keys | BLAKE3 `derive_key("aether-sync-file-v1" / "aether-sync-meta-v1" / "aether-sync-names-v1", master)` |
| Encryption | AES-256-GCM, fresh 96-bit random nonce per object, header authenticated as AAD |
| Verifier | `blake3(master ‖ "verify")` stored next to the salt — wrong passphrases are rejected before anything is decrypted |
| Names | keyed BLAKE3 hashes: blobs are `blob_id = keyed(names_key, content_hash)`, paths are `keyed(names_key, path)` — no plaintext path or content hash on disk |
| Integrity | besides the AEAD tag, blob headers name their blob id (no swapping) and plaintext hashes are checked against the index |
| Memory | keys live in `Zeroizing` buffers, wiped on lock, folder change and when the main window closes |
| Passphrase | never stored; minimum 8 characters for new passphrases |

All primitives come from audited crates (`aes-gcm`, `argon2`, `blake3`,
`zeroize`, `rand::OsRng`). Tests cover the RFC 9106 Argon2id vector, a NIST
CAVS AES-256-GCM vector, the official BLAKE3 vectors, round trips, wrong
passphrases, tampered ciphertext/nonce/tag/header, kind substitution, nonce
uniqueness over 10 000 encryptions, the verifier and path-hash determinism.

**Remember on this device** (opt-in, labelled "less secure") writes the
derived master key to `<data_dir>/sync/key.bin` with `0600` permissions so the
start-up prompt is skipped. Turning it off overwrites and deletes the file.

**Passphrase change** re-encrypts every blob, index, device record and
conflict record in the sync folder with a key from a fresh salt, then swaps
`keyinfo.json` atomically (resumable: re-running with the same new
passphrase skips objects already migrated). Other devices detect the new
verifier, lock themselves and ask for the new passphrase. Existing backups
keep the passphrase they were made with.

## Where data lives

On this device (`~/Library/Application Support/com.ekin.aetheros/sync/`):

| File | Content |
| --- | --- |
| `settings.json` | `SyncSettings` (device id + name, folder, interval, backup schedule) |
| `keyinfo.json` | cached key parameters (store id, KDF, salt, verifier) — no secret |
| `key.bin` | the master key, **only** with "remember on this device" (0600) |
| `state.json` | last common version per path, hash cache, last sync/backup/GC times |
| `trash/` | app-data files removed because another device deleted them |
| `conflict-copies/` | app-data conflict copies (synced as `app-conflicts/…`) |
| `pre-restore-<ts>/` | app data set aside by a *replace* restore |

Vault files deleted by another device go to `<vault>/.trash/<path>`.

## Format (for a future relay)

### Envelope (every encrypted object)

```
"AETHSYN1" | u32 BE header length | header JSON | 12-byte nonce | AES-256-GCM(ciphertext ‖ tag)
AAD = magic ‖ length ‖ header JSON
```

Header: `{ "v": 1, "kind": "blob|index|device|conflict|backup_index|backup_blob",
"kdf": { "alg": "argon2id", "version": 19, "m_kib": 65536, "t": 3, "p": 1 },
"salt": "<hex>", "device_id": "…", "path_hash"?: "…", "mtime"?: <ms>,
"size": <plaintext bytes>, "content_hash"?: "<blob id | manifest hash>" }`.
Blobs and backup blobs use the file key, everything else the meta key.

### Sync folder `<sync_dir>/aether-sync/v1/`

```
keyinfo.json              { v, store_id, kdf, salt, verifier, created_at, created_by }   (plaintext)
devices/<device_id>.json  envelope(device): { device_id, device_name, platform, app_version, last_seen, file_count }
index/<device_id>.idx     envelope(index):  { device_id, device_name, generated_at, entries: { "<path>": IndexEntry } }
blobs/<blob_id>.bin       envelope(blob):   file content (content-addressed → dedupe)
conflicts/<id>.json       envelope(conflict): ConflictRecord (id = first 32 hex of keyed hash of the copy path)
```

`IndexEntry = { content_hash, size, mtime, deleted, deleted_at?, version, device, device_name }`.
Logical paths: `vault/<rel>`, `app/<memory|calendar/events|tasks/projects|tasks/items|aether/notes>/<file>.json`,
`app-conflicts/<…>`.

### Algorithm

Per path: local state vs. *base* (last common version, per device) vs. the
best remote entry by `(version, mtime, device_id)`. Local-only change →
upload as version `max(known)+1`; remote-only change → download (or move to
trash for tombstones); both changed to the same content → adopt; both
changed differently → conflict copy as above; edit beats delete. Tombstones
live 30 days; unreferenced blobs are garbage-collected after 7 days (daily,
only when every index was readable). Excluded: `.git`, `.trash`, `.nopes`,
`.aether*`, `.DS_Store`, `.obsidian/workspace*`, `.obsidian/cache`, temp
files; files over 128 MiB are skipped and reported. Markdown is written
through `VaultReader::write_note` (history and watchers see it), other files
atomically; modification times are preserved.

### Backup archive `.aetherbak`

A ZIP (stored): `manifest.json` (plaintext: format, v, created_at, device,
counts, include_app_data, scheduled, kdf, salt, verifier), `index.bin`
(envelope(backup_index) of `{ files: [{ path, size, mtime, content_hash }] }`
whose header `content_hash` is the BLAKE3 of the exact manifest bytes — so any
manifest edit is detected) and `blobs/<blob_id>.bin`. Self-contained: the
passphrase alone restores it on a fresh machine.

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_sync_get_settings` | — | `SyncSettings` |
| `cmd_sync_set_settings` | `patch: SyncSettingsPatch` (`""` clears a folder) | `SyncSettings` |
| `cmd_sync_inspect_folder` | `path` | `SyncFolderInfo { initialized, device_count, created_at, created_by }` |
| `cmd_sync_unlock` | `passphrase`, `remember` | `SyncStatus` |
| `cmd_sync_lock` | — | `SyncStatus` |
| `cmd_sync_now` | — | `SyncReport` |
| `cmd_sync_status` | — | `SyncStatus` |
| `cmd_sync_list_conflicts` | — | `SyncConflict[]` (unresolved first) |
| `cmd_sync_get_conflict` | `id` | `SyncConflictDetail { conflict, current_content, other_content, binary }` |
| `cmd_sync_resolve_conflict` | `id`, `keep: "local" \| "remote" \| "both"` | `SyncConflict` |
| `cmd_sync_change_passphrase` | `oldPassphrase`, `newPassphrase` | `PassphraseChangeReport` |
| `cmd_sync_devices` | — | `DeviceInfo[]` |
| `cmd_sync_backup_create` | `destDir`, `includeAppData` | `BackupReport` |
| `cmd_sync_backup_list` | `dir` | `BackupInfo[]` (newest first) |
| `cmd_sync_backup_verify` | `path`, `passphrase` | `BackupVerifyReport` |
| `cmd_sync_backup_preview` | `path`, `passphrase` | `BackupPreview { files, bytes, created_at, device, … }` |
| `cmd_sync_backup_restore` | `path`, `passphrase`, `targetDir`, `mode: "merge" \| "replace"` | `RestoreReport` |

Events: `sync-status` (`SyncStatus { state: idle|syncing|error|locked, last_sync_at,
pending_uploads, pending_downloads, conflicts, message, … }`) and
`sync-progress` (`{ operation: sync|backup|verify|restore|passphrase, done, total }`).

`keep: "local"` means the version at the file's own path, `"remote"` the
conflict copy — independent of which device you resolve on.

Errors carry their own prefixes (`AetherError::Sync` / `AetherError::Crypto`):
`sync error: …` for the folder, the transfer and restores (e.g. "the sync
folder is not reachable: <dir>"), `crypto error: …` for keys and data (e.g.
"wrong passphrase", "decryption failed: the data was modified or belongs to a
different passphrase").

## Code map

| Layer | Files |
| --- | --- |
| Engine | `src-tauri/src/engine/sync.rs` (engine, settings, keys, background loop, passphrase migration), `sync/crypto.rs`, `sync/folder_sync.rs`, `sync/conflict.rs`, `sync/snapshot.rs` |
| Commands | `src-tauri/src/commands/sync_commands.rs` (`init_sync` wires events + loop) |
| Frontend | `src/types/sync.ts`, `src/lib/ipc/sync.ts`, `src/lib/syncStore.ts`, `src/lib/sync/{entropy,diff,format,pickFolder,commands}.ts`, `src/components/sync/*`, `src/styles/views/sync.css` |
| Mock | `src/lib/mock/sync.ts` — "Demo MacBook" + "Studio iMac" in an iCloud folder, one conflict on `01-Projects/Local-first Sync.md`, four backups. Any passphrase with ≥ 8 characters unlocks; passphrases containing "wrong" fail. |

## Limitations

- Conflict resolution is per file; JSON app-data stores such as
  `memory/facts.json` are not merged field by field (both versions are kept).
- Files larger than 128 MiB are skipped (whole files are encrypted in memory).
- A device offline for more than 30 days may bring back files deleted
  elsewhere (tombstone expiry) — data is resurrected, never lost.
- File names differing only in case or Unicode normalisation (NFC/NFD) can
  collide on case-insensitive file systems.
- Metadata visible in the sync folder: number and size of blobs, their
  modification times, device ids and the time of every write.
- On Windows the opt-in `key.bin` relies on the user profile ACLs (no 0600).
- The key is wiped when the main window is destroyed; a hard kill leaves it
  to the OS to reclaim the memory.
- Backups made before a passphrase change keep the old passphrase.
