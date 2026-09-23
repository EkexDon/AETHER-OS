import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MAX_TOASTS, TOAST_DURATION, ToastProvider, toast, useToastStore } from "./Toast";

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows success, error and info toasts with the right roles", () => {
    render(<ToastProvider />);
    act(() => {
      toast.success("Saved");
      toast.error("Failed", { description: "Disk full" });
      toast.info("Heads up");
    });
    expect(screen.getByText("Saved").closest(".ui-toast")).toHaveAttribute("role", "status");
    expect(screen.getByText("Failed").closest(".ui-toast")).toHaveAttribute("role", "alert");
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("auto-dismisses after its duration", () => {
    render(<ToastProvider />);
    act(() => {
      toast.success("Saved");
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION.success - 1);
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("pauses while hovered", () => {
    render(<ToastProvider />);
    act(() => {
      toast.info("Hover me", { duration: 1000 });
    });
    const card = screen.getByText("Hover me").closest(".ui-toast") as HTMLElement;
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Hover me")).toBeInTheDocument();
    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("Hover me")).toBeNull();
  });

  it("keeps sticky toasts and dismisses via the close button or action", () => {
    const onClick = vi.fn();
    render(<ToastProvider />);
    act(() => {
      toast.info("Sticky", { duration: 0, action: { label: "Open", onClick } });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByText("Sticky")).toBeNull();
    act(() => {
      toast.error("Close me", { duration: 0 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Close me")).toBeNull();
  });

  it("caps the visible stack", () => {
    act(() => {
      for (let i = 0; i < MAX_TOASTS + 3; i++) toast.info(`t${i}`);
    });
    const titles = useToastStore.getState().toasts.map((t) => t.title);
    expect(titles).toHaveLength(MAX_TOASTS);
    expect(titles[titles.length - 1]).toBe(`t${MAX_TOASTS + 2}`);
  });
});
