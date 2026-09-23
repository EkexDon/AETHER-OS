/** Mock handlers for `commands/lsp_commands.rs`. Sessions start and return
 *  a key but never send messages, so Monaco keeps its built-in features. */
import { resolveExisting } from "./ide";
import { argString, registerReset, type MockHandlerMap } from "./runtime";

const SERVER_COMMANDS: Record<string, string> = {
  typescript: "typescript-language-server --stdio",
  javascript: "typescript-language-server --stdio",
  rust: "rust-analyzer",
  python: "pyright-langserver --stdio",
  json: "vscode-json-language-server --stdio",
};

let sessions = new Set<string>();
registerReset(() => {
  sessions = new Set();
});

export const lspHandlers: MockHandlerMap = {
  cmd_lsp_start: (args) => {
    const root = resolveExisting(argString(args, "rootPath"));
    const language = argString(args, "language");
    const command = SERVER_COMMANDS[language];
    if (!command) return null;
    const key = `${language}::${root}`;
    sessions.add(key);
    return { key, language, command };
  },
  cmd_lsp_send: (args) => {
    const key = argString(args, "key");
    if (!sessions.has(key)) throw new Error(`invalid input: no language server running for ${key}`);
  },
  cmd_lsp_stop: (args) => {
    sessions.delete(argString(args, "key"));
  },
  cmd_lsp_stop_all: () => {
    sessions.clear();
  },
};
