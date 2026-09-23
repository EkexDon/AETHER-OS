/** Project launcher types — mirror `commands/project_commands.rs`. */

/** A code project discovered under one of the configured project dirs. */
export interface Project {
  name: string;
  path: string;
  git_branch: string | null;
  git_status: string | null;
  last_commit_msg: string | null;
  /** Seconds since the Unix epoch. */
  last_commit_date: number | null;
  language: string;
}
