/**
 * Mock handlers for `commands/ide_commands.rs`. The sandbox roots are the
 * configured project dirs plus the vault; project files live in `mockFs`,
 * vault files are served by `mockVault`, so edits in the IDE show up in the
 * editor, graph and git status alike.
 */
import type { FsEntry } from "../../types";
import { mockFs, type MockFsChild } from "./fsStore";
import { getMockProjectDirs } from "./projects";
import { argString, basename, dirname, isWithin, normalizePath, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

const IGNORED_DIRS = new Set(["node_modules", ".git", "target", "dist", ".next", "__pycache__"]);

/** Sandbox roots, like `workspace()` in ide_commands.rs. */
export function ideRoots(): string[] {
  const roots = getMockProjectDirs().map((d) => normalizePath(d));
  if (mockVault.root) roots.push(mockVault.root);
  return [...new Set(roots)];
}

function inVault(path: string): boolean {
  return mockVault.root !== null && isWithin(path, mockVault.root);
}

/** Resolve `path` inside a root; rejects escapes like `Workspace::resolve`. */
export function resolveInside(path: string): string {
  const p = normalizePath(path);
  if (!ideRoots().some((root) => isWithin(p, root))) {
    throw new Error(`invalid input: path is outside the allowed project directories: ${p}`);
  }
  return p;
}

function exists(path: string): { file: boolean; dir: boolean } {
  if (inVault(path)) return { file: mockVault.hasFile(path), dir: mockVault.hasDir(path) };
  return { file: mockFs.isFile(path), dir: mockFs.isDir(path) };
}

/** Resolve an existing path inside the sandbox. */
export function resolveExisting(path: string): string {
  const p = resolveInside(path);
  const e = exists(p);
  if (!e.file && !e.dir) throw new Error(`invalid input: no such path: ${path}`);
  return p;
}

function resolveNew(path: string): string {
  const p = resolveInside(path);
  const parent = dirname(p);
  if (!basename(p)) throw new Error(`invalid input: path has no file name: ${path}`);
  if (!exists(parent).dir) throw new Error(`invalid input: parent directory does not exist: ${parent}`);
  return p;
}

function toEntries(children: MockFsChild[]): FsEntry[] {
  return children
    .filter((c) => !(c.isDir && IGNORED_DIRS.has(c.name)))
    .map((c) => ({ name: c.name, path: c.path, is_dir: c.isDir, size: c.size }))
    .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export const ideHandlers: MockHandlerMap = {
  cmd_ide_roots: () => ideRoots(),
  cmd_ide_list_dir: (args) => {
    const dir = resolveExisting(argString(args, "path"));
    if (!exists(dir).dir) throw new Error(`invalid input: not a directory: ${dir}`);
    return toEntries(inVault(dir) ? mockVault.children(dir) : mockFs.children(dir));
  },
  cmd_ide_read_file: (args) => {
    const file = resolveExisting(argString(args, "path"));
    if (exists(file).dir) throw new Error(`invalid input: cannot open a directory as a file: ${file}`);
    return inVault(file) ? mockVault.read(file) : mockFs.read(file);
  },
  cmd_ide_write_file: (args) => {
    const file = resolveExisting(argString(args, "path"));
    const content = argString(args, "content");
    if (exists(file).dir) throw new Error(`invalid input: cannot write over a directory: ${file}`);
    if (inVault(file)) mockVault.write(file, content);
    else mockFs.write(file, content);
  },
  cmd_ide_create_file: (args) => {
    const file = resolveNew(argString(args, "path"));
    const content = argString(args, "content");
    if (exists(file).file || exists(file).dir) throw new Error(`invalid input: file already exists: ${file}`);
    if (inVault(file)) mockVault.write(file, content);
    else mockFs.write(file, content);
    return file;
  },
  cmd_ide_create_dir: (args) => {
    const dir = resolveNew(argString(args, "path"));
    if (exists(dir).file || exists(dir).dir) throw new Error(`invalid input: directory already exists: ${dir}`);
    if (inVault(dir)) mockVault.addDir(dir);
    else mockFs.mkdir(dir);
    return dir;
  },
};
