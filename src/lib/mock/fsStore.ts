/**
 * In-memory file system for the demo project directory. The IDE mock reads
 * and writes it, the git mock treats it as the working tree of each fake
 * repository. (Paths inside the vault are served by `vaultStore` instead.)
 */
import { FIXTURE_REPOS, MOCK_PROJECTS_ROOT } from "./fixtures/workspace";
import { isWithin, normalizePath, registerReset } from "./runtime";

/** A directory entry as the IDE mock needs it. */
export interface MockFsChild {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

/** Map-backed file tree with implicit parent directories. */
export class MockFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  constructor() {
    this.seed();
  }

  /** Restore the four demo repositories (working trees incl. local edits). */
  seed(): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add(MOCK_PROJECTS_ROOT);
    for (const repo of FIXTURE_REPOS) {
      const root = `${MOCK_PROJECTS_ROOT}/${repo.name}`;
      this.dirs.add(root);
      const tree: Record<string, string | null> = { ...repo.head, ...repo.staged, ...repo.working };
      for (const [rel, content] of Object.entries(tree)) {
        if (content !== null) this.files.set(`${root}/${rel}`, content);
      }
    }
  }

  /** True when a file exists at `path`. */
  isFile(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** True for explicit directories and parents of existing entries. */
  isDir(path: string): boolean {
    const p = normalizePath(path);
    if (this.dirs.has(p)) return true;
    const prefix = `${p}/`;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true;
    for (const dir of this.dirs) if (dir.startsWith(prefix)) return true;
    return false;
  }

  /** File content, or throws like `std::fs::read_to_string`. */
  read(path: string): string {
    const content = this.files.get(normalizePath(path));
    if (content === undefined) throw new Error(`I/O error: No such file or directory (os error 2)`);
    return content;
  }

  /** Create or overwrite a file. */
  write(path: string, content: string): void {
    this.files.set(normalizePath(path), content);
  }

  /** Remove a file; returns whether it existed. */
  remove(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  /** Register a directory. */
  mkdir(path: string): void {
    this.dirs.add(normalizePath(path));
  }

  /** Direct children of `dir`. */
  children(dir: string): MockFsChild[] {
    const prefix = `${normalizePath(dir)}/`;
    const out = new Map<string, MockFsChild>();
    const consider = (path: string, isFile: boolean) => {
      if (!path.startsWith(prefix)) return;
      const [head, ...tail] = path.slice(prefix.length).split("/");
      if (!head) return;
      const childPath = `${prefix}${head}`;
      if (out.has(childPath)) return;
      const isDir = tail.length > 0 || !isFile;
      out.set(childPath, {
        name: head,
        path: childPath,
        isDir,
        size: isDir ? 0 : new TextEncoder().encode(this.files.get(path) ?? "").length,
      });
    };
    for (const key of this.files.keys()) consider(key, true);
    for (const d of this.dirs) consider(d, false);
    return [...out.values()];
  }

  /** All files below `root` as repo-relative path → content. */
  filesUnder(root: string): Map<string, string> {
    const base = normalizePath(root);
    const out = new Map<string, string>();
    for (const [path, content] of this.files) {
      if (path !== base && isWithin(path, base)) out.set(path.slice(base.length + 1), content);
    }
    return out;
  }
}

/** The shared mock file system. */
export const mockFs = new MockFs();
registerReset(() => mockFs.seed());
