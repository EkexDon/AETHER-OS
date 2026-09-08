import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskBoard } from "./TaskBoard";
import { useAetherStore } from "../lib/store";
import type { TaskProject, TaskItem } from "../types";

vi.mock("../lib/ipc", () => ({
  listTaskProjects: vi.fn().mockResolvedValue([]),
  getTaskProject: vi.fn(),
  createTaskProject: vi.fn(),
  updateTaskProject: vi.fn(),
  deleteTaskProject: vi.fn(),
  listTasks: vi.fn().mockResolvedValue([]),
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

const mockProject: TaskProject = {
  id: "p1",
  name: "Roguelike Engine",
  description: "Core mechanics",
  color: "#10b981",
  icon: null,
  created_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
};

const mockTasks: TaskItem[] = [
  {
    id: "t1",
    project_id: "p1",
    title: "Implement Dungeon Generation",
    description: "Use BSP tree algorithm",
    status: "todo",
    priority: "high",
    due_date: "2026-10-15",
    labels: ["gameplay", "algorithm"],
    order: 1000,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
  },
  {
    id: "t2",
    project_id: "p1",
    title: "Player Movement Animation",
    description: "",
    status: "in_progress",
    priority: "urgent",
    due_date: null,
    labels: ["animation"],
    order: 1000,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
  },
  {
    id: "t3",
    project_id: "p1",
    title: "Sound Effects",
    description: "",
    status: "done",
    priority: "none",
    due_date: null,
    labels: [],
    order: 1000,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
  },
];

describe("TaskBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAetherStore.setState({
      taskProjects: [],
      selectedProjectId: null,
      tasks: [],
      taskViewMode: "board",
      taskFilterQuery: "",
      taskFilterPriority: null,
      taskFilterLabel: null,
      projectModalOpen: false,
      taskDetailModalOpen: false,
    });
  });

  it("renders empty state when no projects exist", async () => {
    render(<TaskBoard />);
    expect(await screen.findByText(/Create Your First Project/i)).toBeInTheDocument();
  });

  it("renders the kanban columns and cards when a project is active", () => {
    useAetherStore.setState({
      taskProjects: [mockProject],
      selectedProjectId: "p1",
      tasks: mockTasks,
    });

    render(<TaskBoard />);

    // Columns
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    expect(screen.getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    // Tasks
    expect(screen.getByText("Implement Dungeon Generation")).toBeInTheDocument();
    expect(screen.getByText("Player Movement Animation")).toBeInTheDocument();
    expect(screen.getByText("Sound Effects")).toBeInTheDocument();

    // Labels & Due date
    expect(screen.getAllByText("gameplay").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2026-10-15")).toBeInTheDocument();
  });

  it("filters tasks by search query", () => {
    useAetherStore.setState({
      taskProjects: [mockProject],
      selectedProjectId: "p1",
      tasks: mockTasks,
    });

    render(<TaskBoard />);

    const searchInput = screen.getByPlaceholderText(/Filter tasks/i);
    fireEvent.change(searchInput, { target: { value: "Dungeon" } });

    expect(screen.getByText("Implement Dungeon Generation")).toBeInTheDocument();
    expect(screen.queryByText("Player Movement Animation")).not.toBeInTheDocument();
    expect(screen.queryByText("Sound Effects")).not.toBeInTheDocument();
  });

  it("switches to list view", () => {
    useAetherStore.setState({
      taskProjects: [mockProject],
      selectedProjectId: "p1",
      tasks: mockTasks,
      taskViewMode: "board",
    });

    render(<TaskBoard />);

    const listBtn = screen.getByRole("button", { name: /List/i });
    fireEvent.click(listBtn);

    expect(useAetherStore.getState().taskViewMode).toBe("list");
  });

  it("opens task detail modal when New Task button is clicked", () => {
    useAetherStore.setState({
      taskProjects: [mockProject],
      selectedProjectId: "p1",
      tasks: mockTasks,
    });

    render(<TaskBoard />);

    const newBtn = screen.getByRole("button", { name: /New Task/i });
    fireEvent.click(newBtn);

    expect(useAetherStore.getState().taskDetailModalOpen).toBe(true);
  });
});
