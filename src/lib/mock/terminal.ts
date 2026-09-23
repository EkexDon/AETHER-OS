/**
 * Mock handlers for `commands/terminal_commands.rs`: a fake zsh that echoes
 * input, handles backspace/Ctrl-C/Ctrl-L, runs a few harmless built-ins
 * (`ls`, `pwd`, `cd`, `cat`, `git status`, …) against the mock file system
 * and streams everything over `terminal-output` as base64, exactly like the
 * real PTY bridge.
 */
import type { TerminalOutputEvent, TerminalSession } from "../../types";
import { mockFs } from "./fsStore";
import { repoStatus } from "./git";
import {
  argNumber,
  argOptNumber,
  argOptString,
  argString,
  isWithin,
  mockEvents,
  normalizePath,
  registerReset,
  type MockHandlerMap,
} from "./runtime";
import { mockVault } from "./vaultStore";

/** Event name of the real PTY bridge. */
export const TERMINAL_EVENT = "terminal-output";
const HOME = "/Users/demo";
/** Delay before the fake shell prints its banner and first prompt. */
export const SHELL_STARTUP_MS = 250;

interface Session {
  id: string;
  cwd: string;
  shell: string;
  alive: boolean;
  cols: number;
  rows: number;
  line: string;
  history: string[];
}

let sessions = new Map<string, Session>();
let counter = 0;
registerReset(() => {
  sessions = new Map();
  counter = 0;
});

/** UTF-8 → base64, chunked so long outputs do not overflow the call stack. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function emit(session: Session, text: string): void {
  const payload: TerminalOutputEvent = { id: session.id, dataBase64: toBase64(text) };
  mockEvents.emit(TERMINAL_EVENT, payload);
}

function shortCwd(cwd: string): string {
  return cwd === HOME ? "~" : cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
}

function prompt(session: Session): string {
  return `\x1b[1;32mdemo@aether\x1b[0m \x1b[1;34m${shortCwd(session.cwd)}\x1b[0m % `;
}

function listDir(dir: string): string[] | null {
  if (mockVault.root && isWithin(dir, mockVault.root)) {
    if (!mockVault.hasDir(dir)) return null;
    return mockVault.children(dir).map((c) => (c.isDir ? `\x1b[1;34m${c.name}\x1b[0m` : c.name)).sort();
  }
  if (dir === HOME) return ["\x1b[1;34mDeveloper\x1b[0m", "\x1b[1;34mDocuments\x1b[0m", "\x1b[1;34mDownloads\x1b[0m"];
  if (dir === `${HOME}/Documents`) return ["\x1b[1;34mSecond-Brain\x1b[0m"];
  if (dir === `${HOME}/Downloads`) return [];
  if (!mockFs.isDir(dir)) return null;
  return mockFs.children(dir).map((c) => (c.isDir ? `\x1b[1;34m${c.name}\x1b[0m` : c.name)).sort();
}

function isDirectory(dir: string): boolean {
  return listDir(dir) !== null;
}

function readFile(path: string): string | null {
  if (mockVault.root && isWithin(path, mockVault.root)) {
    return mockVault.hasFile(path) ? mockVault.read(path) : null;
  }
  return mockFs.isFile(path) ? mockFs.read(path) : null;
}

function resolve(session: Session, target: string): string {
  if (!target || target === "~") return HOME;
  if (target.startsWith("~/")) return normalizePath(`${HOME}/${target.slice(2)}`);
  return normalizePath(target.startsWith("/") ? target : `${session.cwd}/${target}`);
}

/** Run one command line; returns the output (without the next prompt). */
function runCommand(session: Session, line: string): string {
  const [cmd = "", ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  const nl = (lines: string[]) => (lines.length ? `${lines.join("\r\n")}\r\n` : "");
  switch (cmd) {
    case "":
      return "";
    case "help":
      return nl([
        "AETHER mock shell — available commands:",
        "  ls [dir]  cd <dir>  pwd  cat <file>  echo <text>  date  whoami",
        "  uname -a  git status  history  clear  exit",
      ]);
    case "pwd":
      return nl([session.cwd]);
    case "whoami":
      return nl(["demo"]);
    case "date":
      return nl([new Date().toString()]);
    case "echo":
      return nl([arg.replace(/^["']|["']$/g, "")]);
    case "uname":
      return nl([arg.includes("-a") ? "Darwin aether.local 25.0.0 Darwin Kernel Version 25.0.0 arm64" : "Darwin"]);
    case "history":
      return nl(session.history.map((h, i) => `  ${String(i + 1).padStart(3)}  ${h}`));
    case "clear":
      return "\x1b[2J\x1b[H";
    case "ls": {
      const dir = resolve(session, rest.find((r) => !r.startsWith("-")) ?? "");
      const entries = listDir(dir);
      if (entries === null) return nl([`ls: ${arg}: No such file or directory`]);
      return entries.length ? nl([entries.join("  ")]) : "";
    }
    case "cd": {
      const dir = resolve(session, arg);
      if (!isDirectory(dir)) return nl([`cd: no such file or directory: ${arg}`]);
      session.cwd = dir;
      return "";
    }
    case "cat": {
      if (!arg) return nl(["cat: missing file operand"]);
      const content = readFile(resolve(session, arg));
      if (content === null) return nl([`cat: ${arg}: No such file or directory`]);
      return nl(content.replace(/\n$/, "").split("\n"));
    }
    case "git": {
      if (rest[0] !== "status") return nl([`git: '${rest[0] ?? ""}' is not supported in the mock shell`]);
      try {
        const status = repoStatus(session.cwd);
        const lines = [`On branch ${status.branch}`];
        if (status.entries.length === 0) lines.push("nothing to commit, working tree clean");
        for (const e of status.entries) {
          const letter = (kind: string | null) => (kind ? kind[0].toUpperCase() : " ");
          const code = !e.staged && e.unstaged === "added" ? "??" : `${letter(e.staged)}${letter(e.unstaged)}`;
          lines.push(` ${code} ${e.path}`);
        }
        return nl(lines);
      } catch {
        return nl(["fatal: not a git repository (or any of the parent directories): .git"]);
      }
    }
    default:
      return nl([`zsh: command not found: ${cmd}`]);
  }
}

function requireSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new Error(`invalid input: Session ${id} not found`);
  return session;
}

/** Feed keyboard input into a session (echo + line editing). */
function handleInput(session: Session, data: string): void {
  let out = "";
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "\x1b") {
      // Skip CSI/SS3 escape sequences (arrow keys etc.).
      const m = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(data.slice(i));
      i += m ? m[0].length - 1 : 0;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const line = session.line;
      session.line = "";
      out += "\r\n";
      if (line.trim()) session.history.push(line.trim());
      if (line.trim() === "exit") {
        session.alive = false;
        out += "\r\n[Process completed]\r\n";
        break;
      }
      out += runCommand(session, line) + prompt(session);
    } else if (ch === "\x7f" || ch === "\b") {
      if (session.line.length > 0) {
        session.line = session.line.slice(0, -1);
        out += "\b \b";
      }
    } else if (ch === "\x03") {
      session.line = "";
      out += `^C\r\n${prompt(session)}`;
    } else if (ch === "\x0c") {
      out += `\x1b[2J\x1b[H${prompt(session)}${session.line}`;
    } else if (ch === "\t") {
      continue;
    } else if (ch >= " ") {
      session.line += ch;
      out += ch;
    }
  }
  if (out) emit(session, out);
}

export const terminalHandlers: MockHandlerMap = {
  cmd_terminal_spawn: (args): TerminalSession => {
    counter += 1;
    const cwdArg = argOptString(args, "cwd");
    const session: Session = {
      id: `mock-pty-${counter}`,
      cwd: cwdArg ? normalizePath(cwdArg) : HOME,
      shell: argOptString(args, "shell") ?? "/bin/zsh",
      alive: true,
      cols: argOptNumber(args, "cols") ?? 80,
      rows: argOptNumber(args, "rows") ?? 24,
      line: "",
      history: [],
    };
    sessions.set(session.id, session);
    // Like a real shell, the banner arrives a moment after spawn returns
    // (zsh needs a few hundred ms to start), once the view has bound the id.
    setTimeout(() => {
      if (!session.alive) return;
      emit(
        session,
        `Last login: ${new Date().toDateString()} on ttys00${counter}\r\n` +
          `\x1b[90mAETHER mock shell — type \x1b[1mhelp\x1b[22m for commands.\x1b[0m\r\n${prompt(session)}`
      );
    }, SHELL_STARTUP_MS);
    return { id: session.id, cwd: session.cwd, shell: session.shell, alive: true };
  },
  cmd_terminal_write: (args) => {
    const session = requireSession(argString(args, "id"));
    const data = argString(args, "data");
    if (!session.alive) throw new Error(`invalid input: Session ${session.id} has exited`);
    // Process asynchronously so output arrives after `write` resolves.
    setTimeout(() => handleInput(session, data), 5);
  },
  cmd_terminal_resize: (args) => {
    const session = requireSession(argString(args, "id"));
    session.cols = argNumber(args, "cols");
    session.rows = argNumber(args, "rows");
  },
  cmd_terminal_kill: (args) => {
    const session = requireSession(argString(args, "id"));
    session.alive = false;
    sessions.delete(session.id);
  },
  cmd_terminal_list: (): TerminalSession[] =>
    [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, shell: s.shell, alive: s.alive })),
};
