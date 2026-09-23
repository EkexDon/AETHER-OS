/** Source control types — mirror `engine/git_repo.rs`. */

/** What happened to a file, from Git's point of view. */
export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "typechange";

/** One changed file with its staged and unstaged state. */
export interface GitStatusEntry {
  path: string;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
}

/** Working tree snapshot plus HEAD position. */
export interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  unborn: boolean;
  entries: GitStatusEntry[];
}

/** A local branch. */
export interface BranchInfo {
  name: string;
  is_current: boolean;
}

/** One commit of the log (`id` is the 7-char short hash). */
export interface CommitInfo {
  id: string;
  summary: string;
  author: string;
  /** Seconds since the Unix epoch. */
  time: number;
}

/** Old/new content of one file for the diff view. */
export interface FileDiff {
  path: string;
  old_content: string | null;
  new_content: string | null;
  is_binary: boolean;
}
