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
// @anchor:ipc:clipboard
// @anchor:ipc:search
// @anchor:ipc:history
// @anchor:ipc:home
// @anchor:ipc:vaulttasks
// @anchor:ipc:intel
// @anchor:ipc:plugins
// @anchor:ipc:export
// @anchor:ipc:sync
// @anchor:ipc:onboarding
