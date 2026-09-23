/** Mock handlers for `commands/vault_commands.rs`. */
import { argString, isWithin, normalizePath, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";
import { mockPicture, toBase64 } from "./png";

/** Asset extensions and MIME types served by `cmd_read_vault_asset` (as in `vault_reader.rs`). */
const ASSET_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
};

/**
 * Media files that "exist" in the demo vault (vault-relative, compared
 * case-insensitively like macOS). Images are generated PNGs, whatever the
 * extension says, so they render in any browser.
 */
export const MOCK_VAULT_ASSETS = [
  "attachments/sourdough.jpg",
  "01-Projects/assets/aether-architecture.png",
  "attachments/garden-sketch.png",
];

function readAsset(rawPath: string): { mime: string; data_base64: string; byte_len: number } {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error("invalid input: asset path is empty");
  const root = mockVault.root;
  if (!root) throw new Error("vault error: no vault path configured");
  const absolute = normalizePath(trimmed.startsWith("/") ? trimmed : `${root}/${trimmed}`);
  if (!isWithin(absolute, root) || absolute === root) throw new Error(`invalid input: asset is outside the vault: ${trimmed}`);
  const rel = absolute.slice(root.length + 1);
  if (rel.split("/").includes(".git")) throw new Error(`invalid input: assets inside .git are not served: ${trimmed}`);
  const ext = /\.([A-Za-z0-9]+)$/.exec(rel)?.[1]?.toLowerCase() ?? "";
  const mime = ASSET_MIME[ext];
  const known = MOCK_VAULT_ASSETS.find((p) => p.toLowerCase() === rel.toLowerCase());
  if (!known) throw new Error(`invalid input: asset not found: ${trimmed}`);
  if (!mime) throw new Error(`invalid input: not an image, video, audio or PDF file: ${trimmed}`);
  const bytes = mockPicture(known);
  return { mime: mime.startsWith("image/") ? "image/png" : mime, data_base64: toBase64(bytes), byte_len: bytes.length };
}

export const vaultHandlers: MockHandlerMap = {
  cmd_get_vault_path: () => mockVault.root,
  cmd_set_vault_path: (args) => {
    mockVault.setRoot(argString(args, "path"));
  },
  cmd_get_vault_notes: () => mockVault.list(),
  cmd_get_note_content: (args) => mockVault.read(argString(args, "path")),
  cmd_get_vault_index: () => mockVault.index(),
  cmd_get_vault_graph: () => mockVault.graph(),
  cmd_get_vault_stats: () => mockVault.stats(),
  cmd_read_vault_asset: (args) => readAsset(argString(args, "path")),
};
