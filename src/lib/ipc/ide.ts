/** Embedded IDE commands (`src-tauri/src/commands/ide_commands.rs`).
 *  All paths are sandboxed to the configured project dirs + vault. */
import type { FsEntry } from "../../types";
import { call } from "./core";

/** Allowed root directories. */
export const ideRoots = () => call<string[]>("cmd_ide_roots");
/** List a directory (dirs first, then files, case-insensitive). */
export const ideListDir = (path: string) => call<FsEntry[]>("cmd_ide_list_dir", { path });
/** Read a UTF-8 text file. */
export const ideReadFile = (path: string) => call<string>("cmd_ide_read_file", { path });
/** Overwrite an existing file. */
export const ideWriteFile = (path: string, content: string) =>
  call<void>("cmd_ide_write_file", { path, content });
/** Create a new file; returns its canonical path. */
export const ideCreateFile = (path: string, content: string) =>
  call<string>("cmd_ide_create_file", { path, content });
/** Create a new directory; returns its canonical path. */
export const ideCreateDir = (path: string) => call<string>("cmd_ide_create_dir", { path });
