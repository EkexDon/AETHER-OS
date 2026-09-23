import { beforeAll, describe, expect, it } from "vitest";

// Vitest stubs CSS imports (even `?raw`), so the entry is read from disk.
interface FsLike {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}

let entry = "";
let viewSheets: string[] = [];

const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as FsLike;
  // Vitest runs from the project root.
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  entry = fs.readFileSync(`${cwd}/src/styles/index.css`, "utf8");
  viewSheets = fs.readdirSync(`${cwd}/src/styles/views`).filter((f) => f.endsWith(".css"));
});

describe("stylesheet entry", () => {
  it("imports every view stylesheet exactly once", () => {
    expect(viewSheets.length).toBeGreaterThan(20);
    for (const sheet of viewSheets) {
      const count = entry.split(`@import "./views/${sheet}";`).length - 1;
      expect(count, sheet).toBe(1);
    }
    expect(entry).not.toContain("command-bar.css");
  });

  it("is the only place view stylesheets are imported from", () => {
    const offenders = Object.entries(sources)
      .filter(([, code]) => /import\s+["'][^"']*styles\/views\/[^"']+\.css["']/.test(code))
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("loads no fonts or styles from a CDN", () => {
    expect(entry).not.toMatch(/https?:\/\//);
  });
});
