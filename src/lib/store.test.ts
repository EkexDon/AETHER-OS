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
});
