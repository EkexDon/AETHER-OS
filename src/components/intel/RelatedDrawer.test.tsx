import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetMockState, setMockLatency } from "../../lib/mock/backend";
import { MOCK_VAULT_ROOT } from "../../lib/mock/fixtures/vault";
import { mockVault } from "../../lib/mock/vaultStore";
import { useAetherStore } from "../../lib/store";
import { DEFAULT_INTEL_SETTINGS, useIntelStore } from "../../lib/intelStore";
import { RELATED_DEBOUNCE_MS } from "../../lib/intel/related";
import { ToastProvider } from "../../ui";
import { RelatedStatusItem } from "./RelatedStatusItem";
import { RelatedContextChip } from "./RelatedContextChip";

const NOTE = `${MOCK_VAULT_ROOT}/03-Resources/Rust Ownership.md`;

function renderItem() {
  return render(
    <ToastProvider>
      <RelatedStatusItem />
      <RelatedContextChip />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  useIntelStore.setState({ settings: { ...DEFAULT_INTEL_SETTINGS }, settingsLoaded: true, related: {}, relatedOpen: false });
  useAetherStore.setState({
    view: "editor",
    selectedNotePath: NOTE,
    openNoteTabs: [NOTE],
    noteContent: mockVault.read(NOTE),
    noteDirty: false,
    allNotesInContext: true,
    contextNotes: new Set(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function loadSuggestions() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderItem();
  await act(async () => {
    vi.advanceTimersByTime(RELATED_DEBOUNCE_MS + 10);
  });
  vi.useRealTimers();
  await waitFor(() => expect(useIntelStore.getState().related[NOTE]?.loading).toBe(false));
}

describe("Related notes", () => {
  it("computes suggestions after the debounce and shows the status chip", async () => {
    await loadSuggestions();
    const entry = useIntelStore.getState().related[NOTE];
    expect(entry.suggestions.length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: /related$/ })).toBeInTheDocument();
  });

  it("hides the chip outside the editor", () => {
    useAetherStore.setState({ view: "dashboard" });
    renderItem();
    expect(screen.queryByRole("button", { name: /related/ })).toBeNull();
  });

  it("opens the drawer, inserts a link at the end of the note and adds tags", async () => {
    await loadSuggestions();
    fireEvent.click(screen.getByRole("button", { name: /\d+ related$/ }));
    expect(await screen.findByRole("complementary", { name: "Related notes" })).toBeInTheDocument();

    const first = useIntelStore.getState().related[NOTE].suggestions.find((s) => !s.linked);
    expect(first).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: `Insert link to ${first!.name} at the end of the note` }));
    await waitFor(() => expect(mockVault.read(NOTE)).toContain(`[[${first!.name}]]`));
    expect(mockVault.read(NOTE).trimEnd().endsWith(`[[${first!.name}]]`)).toBe(true);

    const tags = useIntelStore.getState().related[NOTE].tags;
    if (tags.length > 0) {
      // The editor reload after the link insert briefly deselects the note.
      fireEvent.click(await screen.findByRole("button", { name: `Add tag ${tags[0]}` }));
      await waitFor(() => expect(useIntelStore.getState().related[NOTE].tags).not.toContain(tags[0]));
    }
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useIntelStore.getState().relatedOpen).toBe(false));
  });

  it("focuses the chat context on the note and its related notes", async () => {
    await loadSuggestions();
    const chip = screen.getByRole("button", { name: /^Use Rust Ownership and \d+ related notes? as context$/ });
    const related = useIntelStore.getState().related[NOTE].suggestions.slice(0, 5).map((s) => s.path);
    fireEvent.click(chip);
    const { contextNotes, allNotesInContext } = useAetherStore.getState();
    expect(allNotesInContext).toBe(false);
    expect([...contextNotes].sort()).toEqual([NOTE, ...related].sort());
    fireEvent.click(screen.getByRole("button", { name: "Back to all notes as context" }));
    expect(useAetherStore.getState().allNotesInContext).toBe(true);
  });
});
