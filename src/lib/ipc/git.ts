/** Source control commands (`src-tauri/src/commands/git_commands.rs`).
 *  `path` is any directory inside a sandboxed repository. */
import type { BranchInfo, CommitInfo, FileDiff, RepoStatus } from "../../types";
import { call } from "./core";

/** Branch, ahead/behind and staged/unstaged file changes. */
export const gitStatus = (path: string) => call<RepoStatus>("cmd_git_status", { path });
/** Stage files (repository-relative paths). */
export const gitStage = (path: string, files: string[]) =>
  call<void>("cmd_git_stage", { path, files });
/** Unstage files. */
export const gitUnstage = (path: string, files: string[]) =>
  call<void>("cmd_git_unstage", { path, files });
/** Discard working tree changes. */
export const gitDiscard = (path: string, files: string[]) =>
  call<void>("cmd_git_discard", { path, files });
/** Commit the index; returns the new commit id. */
export const gitCommit = (path: string, message: string) =>
  call<string>("cmd_git_commit", { path, message });
/** Local branches, current first. */
export const gitBranches = (path: string) =>
  call<BranchInfo[]>("cmd_git_branches", { path });
/** Check out an existing local branch. */
export const gitSwitchBranch = (path: string, branch: string) =>
  call<void>("cmd_git_switch_branch", { path, branch });
/** Create a branch at HEAD without switching. */
export const gitCreateBranch = (path: string, branch: string) =>
  call<void>("cmd_git_create_branch", { path, branch });
/** Recent commits reachable from HEAD (default 50). */
export const gitLog = (path: string, limit?: number) =>
  call<CommitInfo[]>("cmd_git_log", { path, limit });
/** Old/new content of one file (`staged`: HEAD↔index, else index↔worktree). */
export const gitDiffFile = (path: string, file: string, staged: boolean) =>
  call<FileDiff>("cmd_git_diff_file", { path, file, staged });
