import { describe, expect, it } from "vitest";
import bundled from "../../../CHANGELOG.md?raw";
import { parseChangelog, releaseNotesFor } from "./changelog";

const SAMPLE = `# Changelog

Intro text that is not a section.

## Unreleased

- Work in progress

## [0.2.0] - 2026-10-01

### Added

- Setup wizard

\`\`\`md
## not a heading inside a fence
\`\`\`

## v0.1.0 (2026-06-01)

- First release

## 0.0.9

`;

describe("changelog parser", () => {
  it("splits sections with versions and dates, ignoring fenced headings", () => {
    const sections = parseChangelog(SAMPLE);
    expect(sections.map((s) => [s.version, s.date])).toEqual([
      ["Unreleased", null],
      ["0.2.0", "2026-10-01"],
      ["0.1.0", "2026-06-01"],
      ["0.0.9", null],
    ]);
    expect(sections[1].body).toContain("### Added");
    expect(sections[1].body).toContain("## not a heading inside a fence");
  });

  it("picks the running version, then Unreleased, then the newest release", () => {
    expect(releaseNotesFor(SAMPLE, "0.2.0")?.body).toContain("Setup wizard");
    expect(releaseNotesFor(SAMPLE, "v0.1.0")?.body).toBe("- First release");
    expect(releaseNotesFor(SAMPLE, "0.3.0")?.version).toBe("Unreleased");
    const noUnreleased = SAMPLE.replace("## Unreleased\n\n- Work in progress\n", "");
    expect(releaseNotesFor(noUnreleased, "0.3.0")?.version).toBe("0.2.0");
    // Empty sections never win.
    expect(releaseNotesFor("## 0.0.9\n\n", "0.0.9")).toBeNull();
    expect(releaseNotesFor("", "0.1.0")).toBeNull();
  });

  it("finds content in the bundled CHANGELOG.md", () => {
    const notes = releaseNotesFor(bundled, "999.0.0");
    expect(notes).not.toBeNull();
    expect(notes?.body.length).toBeGreaterThan(0);
  });
});
