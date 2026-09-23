import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs } from "./Tabs";
import { SegmentedControl } from "./SegmentedControl";
import { Switch } from "./Switch";
import { Checkbox } from "./Checkbox";
import { SearchField } from "./SearchField";
import { Select } from "./Select";
import { Popover } from "./Popover";
import { nextRovingIndex } from "./roving";
import { computePosition, cx, focusableWithin } from "./utils";

describe("roving focus", () => {
  it("wraps and skips disabled items", () => {
    expect(nextRovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextRovingIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextRovingIndex("Home", 2, 3)).toBe(0);
    expect(nextRovingIndex("End", 0, 3)).toBe(2);
    expect(nextRovingIndex("ArrowRight", 0, 3, "horizontal", (i) => i === 1)).toBe(2);
    expect(nextRovingIndex("ArrowDown", 0, 3, "vertical")).toBe(1);
    expect(nextRovingIndex("Enter", 0, 3)).toBeNull();
  });
});

describe("Tabs", () => {
  function Harness() {
    const [v, setV] = useState<"a" | "b" | "c">("a");
    return (
      <Tabs
        aria-label="Sections"
        value={v}
        onChange={setV}
        items={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta", count: 3 },
          { id: "c", label: "Gamma" },
        ]}
      />
    );
  }

  it("exposes tab semantics with roving tabindex", () => {
    render(<Harness />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    expect(alpha).toHaveAttribute("aria-selected", "true");
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute("tabindex", "-1");
  });

  it("moves selection and focus with arrow keys", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    const beta = screen.getByRole("tab", { name: /Beta/ });
    expect(beta).toHaveAttribute("aria-selected", "true");
    expect(beta).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("SegmentedControl", () => {
  it("is a radiogroup that changes on click and arrows", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="View"
        value="month"
        onChange={onChange}
        options={[
          { value: "month", label: "Month" },
          { value: "week", label: "Week" },
        ]}
      />
    );
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Month" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(onChange).toHaveBeenLastCalledWith("week");
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("week");
  });
});

describe("Switch", () => {
  it("toggles with its visible label as accessible name", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Show labels" description="In the rail" />);
    const sw = screen.getByRole("switch", { name: "Show labels" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAccessibleDescription("In the rail");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Checkbox", () => {
  it("supports the indeterminate state", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} indeterminate onChange={onChange} label="All notes" />);
    const box = screen.getByRole("checkbox", { name: "All notes" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
  });
});

describe("SearchField", () => {
  function Harness({ onSubmit }: { onSubmit: (v: string) => void }) {
    const [q, setQ] = useState("");
    return <SearchField value={q} onChange={setQ} onSubmit={onSubmit} placeholder="Search" shortcutHint="mod+k" />;
  }

  it("submits on Enter, clears on Escape and via the clear button", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "vector" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("vector");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
  });
});

describe("Select", () => {
  it("renders options and forwards changes", () => {
    const onChange = vi.fn();
    render(
      <Select
        aria-label="Editor"
        value="code"
        onChange={onChange}
        options={[
          { value: "code", label: "VS Code" },
          { value: "zed", label: "Zed" },
        ]}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Editor" }), { target: { value: "zed" } });
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Popover", () => {
  it("toggles from its trigger and closes on outside click / Escape", () => {
    render(
      <div>
        <span>outside</span>
        <Popover trigger={<button>Menu</button>} aria-label="Menu panel">
          <button>Item</button>
        </Popover>
      </div>
    );
    const trigger = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Menu panel" })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("utils", () => {
  it("joins class names", () => {
    expect(cx("a", false, null, undefined, "b", 0, "")).toBe("a b");
  });

  it("flips a placement that would overflow and clamps into the viewport", () => {
    const vp = { width: 800, height: 600 };
    const nearTop = computePosition({ top: 4, left: 100, width: 40, height: 20 }, { width: 100, height: 30 }, "top", vp);
    expect(nearTop.placement).toBe("bottom");
    expect(nearTop.top).toBeGreaterThan(24);
    const nearRight = computePosition({ top: 300, left: 780, width: 20, height: 20 }, { width: 120, height: 30 }, "bottom", vp);
    expect(nearRight.left + 120).toBeLessThanOrEqual(800 - 8);
    const right = computePosition({ top: 100, left: 40, width: 36, height: 36 }, { width: 80, height: 24 }, "right", vp, 8);
    expect(right).toEqual({ top: 106, left: 84, placement: "right" });
  });

  it("lists focusable descendants", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button>a</button><button disabled>b</button><input /><div tabindex="-1"></div><a href="#">c</a>';
    expect(focusableWithin(root).map((e) => e.tagName)).toEqual(["BUTTON", "INPUT", "A"]);
  });
});
