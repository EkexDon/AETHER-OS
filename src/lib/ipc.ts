/**
 * Typed IPC barrel. Every backend command has a documented wrapper in
 * `src/lib/ipc/<domain>.ts`; `./ipc/core` provides `call`, `listenSafe`,
 * the runtime checks and the mock-mode routing. Import from here
 * (`../lib/ipc`) — the file layout behind it is an implementation detail.
 *
 * Feature agents add `export * from "./ipc/<feature>";` directly above
 * their anchor (SWARM-CONTRACT §3) and never edit other lines.
 */
export * from "./ipc/core";
export * from "./ipc/vault";
export * from "./ipc/ai";
export * from "./ipc/aetherNotes";
export * from "./ipc/projects";
export * from "./ipc/memory";
export * from "./ipc/terminal";
export * from "./ipc/system";
export * from "./ipc/browser";
export * from "./ipc/notes";
export * from "./ipc/ide";
export * from "./ipc/git";
export * from "./ipc/calendar";
export * from "./ipc/lsp";
export * from "./ipc/tasks";
export * from "./ipc/agentActions";
export * from "./ipc/diagnostics";
export * from "./ipc/updater";
export * from "./ipc/clipboard";
// @anchor:ipc:clipboard
export * from "./ipc/search";
// @anchor:ipc:search
export * from "./ipc/history";
// @anchor:ipc:history
export * from "./ipc/home";
// @anchor:ipc:home
export * from "./ipc/vaulttasks";
// @anchor:ipc:vaulttasks
export * from "./ipc/intel";
// @anchor:ipc:intel
export * from "./ipc/plugins";
// @anchor:ipc:plugins
export * from "./ipc/export";
// @anchor:ipc:export
export * from "./ipc/sync";
// @anchor:ipc:sync
export * from "./ipc/onboarding";
// @anchor:ipc:onboarding
