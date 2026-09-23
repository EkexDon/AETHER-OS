/**
 * Mock handlers for `commands/git_commands.rs`. Each fake repository keeps
 * a real three-tree model — HEAD tree, index and the working tree in
 * `mockFs` — so status, stage/unstage/discard, commit, branches, log and
 * diffs stay consistent with each other and with edits made in the IDE.
 */
import type { BranchInfo, CommitInfo, FileDiff, GitChangeKind, GitStatusEntry, RepoStatus } from "../../types";
import { FIXTURE_REPOS, MOCK_PROJECTS_ROOT } from "./fixtures/workspace";
import { mockFs } from "./fsStore";
import {
  argBool,
  argOptNumber,
  argString,
  argStringArray,
  fakeSha,
  isWithin,
  normalizePath,
  nowSeconds,
  registerReset,
  type MockHandlerMap,
} from "./runtime";

interface Commit {
  id: string;
  summary: string;
  author: string;
  time: number;
}

interface Branch {
  commits: Commit[];
  tree: Map<string, string>;
}

interface Repo {
  root: string;
  current: string;
  branches: Map<string, Branch>;
  index: Map<string, string>;
  ahead: number;
  behind: number;
}

let repos = new Map<string, Repo>();

function seed(): void {
  repos = new Map();
  const now = nowSeconds();
  for (const fixture of FIXTURE_REPOS) {
    const root = `${MOCK_PROJECTS_ROOT}/${fixture.name}`;
    const tree = new Map(Object.entries(fixture.head));
    const commits = fixture.commits.map((c, i) => ({
      id: fakeSha(`${fixture.name}:${i}:${c.summary}`),
      summary: c.summary,
      author: c.author,
      time: Math.round(now - c.ageDays * 86_400),
    }));
    const branches = new Map<string, Branch>([[fixture.branch, { commits, tree }]]);
    for (const other of fixture.otherBranches) {
      branches.set(other, { commits: commits.slice(1), tree: new Map(tree) });
    }
    const index = new Map(tree);
    for (const [rel, content] of Object.entries(fixture.staged)) {
      if (content === null) index.delete(rel);
      else index.set(rel, content);
    }
    repos.set(root, {
      root,
      current: fixture.branch,
      branches,
      index,
      ahead: fixture.ahead,
      behind: fixture.behind,
    });
  }
}
seed();
registerReset(seed);

/** Find the repository containing `path` (discovery walks upwards). */
function openRepo(path: string): Repo {
  const p = normalizePath(path);
  for (const repo of repos.values()) if (isWithin(p, repo.root)) return repo;
  throw new Error(`vault error: not a git repository: could not find repository at '${path}'`);
}

function head(repo: Repo): Branch {
  const branch = repo.branches.get(repo.current);
  if (!branch) throw new Error(`vault error: HEAD points at a missing branch: ${repo.current}`);
  return branch;
}

function change(from: string | undefined, to: string | undefined): GitChangeKind | null {
  if (from === undefined && to !== undefined) return "added";
  if (from !== undefined && to === undefined) return "deleted";
  if (from !== undefined && to !== undefined && from !== to) return "modified";
  return null;
}

function normalizeRel(rel: string): string {
  const cleaned = rel.trim().replace(/\\/g, "/");
  if (!cleaned || cleaned.startsWith("/") || cleaned.split("/").some((p) => p === "..")) {
    throw new Error(`invalid input: invalid repository path: ${rel}`);
  }
  return cleaned;
}

/** Current status of the repository containing `path`. */
export function repoStatus(path: string): RepoStatus {
  const repo = openRepo(path);
  const tree = head(repo).tree;
  const working = mockFs.filesUnder(repo.root);
  const paths = new Set([...tree.keys(), ...repo.index.keys(), ...working.keys()]);
  const entries: GitStatusEntry[] = [];
  for (const p of [...paths].sort()) {
    const staged = change(tree.get(p), repo.index.get(p));
    const unstaged = change(repo.index.get(p), working.get(p));
    if (staged || unstaged) entries.push({ path: p, staged, unstaged });
  }
  return {
    branch: repo.current,
    ahead: repo.ahead,
    behind: repo.behind,
    unborn: head(repo).commits.length === 0,
    entries,
  };
}

/** Commits of the current branch, newest first. */
export function repoLog(path: string, limit: number): CommitInfo[] {
  return head(openRepo(path))
    .commits.slice(0, limit)
    .map((c) => ({ id: c.id.slice(0, 7), summary: c.summary, author: c.author, time: c.time }));
}

/** Absolute roots of all fake repositories. */
export function repoRoots(): string[] {
  return [...repos.keys()];
}

export const gitHandlers: MockHandlerMap = {
  cmd_git_status: (args) => repoStatus(argString(args, "path")),
  cmd_git_stage: (args) => {
    const repo = openRepo(argString(args, "path"));
    for (const rel of argStringArray(args, "files").map(normalizeRel)) {
      const abs = `${repo.root}/${rel}`;
      if (mockFs.isFile(abs)) repo.index.set(rel, mockFs.read(abs));
      else repo.index.delete(rel);
    }
  },
  cmd_git_unstage: (args) => {
    const repo = openRepo(argString(args, "path"));
    const tree = head(repo).tree;
    for (const rel of argStringArray(args, "files").map(normalizeRel)) {
      const committed = tree.get(rel);
      if (committed === undefined) repo.index.delete(rel);
      else repo.index.set(rel, committed);
    }
  },
  cmd_git_discard: (args) => {
    const repo = openRepo(argString(args, "path"));
    for (const rel of argStringArray(args, "files").map(normalizeRel)) {
      const indexed = repo.index.get(rel);
      const abs = `${repo.root}/${rel}`;
      if (indexed === undefined) mockFs.remove(abs);
      else mockFs.write(abs, indexed);
    }
  },
  cmd_git_commit: (args) => {
    const repo = openRepo(argString(args, "path"));
    const message = argString(args, "message").trim();
    if (!message) throw new Error("invalid input: commit message must not be empty");
    const branch = head(repo);
    const commit: Commit = {
      id: fakeSha(`${repo.root}:${message}:${Date.now()}:${branch.commits.length}`),
      summary: message.split("\n")[0],
      author: "Demo User",
      time: nowSeconds(),
    };
    branch.commits = [commit, ...branch.commits];
    branch.tree = new Map(repo.index);
    repo.ahead += 1;
    return commit.id;
  },
  cmd_git_branches: (args): BranchInfo[] => {
    const repo = openRepo(argString(args, "path"));
    return [...repo.branches.keys()]
      .map((name) => ({ name, is_current: name === repo.current }))
      .sort((a, b) => Number(b.is_current) - Number(a.is_current) || a.name.localeCompare(b.name));
  },
  cmd_git_switch_branch: (args) => {
    const repo = openRepo(argString(args, "path"));
    const name = argString(args, "branch");
    const target = repo.branches.get(name);
    if (!target) throw new Error(`invalid input: no such branch: ${name}`);
    // Force checkout, like `checkout_head` with `force()` in git_repo.rs.
    for (const rel of head(repo).tree.keys()) {
      if (!target.tree.has(rel)) mockFs.remove(`${repo.root}/${rel}`);
    }
    for (const [rel, content] of target.tree) mockFs.write(`${repo.root}/${rel}`, content);
    repo.current = name;
    repo.index = new Map(target.tree);
  },
  cmd_git_create_branch: (args) => {
    const repo = openRepo(argString(args, "path"));
    const name = argString(args, "branch").trim();
    if (!name) throw new Error("invalid input: branch name must not be empty");
    if (repo.branches.has(name)) {
      throw new Error(`vault error: cannot create branch ${name}: a reference with that name already exists`);
    }
    const current = head(repo);
    if (current.commits.length === 0) throw new Error("invalid input: cannot branch before the first commit");
    repo.branches.set(name, { commits: [...current.commits], tree: new Map(current.tree) });
  },
  cmd_git_log: (args) =>
    repoLog(argString(args, "path"), Math.min(argOptNumber(args, "limit") ?? 50, 500)),
  cmd_git_diff_file: (args): FileDiff => {
    const repo = openRepo(argString(args, "path"));
    const rel = normalizeRel(argString(args, "file"));
    const staged = argBool(args, "staged");
    const abs = `${repo.root}/${rel}`;
    const working = mockFs.isFile(abs) ? mockFs.read(abs) : undefined;
    const oldContent = staged ? head(repo).tree.get(rel) : repo.index.get(rel);
    const newContent = staged ? repo.index.get(rel) : working;
    return { path: rel, old_content: oldContent ?? null, new_content: newContent ?? null, is_binary: false };
  },
};
