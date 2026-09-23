/**
 * Seed file trees for the mock IDE, project scanner and git mock: four
 * small repositories under the demo project directory. `head` is the
 * committed content; `working` overrides describe uncommitted edits so the
 * Source Control view has something to show.
 */

/** The configured project root directory of the demo user. */
export const MOCK_PROJECTS_ROOT = "/Users/demo/Developer";

/** Seed commit of a fake repository. */
export interface FixtureCommit {
  summary: string;
  author: string;
  /** Days before now. */
  ageDays: number;
}

/** One fake repository. */
export interface FixtureRepo {
  name: string;
  language: string;
  branch: string;
  otherBranches: string[];
  ahead: number;
  behind: number;
  /** Committed files (repo-relative path → content). */
  head: Record<string, string>;
  /** Staged changes (index differs from HEAD); `null` = staged deletion. */
  staged: Record<string, string | null>;
  /** Working tree edits on top of the index; `null` = deleted locally. */
  working: Record<string, string | null>;
  /** Newest first. */
  commits: FixtureCommit[];
}

const APP_TSX = `import { useState } from "react";
import { formatDuration } from "./utils/format";
import { TaskList } from "./components/TaskList";

export function App() {
  const [elapsed, setElapsed] = useState(0);
  return (
    <main className="app">
      <h1>Focus timer</h1>
      <p>{formatDuration(elapsed)}</p>
      <button onClick={() => setElapsed((s) => s + 60)}>+1 min</button>
      <TaskList />
    </main>
  );
}
`;

const APP_TSX_EDITED = APP_TSX.replace(
  '<button onClick={() => setElapsed((s) => s + 60)}>+1 min</button>',
  '<button onClick={() => setElapsed((s) => s + 60)}>+1 min</button>\n      <button onClick={() => setElapsed(0)}>Reset</button>'
);

const README = `# aether-demo-app

A tiny focus timer used to demo the AETHER-OS IDE.

## Scripts
- \`npm run dev\` — start Vite
- \`npm test\` — run Vitest
`;

/** The four demo repositories. */
export const FIXTURE_REPOS: FixtureRepo[] = [
  {
    name: "aether-demo-app",
    language: "typescript",
    branch: "main",
    otherBranches: ["feature/reset-button", "chore/deps"],
    ahead: 2,
    behind: 0,
    head: {
      "package.json": `{
  "name": "aether-demo-app",
  "private": true,
  "version": "0.3.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build", "test": "vitest run" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": { "typescript": "^5.7.2", "vite": "^6.0.3", "vitest": "^2.1.8" }
}
`,
      "tsconfig.json": `{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "jsx": "react-jsx", "strict": true },
  "include": ["src"]
}
`,
      "README.md": README,
      "index.html": `<!doctype html>
<html lang="en">
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
      "src/App.tsx": APP_TSX,
      "src/styles.css": `.app {
  font-family: system-ui, sans-serif;
  max-width: 40rem;
  margin: 4rem auto;
}
`,
      "src/utils/format.ts": `/** Format seconds as mm:ss. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return \`\${String(minutes).padStart(2, "0")}:\${String(seconds).padStart(2, "0")}\`;
}
`,
      "src/components/TaskList.tsx": `const TASKS = ["Write intro", "Review PR", "Plan sprint"];

export function TaskList() {
  return (
    <ul>
      {TASKS.map((task) => (
        <li key={task}>{task}</li>
      ))}
    </ul>
  );
}
`,
    },
    staged: {
      "README.md": `${README}\n## Keyboard shortcuts\n- Space — start/stop\n`,
    },
    working: {
      "src/App.tsx": APP_TSX_EDITED,
      "src/utils/format.test.ts": `import { describe, expect, it } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("pads minutes and seconds", () => {
    expect(formatDuration(65)).toBe("01:05");
  });
});
`,
    },
    commits: [
      { summary: "Add task list component", author: "Demo User", ageDays: 0.2 },
      { summary: "Format elapsed time as mm:ss", author: "Demo User", ageDays: 1 },
      { summary: "Style the main layout", author: "Mara Klein", ageDays: 2 },
      { summary: "Set up Vite + React + TypeScript", author: "Demo User", ageDays: 5 },
      { summary: "Initial commit", author: "Demo User", ageDays: 6 },
    ],
  },
  {
    name: "ferris-notes",
    language: "rust",
    branch: "main",
    otherBranches: ["feat/tags"],
    ahead: 0,
    behind: 1,
    head: {
      "Cargo.toml": `[package]
name = "ferris-notes"
version = "0.1.0"
edition = "2021"

[dependencies]
clap = { version = "4", features = ["derive"] }
`,
      "README.md": "# ferris-notes\n\nA command line note taker written in Rust.\n",
      "src/main.rs": `use clap::Parser;

/// Append a note to ~/notes.md
#[derive(Parser)]
struct Args {
    /// The note text
    text: Vec<String>,
}

fn main() {
    let args = Args::parse();
    println!("noted: {}", args.text.join(" "));
}
`,
    },
    staged: {},
    working: {},
    commits: [
      { summary: "Parse arguments with clap", author: "Demo User", ageDays: 3 },
      { summary: "Initial commit", author: "Demo User", ageDays: 9 },
    ],
  },
  {
    name: "data-pipeline",
    language: "python",
    branch: "develop",
    otherBranches: ["main"],
    ahead: 0,
    behind: 0,
    head: {
      "requirements.txt": "pandas==2.2.3\nrequests==2.32.3\n",
      "README.md": "# data-pipeline\n\nNightly import of sensor data into DuckDB.\n",
      "pipeline/__init__.py": "",
      "pipeline/fetch.py": `import requests


def fetch(url: str) -> list[dict]:
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    return response.json()
`,
    },
    staged: {},
    working: {
      "pipeline/fetch.py": `import requests

TIMEOUT_SECONDS = 15


def fetch(url: str) -> list[dict]:
    response = requests.get(url, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()
`,
    },
    commits: [
      { summary: "Fetch sensor data over HTTP", author: "Priya Nair", ageDays: 12 },
      { summary: "Initial commit", author: "Priya Nair", ageDays: 30 },
    ],
  },
  {
    name: "homelab-dns",
    language: "go",
    branch: "feature/dnssec",
    otherBranches: ["main"],
    ahead: 1,
    behind: 3,
    head: {
      "go.mod": "module github.com/demo/homelab-dns\n\ngo 1.23\n",
      "README.md": "# homelab-dns\n\nTiny DNS forwarder with a blocklist for the home lab.\n",
      "main.go": `package main

import "fmt"

func main() {
	fmt.Println("homelab-dns listening on :53")
}
`,
    },
    staged: {},
    working: {},
    commits: [
      { summary: "WIP: validate DNSSEC signatures", author: "Demo User", ageDays: 20 },
      { summary: "Add blocklist loader", author: "Demo User", ageDays: 26 },
      { summary: "Initial commit", author: "Demo User", ageDays: 41 },
    ],
  },
];
