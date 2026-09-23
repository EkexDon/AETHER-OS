import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../../lib/commands/registry";
import { mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import { DEFAULT_PREFS, useOnboardingStore } from "../../lib/onboardingStore";
import { initialWizardState } from "../../lib/onboarding/wizard";
import { useAetherStore } from "../../lib/store";
import type { OnboardingState } from "../../types";
import { OnboardingWizard } from "./OnboardingWizard";
import { OllamaStatusItem } from "./OllamaStatusItem";
import { OllamaGuideModal } from "./OllamaGuideModal";
import { WhatsNewModal } from "./WhatsNewModal";

const ONLINE = { ollama_online: true, openrouter_configured: false, vault_connected: false };

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useOnboardingStore.setState({
    prefs: { ...DEFAULT_PREFS },
    wizardOpen: false,
    wizardMinimized: false,
    wizard: initialWizardState(),
    whatsNewOpen: false,
    ollamaGuideOpen: false,
    installedModels: null,
    pulls: {},
  });
  useAetherStore.setState({
    view: "editor",
    vaultPath: null,
    vaultStats: null,
    vaultNotes: [],
    health: ONLINE,
    provider: "ollama",
    modelByProvider: { ollama: "gemma2:2b", openrouter: "anthropic/claude-sonnet-4" },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OnboardingWizard", () => {
  it("walks from welcome through the vault step with the keyboard and buttons", async () => {
    useOnboardingStore.getState().openWizard({ restart: true });
    render(<OnboardingWizard />);

    expect(screen.getByRole("heading", { name: "Welcome to AETHER-OS" })).toBeInTheDocument();
    expect(screen.getByText(/Local-first by design/)).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 6")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Connect your notes" })).toBeInTheDocument();
    // Without a vault, Continue is disabled but the step can be skipped.
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();

    // Detected vaults come from the backend.
    const row = (await screen.findByText("Obsidian Vault")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(useAetherStore.getState().vaultPath).toBe("/Users/demo/Documents/Obsidian Vault"));
    expect(await screen.findByText(/Connected to/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled());

    // ← goes back, → continues (outside text fields).
    const layout = document.querySelector(".ob-wizard-layout") as HTMLElement;
    fireEvent.keyDown(layout, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Welcome to AETHER-OS" })).toBeInTheDocument();
    fireEvent.keyDown(layout, { key: "ArrowRight" });
    fireEvent.keyDown(layout, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Choose your AI" })).toBeInTheDocument();
    expect(useOnboardingStore.getState().wizard.index).toBe(2);
  });

  it("skips steps, marks them in the rail and finishes on Home", async () => {
    useOnboardingStore.getState().openWizard({ restart: true });
    render(<OnboardingWizard />);
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(screen.getByRole("heading", { name: "The 30-second tour" })).toBeInTheDocument();
    expect(screen.getAllByText("Skipped")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Try / })).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: /Check for updates once a day/ }));
    expect(useOnboardingStore.getState().prefs.autoCheckUpdates).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open Home" }));
    await waitFor(() => expect(useOnboardingStore.getState().wizardOpen).toBe(false));
    expect(useAetherStore.getState().view).toBe("dashboard");
    const stored = await mockInvoke<OnboardingState>("cmd_onboarding_get_state");
    expect(stored.completed_at).not.toBeNull();
    expect(stored.skipped_steps).toEqual(["vault", "ai", "embeddings"]);
  });

  it("only closes through a confirmed skip", async () => {
    useOnboardingStore.getState().openWizard({ restart: true });
    render(<OnboardingWizard />);
    const layout = document.querySelector(".ob-wizard-layout") as HTMLElement;
    fireEvent.keyDown(layout, { key: "Escape" });
    const dialog = await screen.findByRole("dialog", { name: "Skip setup?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep setting up" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Skip setup?" })).not.toBeInTheDocument());
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    const again = await screen.findByRole("dialog", { name: "Skip setup?" });
    fireEvent.click(within(again).getByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(useOnboardingStore.getState().wizardOpen).toBe(false));
    const stored = await mockInvoke<OnboardingState>("cmd_onboarding_get_state");
    expect(stored.skipped_steps).toEqual(["vault", "ai", "embeddings", "tour"]);
  });

  it("pauses for a tour 'Try it' and resumes", async () => {
    useOnboardingStore.setState({ wizardOpen: true, wizard: { index: 4, furthest: 4, skipped: [] } });
    render(<OnboardingWizard />);
    fireEvent.click(screen.getByRole("button", { name: "Try Agent panel" }));
    expect(await screen.findByRole("button", { name: "Resume setup" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The 30-second tour" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
    expect(screen.getByRole("heading", { name: "The 30-second tour" })).toBeInTheDocument();
  });
});

describe("Ollama guidance", () => {
  it("shows the status item only when there is something to fix", () => {
    const { container, rerender } = render(<OllamaStatusItem />);
    expect(container).toBeEmptyDOMElement();

    act(() => useAetherStore.setState({ health: { ...ONLINE, ollama_online: false } }));
    rerender(<OllamaStatusItem />);
    fireEvent.click(screen.getByRole("button", { name: /Ollama offline/ }));
    expect(useOnboardingStore.getState().ollamaGuideOpen).toBe(true);

    act(() => {
      useAetherStore.setState({ health: ONLINE });
      useOnboardingStore.setState({ installedModels: ["llama3.2:1b"] });
    });
    rerender(<OllamaStatusItem />);
    expect(screen.getByRole("button", { name: /Model missing/ })).toBeInTheDocument();
  });

  it("explains how to install and start Ollama when it is offline", async () => {
    useAetherStore.setState({ health: { ...ONLINE, ollama_online: false } });
    useOnboardingStore.setState({ ollamaGuideOpen: true });
    render(<OllamaGuideModal />);
    expect(screen.getByRole("dialog", { name: "Ollama isn't running" })).toBeInTheDocument();
    expect(await screen.findByText("brew install ollama")).toBeInTheDocument();
    expect(screen.getByText("ollama serve")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use OpenRouter instead" })).toBeInTheDocument();
  });

  it("offers the missing default model for download", async () => {
    useAetherStore.setState({ modelByProvider: { ollama: "llama3.1:8b", openrouter: "x" } });
    useOnboardingStore.setState({ ollamaGuideOpen: true });
    render(<OllamaGuideModal />);
    expect(await screen.findByRole("dialog", { name: "Model not installed" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Download/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Installed models" })).toBeInTheDocument();
  });
});

describe("WhatsNewModal", () => {
  it("renders the bundled changelog section", async () => {
    useOnboardingStore.setState({ whatsNewOpen: true });
    render(<WhatsNewModal />);
    expect(screen.getByRole("dialog", { name: /What's new/ })).toBeInTheDocument();
    // The Markdown renderer (with mermaid) is lazy-loaded; allow for a cold import.
    expect(await screen.findByText(/First-run setup/, undefined, { timeout: 10_000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(useOnboardingStore.getState().whatsNewOpen).toBe(false);
  }, 15_000);
});
