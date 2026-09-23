/**
 * Barrel for all shared frontend types. Each domain lives in its own file;
 * feature agents add `export * from "./<feature>";` directly above their
 * anchor (SWARM-CONTRACT §3) and never edit other lines.
 */
export * from "./vault";
export * from "./ai";
export * from "./projects";
export * from "./memory";
export * from "./terminal";
export * from "./system";
export * from "./browser";
export * from "./notes";
export * from "./ide";
export * from "./git";
export * from "./calendar";
export * from "./tasks";
export * from "./agentActions";
export * from "./diagnostics";
export * from "./updater";
// @anchor:types:clipboard
// @anchor:types:search
// @anchor:types:history
// @anchor:types:home
// @anchor:types:vaulttasks
// @anchor:types:intel
// @anchor:types:plugins
// @anchor:types:export
// @anchor:types:sync
// @anchor:types:onboarding
