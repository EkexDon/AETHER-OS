/** Mock handlers for `commands/vault_commands.rs`. */
import { argString, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

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
};
