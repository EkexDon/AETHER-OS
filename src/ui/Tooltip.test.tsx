import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appears after the hover delay and hides on leave", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Notes" shortcut="mod+2" delay={300}>
        <button>Trigger</button>
      </Tooltip>
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Notes");
    expect(trigger).toHaveAttribute("aria-describedby", tip.id);
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows immediately on keyboard focus and hides on Escape", () => {
    render(
      <Tooltip content="Settings">
        <button>Gear</button>
      </Tooltip>
    );
    const trigger = screen.getByRole("button", { name: "Gear" });
    act(() => {
      trigger.focus();
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Settings");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("does not show when disabled", () => {
    render(
      <Tooltip content="Nope" disabled>
        <button>X</button>
      </Tooltip>
    );
    fireEvent.focus(screen.getByRole("button", { name: "X" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the child's own handlers", () => {
    const onMouseEnter = vi.fn();
    render(
      <Tooltip content="T" delay={0}>
        <button onMouseEnter={onMouseEnter}>C</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: "C" }));
    expect(onMouseEnter).toHaveBeenCalledOnce();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});
