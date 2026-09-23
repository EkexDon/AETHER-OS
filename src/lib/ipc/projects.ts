/** Project launcher commands (`src-tauri/src/commands/project_commands.rs`). */
import type { Project } from "../../types";
import { call } from "./core";

/** Find code projects (git repo / package.json / Cargo.toml) under `directories`. */
export const scanProjects = (directories: string[]) => call<Project[]>("cmd_scan_projects", { directories });
/** Open a project in an editor (default: Devin). */
export const openProject = (path: string, editor?: string) => call<void>("cmd_open_project", { path, editor });
/** Open a new system terminal window at `path`. */
export const openInTerminal = (path: string) => call<void>("cmd_open_in_terminal", { path });
/** Reveal `path` in Finder. */
export const openInFinder = (path: string) => call<void>("cmd_open_in_finder", { path });
/** Configured project root directories. */
export const getProjectDirs = () => call<string[]>("cmd_get_project_dirs");
/** Add a project root directory; returns the updated list. */
export const addProjectDir = (dir: string) => call<string[]>("cmd_add_project_dir", { dir });
/** Remove a project root directory; returns the updated list. */
export const removeProjectDir = (dir: string) => call<string[]>("cmd_remove_project_dir", { dir });
