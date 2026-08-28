import { describe, it, expect } from "vitest";
import { supportsAgentActions } from "./agentModelSupport";

describe("supportsAgentActions", () => {
  it("returns true for known-good Ollama models", () => {
    expect(supportsAgentActions("llama3.1:8b", "ollama")).toBe(true);
    expect(supportsAgentActions("qwen2.5:7b", "ollama")).toBe(true);
    expect(supportsAgentActions("mistral-nemo:12b", "ollama")).toBe(true);
  });

  it("returns true for known-good cloud models", () => {
    expect(supportsAgentActions("openai/gpt-4o-mini", "openrouter")).toBe(true);
    expect(supportsAgentActions("anthropic/claude-3.5-sonnet", "openrouter")).toBe(true);
    expect(supportsAgentActions("google/gemini-2.0-flash", "openrouter")).toBe(true);
  });

  it("returns false for known-bad small models", () => {
    expect(supportsAgentActions("tinyllama:1.1b", "ollama")).toBe(false);
    expect(supportsAgentActions("qwen:0.5b", "ollama")).toBe(false);
    expect(supportsAgentActions("gemma:2b", "ollama")).toBe(false);
  });

  it("defaults to true for unclassified models (assumed yes)", () => {
    // We don't want to block UX for unknown models; the worst case is
    // the model ignores the instruction and the agent falls back to chat.
    expect(supportsAgentActions("somebrand/totally-new:7b", "openrouter")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(supportsAgentActions("LLAMA3.1:8B", "ollama")).toBe(true);
    expect(supportsAgentActions("Anthropic/Claude-3.5-Sonnet", "openrouter")).toBe(true);
  });
});
