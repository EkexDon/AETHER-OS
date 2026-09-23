import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetMockState, setMockLatency } from "../../lib/mock/backend";
import { MOCK_PROJECTS_ROOT } from "../../lib/mock/fixtures/workspace";
import { useIntelStore, type ApprovalDecision } from "../../lib/intelStore";
import type { AgentAction } from "../../types";
import { ApprovalModal } from "./ApprovalModal";

const REPO = `${MOCK_PROJECTS_ROOT}/aether-demo-app`;

function request(action: AgentAction): Promise<ApprovalDecision> {
  const [run] = useIntelStore.getState().addRuns([action]);
  return useIntelStore.getState().requestApproval(run);
}

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useIntelStore.setState({ approvals: [], runs: [], allowRules: [] });
});

afterEach(() => {
  useIntelStore.getState().denyAll();
  vi.unstubAllEnvs();
});

describe("ApprovalModal", () => {
  it("renders nothing without pending approvals", () => {
    render(<ApprovalModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the command in mono, the resolved directory and destructive warnings", async () => {
    void request({ action: "run_command", command: "rm -rf build", cwd: REPO });
    render(<ApprovalModal />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Approve agent action")).toBeInTheDocument();
    expect(screen.getByText("rm -rf build").tagName).toBe("CODE");
    expect(await screen.findByText(/Deletes files recursively/)).toBeInTheDocument();
    expect(screen.getAllByText(REPO).length).toBeGreaterThan(0);
    expect(screen.getByText("Dangerous")).toBeInTheDocument();
  });

  it("approves and denies single actions", async () => {
    const approved = request({ action: "move_note", from: "Reading List", to: "04-Archive/" });
    render(<ApprovalModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await expect(approved).resolves.toBe("approved");

    const denied = request({ action: "delete_note", path: "Quick Capture" });
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await expect(denied).resolves.toBe("denied");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lists the queue and approves everything at once", async () => {
    const first = request({ action: "run_command", command: "npm test", cwd: REPO });
    const second = request({ action: "git_commit", project_path: REPO, message: "feat: x" });
    render(<ApprovalModal />);
    expect(await screen.findByText("Approve 2 agent actions")).toBeInTheDocument();
    expect(screen.getByText(/Also waiting \(1\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Commit in aether-demo-app/ }));
    expect(await screen.findByText("feat: x")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve all (2)" }));
    await expect(first).resolves.toBe("approved");
    await expect(second).resolves.toBe("approved");
  });

  it("closing the dialog denies everything that is pending", async () => {
    const pending = request({ action: "delete_note", path: "Quick Capture" });
    render(<ApprovalModal />);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await expect(pending).resolves.toBe("denied");
  });

  it("creates an always-allow rule from the switch", async () => {
    const pending = request({ action: "run_command", command: "ls", cwd: REPO });
    render(<ApprovalModal />);
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await expect(pending).resolves.toBe("approved");
    const [rule] = useIntelStore.getState().allowRules;
    expect(rule).toMatchObject({ kind: "run_command", scope: REPO, risk: "dangerous" });
  });
});
