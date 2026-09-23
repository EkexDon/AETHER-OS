import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Badge } from "./Badge";
import { EmptyState } from "./EmptyState";
import { Kbd } from "./Kbd";
import { ListRow } from "./ListRow";
import { Card } from "./Card";
import { ViewHeader } from "./ViewHeader";

describe("Button", () => {
  it("renders variant/size classes and defaults to type=button", () => {
    render(
      <Button variant="primary" size="sm">
        Save
      </Button>
    );
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("type", "button");
    expect(btn.className).toContain("ui-button-primary");
    expect(btn.className).toContain("ui-button-sm");
  });

  it("blocks clicks and announces busy while loading", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    );
    const btn = screen.getByRole("button", { name: /save/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders icons on both sides", () => {
    const { container } = render(
      <Button iconLeft={<Plus data-testid="l" />} iconRight={<Plus data-testid="r" />}>
        Add
      </Button>
    );
    expect(container.querySelectorAll(".ui-button-icon")).toHaveLength(2);
  });
});

describe("IconButton", () => {
  it("uses the label as accessible name and reflects pressed state", () => {
    const onClick = vi.fn();
    render(<IconButton label="Toggle terminal" icon={<Plus />} active onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Toggle terminal" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("display primitives", () => {
  it("Badge renders a status dot", () => {
    const { container } = render(
      <Badge variant="success" dot>
        Connected
      </Badge>
    );
    expect(screen.getByText("Connected")).toHaveClass("ui-badge-success");
    expect(container.querySelector(".ui-badge-dot")).not.toBeNull();
  });

  it("EmptyState renders title, description and action", () => {
    render(<EmptyState title="Nothing yet" description="Add something" action={<button>Add</button>} />);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.getByText("Add something")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("Kbd renders one cap per key", () => {
    const { container } = render(<Kbd shortcut="mod+shift+k" />);
    expect(container.querySelectorAll("kbd")).toHaveLength(3);
  });

  it("ListRow is keyboard-activatable when clickable", () => {
    const onClick = vi.fn();
    render(<ListRow title="Row" onClick={onClick} meta="3" />);
    const row = screen.getByRole("button", { name: /row/i });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("interactive Card acts as a button", () => {
    const onClick = vi.fn();
    render(
      <Card interactive onClick={onClick}>
        Project
      </Card>
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Project" }), { key: "Enter" });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("ViewHeader renders a heading, subtitle and actions", () => {
    render(<ViewHeader title="Projects" subtitle="4 projects" actions={<button>Add</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("4 projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});
