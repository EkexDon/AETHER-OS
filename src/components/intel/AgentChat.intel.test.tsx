import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { resetMockState, setMockLatency } from "../../lib/mock/backend";
import { MOCK_VAULT_ROOT } from "../../lib/mock/fixtures/vault";
import { useAetherStore } from "../../lib/store";
import { DEFAULT_INTEL_SETTINGS, useIntelStore } from "../../lib/intelStore";
import { ToastProvider } from "../../ui";
import { AgentChat } from "../AgentChat";

function renderChat() {
  return render(
    <ToastProvider>
      <AgentChat width={360} />
    </ToastProvider>
  );
}

async function send(text: string) {
  const box = screen.getByRole("textbox", { name: "Message the agent" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useIntelStore.setState({
    settings: { ...DEFAULT_INTEL_SETTINGS },
    settingsLoaded: true,
    session: { conversationId: null, messages: [], compaction: null },
    runs: [],
    approvals: [],
    allowRules: [],
    compacting: false,
  });
  useAetherStore.setState({
    agentOutput: "",
    busy: false,
    conversations: [],
    provider: "ollama",
    vaultNotes: [{ path: `${MOCK_VAULT_ROOT}/Welcome.md`, name: "Welcome", mtime: 0 }],
    allNotesInContext: true,
    contextNotes: new Set(),
  });
});

afterEach(() => {
  useIntelStore.getState().denyAll();
  vi.unstubAllEnvs();
});

describe("AgentChat with the intel layer", () => {
  it("asks for approval before running a command and shows its output", async () => {
    renderChat();
    await send("run `pwd`");
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5_000 });
    expect(within(dialog).getByText("pwd")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    const toggle = await screen.findByRole("button", { name: /Output · exit 0/ }, { timeout: 3_000 });
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Command output")).toHaveTextContent(MOCK_VAULT_ROOT);
    // The turn is saved as one session in the history.
    await waitFor(() => expect(useIntelStore.getState().session.conversationId).not.toBeNull());
    expect(useAetherStore.getState().conversations[0].id).toBe(useIntelStore.getState().session.conversationId);
  }, 15_000);

  it("keeps a denied action from running", async () => {
    renderChat();
    await send("please delete the note Quick Capture");
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5_000 });
    fireEvent.click(within(dialog).getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("Denied — nothing was changed")).toBeInTheDocument();
  }, 15_000);

  it("compacts on demand and shows the summary card", async () => {
    const store = useIntelStore.getState();
    for (let i = 0; i < 4; i++) store.appendTurn(`Question ${i}? ${"x ".repeat(200)}`, `Answer ${i}. ${"y ".repeat(200)}`);
    const { container } = renderChat();
    const messages = () => [...container.querySelectorAll(".chat-msg-content")].map((m) => m.textContent ?? "");
    expect(messages().some((m) => m.startsWith("Question 0?"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Compact conversation now" }));
    expect(await screen.findByText("Conversation summary", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(useIntelStore.getState().session.compaction?.compactedCount).toBe(4);
    // Summarised messages are hidden until revealed.
    expect(messages().some((m) => m.startsWith("Question 0?"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Conversation summary/ }));
    fireEvent.click(screen.getByRole("button", { name: /Show 4 earlier/ }));
    expect(messages().some((m) => m.startsWith("Question 0?"))).toBe(true);
  }, 15_000);
});
