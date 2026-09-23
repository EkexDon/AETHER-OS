import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ focusLogSession: vi.fn() }));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  ...ipc,
}));

import { FocusStatusItem, PinsStatusItem } from "./statusItems";
import { FocusSettings } from "./FocusSettings";
import { useFocusStore } from "../../lib/focusStore";
import { useHomeStore } from "../../lib/homeStore";
import { usePinsStore } from "../../lib/pinsStore";
import { DEFAULT_POMODORO_SETTINGS, initialTimer } from "../../lib/home/pomodoro";
import { homeCommands } from "../../lib/home/commands";
import { createCommandContext } from "../../lib/commands/context";
import { useAetherStore } from "../../lib/store";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 8, 22, 9, 0, 0));
  ipc.focusLogSession.mockReset().mockResolvedValue({ id: "s" });
  window.localStorage.clear();
  useFocusStore.setState({ settings: { ...DEFAULT_POMODORO_SETTINGS }, timer: initialTimer(), focusMode: false, statsVersion: 0 });
  useHomeStore.setState({ pinsDrawerOpen: false });
  usePinsStore.setState({ groups: [{ id: "g", name: "Pinned", items: [{ id: "a", kind: "url", ref: "https://a.dev/", label: "A" }] }] });
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-focus");
});

describe("FocusStatusItem", () => {
  it("starts, counts down, pauses and skips", () => {
    render(<FocusStatusItem />);
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(screen.getByRole("button", { name: /^Focus 25:00, pause$/ })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole("button", { name: /^Focus 23:59, pause$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /pause$/ }));
    expect(useFocusStore.getState().timer.status).toBe("paused");
    expect(screen.getByRole("button", { name: /^Focus 23:59, resume$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finish focus and start the break" }));
    expect(useFocusStore.getState().timer.phase).toBe("break");
    expect(ipc.focusLogSession).toHaveBeenCalledWith(expect.objectContaining({ kind: "work", minutes: 1 }));
  });

  it("completes a phase on the engine tick", () => {
    render(<FocusStatusItem />);
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    act(() => {
      vi.advanceTimersByTime(25 * 60_000 + 1000);
    });
    expect(useFocusStore.getState().timer).toMatchObject({ phase: "break", status: "running" });
    expect(ipc.focusLogSession).toHaveBeenCalledWith(expect.objectContaining({ kind: "work", minutes: 25 }));
  });

  it("stays visible in focus mode, which Esc twice exits", () => {
    render(<FocusStatusItem />);
    act(() => useFocusStore.getState().setFocusMode(true));
    expect(document.documentElement.getAttribute("data-focus")).toBe("true");
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("data-focus-keep");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useFocusStore.getState().focusMode).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useFocusStore.getState().focusMode).toBe(false);
    expect(document.documentElement.hasAttribute("data-focus")).toBe(false);
  });
});

describe("PinsStatusItem", () => {
  it("shows the count and toggles the drawer", () => {
    render(<PinsStatusItem />);
    const button = screen.getByRole("button", { name: "Pins (1)" });
    fireEvent.click(button);
    expect(useHomeStore.getState().pinsDrawerOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Pins" })).toBeInTheDocument();
    fireEvent.click(button);
    expect(useHomeStore.getState().pinsDrawerOpen).toBe(false);
  });
});

describe("FocusSettings", () => {
  it("commits clamped durations on blur and toggles behaviour", () => {
    render(<FocusSettings />);
    const work = screen.getByLabelText("Focus session");
    fireEvent.change(work, { target: { value: "500" } });
    expect(useFocusStore.getState().settings.workMinutes).toBe(25);
    fireEvent.blur(work);
    expect(useFocusStore.getState().settings.workMinutes).toBe(180);
    expect(work).toHaveValue(180);

    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    expect(useFocusStore.getState().settings.sound).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Start breaks automatically" }));
    expect(useFocusStore.getState().settings.autoStartBreaks).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(useFocusStore.getState().settings).toEqual(DEFAULT_POMODORO_SETTINGS);
  });
});

describe("home commands", () => {
  const run = (id: string) => homeCommands.find((c) => c.id === id)!.run(createCommandContext());

  it("pins and unpins the current note", () => {
    const pin = homeCommands.find((c) => c.id === "home.pinCurrentNote")!;
    useAetherStore.setState({ selectedNotePath: null });
    expect(pin.when?.(createCommandContext())).toBe(false);
    useAetherStore.setState({ selectedNotePath: "/vault/Plan.md" });
    void run("home.pinCurrentNote");
    expect(usePinsStore.getState().groups[0].items.at(-1)).toMatchObject({ kind: "note", ref: "/vault/Plan.md", label: "Plan" });
    const unpin = homeCommands.find((c) => c.id === "home.unpinCurrentNote")!;
    expect(unpin.when?.(createCommandContext())).toBe(true);
    void run("home.unpinCurrentNote");
    expect(usePinsStore.getState().groups[0].items.some((i) => i.ref === "/vault/Plan.md")).toBe(false);
  });

  it("toggles focus mode, the timer and the pins drawer", () => {
    void run("home.toggleFocusMode");
    expect(useFocusStore.getState().focusMode).toBe(true);
    void run("home.toggleTimer");
    expect(useFocusStore.getState().timer.status).toBe("running");
    void run("home.togglePinsDrawer");
    expect(useHomeStore.getState().pinsDrawerOpen).toBe(true);
  });

  it("uses the documented shortcuts", () => {
    const shortcuts = Object.fromEntries(homeCommands.filter((c) => c.shortcut).map((c) => [c.id, c.shortcut]));
    expect(shortcuts).toEqual({
      "home.pinCurrentNote": "mod+shift+d",
      "home.togglePinsDrawer": "mod+alt+b",
      "home.toggleFocusMode": "mod+shift+f",
      "home.toggleTimer": "mod+alt+t",
    });
  });
});
