/** Mock handlers for `commands/project_commands.rs`: four fake repositories
 *  under the demo project directory, with git info from the git mock. */
import type { Project } from "../../types";
import { FIXTURE_REPOS, MOCK_PROJECTS_ROOT } from "./fixtures/workspace";
import { repoLog, repoStatus } from "./git";
import { argString, argStringArray, isWithin, normalizePath, registerReset, type MockHandlerMap } from "./runtime";
import { editorNameProblem } from "../editors";

let projectDirs: string[] = [MOCK_PROJECTS_ROOT];
registerReset(() => {
  projectDirs = [MOCK_PROJECTS_ROOT];
});

/** Configured project directories (the IDE sandbox roots use them too). */
export function getMockProjectDirs(): string[] {
  return [...projectDirs];
}

function describeStatus(path: string): string {
  const entries = repoStatus(path).entries;
  if (entries.length === 0) return "clean";
  const untracked = entries.filter((e) => e.staged === null && e.unstaged === "added").length;
  const modified = entries.length - untracked;
  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} modified`);
  if (untracked > 0) parts.push(`${untracked} untracked`);
  return parts.join(", ");
}

/** Like `cmd_scan_projects`: projects below any of `directories`. */
export function scanMockProjects(directories: string[]): Project[] {
  const seen = new Set<string>();
  const projects: Project[] = [];
  for (const dir of directories.map((d) => normalizePath(d))) {
    for (const repo of FIXTURE_REPOS) {
      const path = `${MOCK_PROJECTS_ROOT}/${repo.name}`;
      if (!isWithin(path, dir) || seen.has(path)) continue;
      seen.add(path);
      const [last] = repoLog(path, 1);
      projects.push({
        name: repo.name,
        path,
        git_branch: repoStatus(path).branch,
        git_status: describeStatus(path),
        last_commit_msg: last?.summary ?? null,
        last_commit_date: last?.time ?? null,
        language: repo.language,
      });
    }
  }
  return projects.sort((a, b) => (b.last_commit_date ?? 0) - (a.last_commit_date ?? 0));
}

const opened = (what: string, path: string) => {
  if (!path.trim()) throw new Error(`Failed to ${what}: empty path`);
  console.info(`[mock] ${what}: ${path}`);
};

export const projectsHandlers: MockHandlerMap = {
  // Like Rust: only directories inside a configured project folder are scanned; others are skipped.
  cmd_scan_projects: (args) =>
    scanMockProjects(
      argStringArray(args, "directories").filter((d) => projectDirs.some((root) => isWithin(normalizePath(d), normalizePath(root))))
    ),
  cmd_open_project: (args) => {
    const editor = typeof args.editor === "string" ? args.editor : "devin";
    const problem = editorNameProblem(editor);
    const known = ["devin", "windsurf", "cursor", "code"].includes(editor.trim().toLowerCase());
    if (!known && problem) throw new Error(`invalid editor application name: ${JSON.stringify(editor)}`);
    return opened(`open -a ${editor}`, argString(args, "path"));
  },
  cmd_open_in_terminal: (args) => opened("open Terminal", argString(args, "path")),
  cmd_open_in_finder: (args) => opened("open Finder", argString(args, "path")),
  cmd_get_project_dirs: () => getMockProjectDirs(),
  cmd_add_project_dir: (args) => {
    const dir = argString(args, "dir");
    if (!projectDirs.includes(dir)) projectDirs.push(dir);
    return getMockProjectDirs();
  },
  cmd_remove_project_dir: (args) => {
    const dir = argString(args, "dir");
    projectDirs = projectDirs.filter((d) => d !== dir);
    return getMockProjectDirs();
  },
};
