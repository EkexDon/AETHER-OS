/** Embedded IDE types — mirror `engine/workspace.rs`. */

/** One entry of a sandboxed directory listing. */
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}
