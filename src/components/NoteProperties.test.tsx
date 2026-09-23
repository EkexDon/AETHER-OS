import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { NoteProperties, PROPERTIES_COLLAPSED_KEY } from "./NoteProperties";

const BLOCK = "---\ntitle: Weekly review\ntags: [review, meta]\n# a comment stays\nnested:\n  child: 1\n---\n\n";

/** Controlled host that records every emitted block. */
function Host({ initial, onEmit, addRequest = 0 }: { initial: string | null; onEmit: (fm: string | null) => void; addRequest?: number }) {
  const [fm, setFm] = useState<string | null>(initial);
  return (
    <NoteProperties
      frontmatter={fm}
      addRequest={addRequest}
      onChange={(next) => {
        onEmit(next);
        setFm(next);
      }}
    />
  );
}

beforeEach(() => {
  window.localStorage.removeItem(PROPERTIES_COLLAPSED_KEY);
});

describe("NoteProperties", () => {
  it("lists properties with tag chips and read-only raw YAML", () => {
    render(<Host initial={BLOCK} onEmit={vi.fn()} />);
    const panel = screen.getByRole("region", { name: "Properties" });
    expect(within(panel).getByLabelText("title")).toHaveValue("Weekly review");
    expect(within(panel).getByText("#review")).toBeInTheDocument();
    expect(within(panel).getByText("#meta")).toBeInTheDocument();
    expect(within(panel).getByText("child: 1")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Remove property nested" })).toBeDisabled();
  });

  it("commits an edited value on Enter and reverts on Escape, touching only that line", () => {
    const emit = vi.fn();
    render(<Host initial={BLOCK} onEmit={emit} />);
    const title = screen.getByLabelText("title");
    fireEvent.change(title, { target: { value: "Changed" } });
    fireEvent.keyDown(title, { key: "Escape" });
    expect(title).toHaveValue("Weekly review");
    expect(emit).not.toHaveBeenCalled();

    fireEvent.change(title, { target: { value: "Monthly review" } });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(emit).toHaveBeenLastCalledWith(BLOCK.replace("title: Weekly review", "title: Monthly review"));
  });

  it("adds and removes tags", () => {
    const emit = vi.fn();
    render(<Host initial={BLOCK} onEmit={emit} />);
    const input = screen.getByLabelText("Add to tags");
    fireEvent.change(input, { target: { value: "#weekly" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenLastCalledWith(BLOCK.replace("tags: [review, meta]", "tags: [review, meta, weekly]"));
    fireEvent.click(screen.getByRole("button", { name: "Remove tag review" }));
    expect(emit).toHaveBeenLastCalledWith(BLOCK.replace("tags: [review, meta]", "tags: [meta, weekly]"));
  });

  it("adds a new property, validates its name and removes properties", () => {
    const emit = vi.fn();
    render(<Host initial={BLOCK} onEmit={emit} />);
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const name = screen.getByLabelText("Property name");
    fireEvent.change(name, { target: { value: "title" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");

    fireEvent.change(name, { target: { value: "status" } });
    fireEvent.change(screen.getByLabelText("Property value"), { target: { value: "draft" } });
    fireEvent.keyDown(screen.getByLabelText("Property value"), { key: "Enter" });
    expect(emit).toHaveBeenLastCalledWith("---\ntitle: Weekly review\ntags: [review, meta]\n# a comment stays\nnested:\n  child: 1\nstatus: draft\n---\n\n");
    expect(screen.getByLabelText("status")).toHaveValue("draft");

    fireEvent.click(screen.getByRole("button", { name: "Remove property title" }));
    expect(emit).toHaveBeenLastCalledWith("---\ntags: [review, meta]\n# a comment stays\nnested:\n  child: 1\nstatus: draft\n---\n\n");
  });

  it("renders nothing without front matter until a property is requested", () => {
    const emit = vi.fn();
    const { rerender, container } = render(<Host initial={null} onEmit={emit} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<Host initial={null} onEmit={emit} addRequest={1} />);
    const name = screen.getByLabelText("Property name");
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "tags" } });
    fireEvent.change(screen.getByLabelText("Property value"), { target: { value: "a, #b" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(emit).toHaveBeenLastCalledWith("---\ntags: [a, b]\n---\n");
  });

  it("drops the block when the last property is removed", () => {
    const emit = vi.fn();
    render(<Host initial={"---\nonly: one\n---\n"} onEmit={emit} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove property only" }));
    expect(emit).toHaveBeenLastCalledWith(null);
  });

  it("collapses and remembers it", () => {
    render(<Host initial={BLOCK} onEmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Properties/ }));
    expect(screen.queryByLabelText("title")).toBeNull();
    expect(window.localStorage.getItem(PROPERTIES_COLLAPSED_KEY)).toBe("1");
  });
});
