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
export * from "./clipboard";
// @anchor:types:clipboard
export * from "./search";
// @anchor:types:search
export * from "./history";
// @anchor:types:history
export * from "./home";
// @anchor:types:home
export * from "./vaulttasks";
// @anchor:types:vaulttasks
export * from "./intel";
// @anchor:types:intel
export * from "./plugins";
// @anchor:types:plugins
export * from "./export";
// @anchor:types:export
export * from "./sync";
// @anchor:types:sync
export * from "./onboarding";
// @anchor:types:onboarding
