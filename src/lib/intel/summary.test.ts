import { describe, expect, it } from "vitest";
import { conversationTitle, isCompactionSummary, parseSummary, summaryItemCount } from "./summary";

const SUMMARY = [
  "Topic: Moving to Berlin",
  "Facts:",
  "- Moving in October",
  "- Needs a van",
  "Decisions:",
  "- none",
  "Open questions:",
  "- Which internet provider?",
  "User preferences:",
  "- Short answers",
].join("\n");

describe("compaction summaries", () => {
  it("recognises the compaction format", () => {
    expect(isCompactionSummary(SUMMARY)).toBe(true);
    expect(isCompactionSummary("What should I focus on today?")).toBe(false);
    expect(isCompactionSummary("Topic: but no sections")).toBe(false);
    expect(isCompactionSummary("")).toBe(false);
    expect(isCompactionSummary(null)).toBe(false);
  });

  it("parses topic and sections, dropping none placeholders", () => {
    const parsed = parseSummary(SUMMARY);
    expect(parsed.topic).toBe("Moving to Berlin");
    expect(parsed.sections.map((s) => s.items.length)).toEqual([2, 0, 1, 1]);
    expect(parsed.sections[2].items[0]).toBe("Which internet provider?");
    expect(summaryItemCount(parsed)).toBe(4);
  });

  it("treats bullets before any heading as facts", () => {
    const parsed = parseSummary("- loose fact\n- another");
    expect(parsed.topic).toBeNull();
    expect(parsed.sections[0].items).toEqual(["loose fact", "another"]);
  });

  it("derives history titles", () => {
    expect(conversationTitle(SUMMARY)).toBe("Moving to Berlin");
    expect(conversationTitle("What should I focus on today?")).toBe("What should I focus on today?");
    expect(conversationTitle("")).toBe("Conversation");
    const long = "x".repeat(200);
    expect(Array.from(conversationTitle(long)).length).toBe(81);
  });
});
