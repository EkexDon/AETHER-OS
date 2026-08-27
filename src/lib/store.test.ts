import { beforeEach, describe, expect, it } from "vitest";
import { useAetherStore } from "./store";

describe("useAetherStore", () => {
  beforeEach(() => {
    useAetherStore.setState({
      vaultPath: null,
      vaultNotes: [],
      vaultStats: null,
      graph: { nodes: [], edges: [] },
      agentOutput: "",
      agentContext: [],
      health: null,
      searchResults: [],
      aetherNotes: [],
      view: "dashboard",
      selectedNotePath: null,
      noteContent: null,
      indexing: false,
      busy: false,
    });
  });

  it("accumulates streamed agent output", () => {
    useAetherStore.getState().appendAgentOutput("hello ");
    useAetherStore.getState().appendAgentOutput("world");
    expect(useAetherStore.getState().agentOutput).toBe("hello world");
  });

  it("switches views", () => {
    useAetherStore.getState().setView("search");
    expect(useAetherStore.getState().view).toBe("search");
  });

  it("tracks agent context paths", () => {
    useAetherStore.getState().setAgentContext(["/vault/note1.md", "/vault/note2.md"]);
    expect(useAetherStore.getState().agentContext).toHaveLength(2);
  });

  it("defaults to the local Ollama provider with its default model", () => {
    const state = useAetherStore.getState();
    expect(state.provider).toBe("ollama");
    expect(state.modelByProvider.ollama).toBe("gemma2:2b");
  });

  it("switching provider keeps each provider's own model", () => {
    useAetherStore.getState().setModelForProvider("openrouter", "anthropic/claude-sonnet-4");
    useAetherStore.getState().setProvider("openrouter");
    expect(useAetherStore.getState().provider).toBe("openrouter");
    expect(useAetherStore.getState().modelByProvider.openrouter).toBe("anthropic/claude-sonnet-4");

    useAetherStore.getState().setProvider("ollama");
    expect(useAetherStore.getState().modelByProvider.ollama).toBe("gemma2:2b");
  });

  it("persists the provider choice across reloads", () => {
    useAetherStore.getState().setProvider("openrouter");
    expect(localStorage.getItem("aether-ai-provider")).toBe("openrouter");
  });

  it("chat panel starts open and persists closing", () => {
    expect(useAetherStore.getState().chatOpen).toBe(true);
    useAetherStore.getState().setChatOpen(false);
    expect(useAetherStore.getState().chatOpen).toBe(false);
    expect(localStorage.getItem("aether-chat-open")).toBe("false");
  });
});
