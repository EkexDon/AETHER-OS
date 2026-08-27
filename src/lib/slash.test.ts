import { describe, expect, it } from "vitest";
import { filterModels, parseSlashInput } from "./slash";

describe("parseSlashInput", () => {
  it("recognizes bare /model with no query", () => {
    expect(parseSlashInput("/model")).toEqual({ command: "model", query: "" });
  });

  it("captures the text after /model", () => {
    expect(parseSlashInput("/model claude")).toEqual({ command: "model", query: "claude" });
  });

  it("ignores partial words like /models", () => {
    expect(parseSlashInput("/models")).toBeNull();
  });

  it("ignores plain text input", () => {
    expect(parseSlashInput("hello world")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });
});

describe("filterModels", () => {
  const models = [
    "anthropic/claude-sonnet-4",
    "anthropic/claude-3.5-haiku",
    "openai/gpt-4o",
    "google/gemini-2.0-flash",
  ];

  it("matches case-insensitively on substring", () => {
    expect(filterModels(models, "CLAUDE")).toEqual([
      "anthropic/claude-sonnet-4",
      "anthropic/claude-3.5-haiku",
    ]);
  });

  it("returns the list unchanged for an empty query", () => {
    expect(filterModels(models, "")).toEqual(models);
  });

  it("caps the result length", () => {
    expect(filterModels(models, "", 2)).toHaveLength(2);
  });
});
