import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ActionRun, CompactionState } from "../../lib/intelStore";
import { ActionRunList } from "./ActionRunList";
import { CompactionCard } from "./CompactionCard";
import { TokenMeter } from "./TokenMeter";

const compaction: CompactionState = {
  summary: "Topic: Moving to Berlin\nFacts:\n- Moving in October\nDecisions:\n- none\nOpen questions:\n- Which ISP?\nUser preferences:\n- none",
  compactedCount: 6,
  source: "model",
  tokensBefore: 7_000,
  tokensAfter: 1_200,
  modelError: null,
  at: 1,
};

describe("TokenMeter", () => {
  it("colours by tokens / threshold and compacts on click", () => {
    const onCompact = vi.fn();
    const { rerender } = render(<TokenMeter tokens={2_100} threshold={6_000} autoCompact compacting={false} onCompact={onCompact} />);
    const chip = screen.getByRole("button", { name: /about 2100 tokens of 6000/ });
    expect(chip).toHaveClass("is-ok");
    expect(chip).toHaveTextContent("2.1k");
    fireEvent.click(chip);
    expect(onCompact).toHaveBeenCalledTimes(1);
    rerender(<TokenMeter tokens={5_000} threshold={6_000} autoCompact compacting={false} />);
    expect(screen.getByRole("button")).toHaveClass("is-warn");
    expect(screen.getByRole("button")).toBeDisabled();
    rerender(<TokenMeter tokens={7_000} threshold={6_000} autoCompact compacting />);
    expect(screen.getByRole("button")).toHaveClass("is-over", "is-busy");
  });
});

describe("CompactionCard", () => {
  it("collapses by default and reveals the structured summary", () => {
    const onToggle = vi.fn();
    render(<CompactionCard compaction={compaction} showEarlier={false} onToggleEarlier={onToggle} />);
    const head = screen.getByRole("button", { expanded: false });
    expect(head).toHaveTextContent("Conversation summary");
    expect(head).toHaveTextContent("6 earlier messages");
    expect(head).toHaveTextContent("5,800 tokens saved");
    expect(screen.queryByText("Moving in October")).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText("Moving in October")).toBeInTheDocument();
    expect(screen.getByText("Open questions")).toBeInTheDocument();
    expect(screen.queryByText("Decisions")).toBeNull(); // empty sections are hidden
    fireEvent.click(screen.getByRole("button", { name: /Show 6 earlier/ }));
    expect(onToggle).toHaveBeenCalled();
  });

  it("flags extractive fallbacks", () => {
    render(
      <CompactionCard
        compaction={{ ...compaction, source: "extractive", modelError: "Ollama is offline" }}
        showEarlier
        onToggleEarlier={() => undefined}
        defaultOpen
      />
    );
    expect(screen.getByText("fallback")).toHaveAttribute("title", "Ollama is offline");
    expect(screen.getByRole("button", { name: /Hide earlier messages/ })).toBeInTheDocument();
  });
});

describe("ActionRunList", () => {
  const runs: ActionRun[] = [
    { id: "1", action: { action: "append_daily", content: "x" }, risk: "safe", status: "done", message: "Added to daily note" },
    {
      id: "2",
      action: { action: "run_command", command: "npm test", cwd: "/work/app" },
      risk: "dangerous",
      status: "error",
      message: "Ran `npm test` · exit 1",
      output: {
        command: "npm test",
        cwd: "/work/app",
        exit_code: 1,
        stdout: "1 failed\n",
        stderr: "AssertionError\n",
        timed_out: false,
        duration_ms: 812,
        truncated: false,
      },
    },
    { id: "3", action: { action: "delete_note", path: "/v/Old.md" }, risk: "dangerous", status: "denied", message: "Denied — nothing was changed" },
    { id: "4", action: { action: "move_note", from: "/v/a.md", to: "b/" }, risk: "confirm", status: "awaiting" },
  ];

  it("renders nothing without runs", () => {
    const { container } = render(<ActionRunList runs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows status, risk and an expandable terminal block", () => {
    render(<ActionRunList runs={runs} onClear={() => undefined} />);
    expect(screen.getByText("Tools used (4)")).toBeInTheDocument();
    expect(screen.getByText("Added to daily note", { selector: ".intel-run-label" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for your approval…")).toBeInTheDocument();
    expect(screen.getAllByText("dangerous")).toHaveLength(2);
    expect(screen.getByText("approval")).toBeInTheDocument();
    // Clearing is only offered once nothing is pending.
    expect(screen.queryByRole("button", { name: "Clear tool results" })).toBeNull();

    const toggle = screen.getByRole("button", { name: /Output · exit 1 · 812 ms/ });
    expect(screen.queryByLabelText("Command output")).toBeNull();
    fireEvent.click(toggle);
    const output = screen.getByLabelText("Command output");
    expect(output).toHaveTextContent("/work/app $ npm test");
    expect(output).toHaveTextContent("AssertionError");
  });

  it("offers clearing when everything finished", () => {
    const onClear = vi.fn();
    render(<ActionRunList runs={runs.slice(0, 3)} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear tool results" }));
    expect(onClear).toHaveBeenCalled();
  });
});
