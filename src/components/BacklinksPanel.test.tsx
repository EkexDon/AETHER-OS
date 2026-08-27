import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BacklinksPanel } from "./BacklinksPanel";
import type { Backlink } from "../types";

describe("BacklinksPanel", () => {
  it("renders empty state when no backlinks", () => {
    render(<BacklinksPanel backlinks={[]} noteName="MyNote" onSelect={() => {}} />);
    expect(screen.getByText(/No notes link to this note yet/i)).toBeInTheDocument();
    expect(screen.getByText(/\[\[MyNote\]\]/)).toBeInTheDocument();
  });

  it("renders backlink items", () => {
    const backlinks: Backlink[] = [
      { note_path: "vault/a.md", note_name: "a", line: 5, context: "See [[MyNote]] for details" },
      { note_path: "vault/b.md", note_name: "b", line: 12, context: "Related to [[MyNote]]" },
    ];
    render(<BacklinksPanel backlinks={backlinks} noteName="MyNote" onSelect={() => {}} />);
    expect(screen.getByText("Backlinks (2)")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText(/See \[\[MyNote\]\] for details/)).toBeInTheDocument();
  });

  it("calls onSelect when clicking a backlink", () => {
    const onSelect = vi.fn();
    const backlinks: Backlink[] = [
      { note_path: "vault/a.md", note_name: "a", line: 5, context: "See [[MyNote]]" },
    ];
    render(<BacklinksPanel backlinks={backlinks} noteName="MyNote" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("a"));
    expect(onSelect).toHaveBeenCalledWith("vault/a.md");
  });
});
