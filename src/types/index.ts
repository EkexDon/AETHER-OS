export interface VaultNote {
  path: string;
  name: string;
  mtime: number;
}

export interface VaultTask {
  note_path: string;
  line: number;
  text: string;
  checked: boolean;
  due: string | null;
  tags: string[];
}

export interface VaultCard {
  key: string;
  note_path: string;
  front: string;
  back: string;
  card_type: string;
}

export interface VaultIndexEntry {
  path: string;
  mtime: number;
  tags: string[];
  wikilinks: string[];
  tasks: VaultTask[];
  frontmatter: Record<string, string>;
  word_count: number;
  cards: VaultCard[];
}

export interface VaultIndex {
  version: number;
  notes: VaultIndexEntry[];
}

export interface GraphNode {
  id: string;
  label: string;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface VaultStats {
  note_count: number;
  total_tasks: number;
  open_tasks: number;
  total_cards: number;
  total_tags: number;
  total_links: number;
}

export interface VectorMatch {
  id: string;
  text: string;
  score: number;
}

export interface SystemHealth {
  ollama_online: boolean;
  openrouter_configured: boolean;
  vault_connected: boolean;
}

export interface IndexingResult {
  total: number;
  indexed: number;
  skipped: number;
}

export interface AetherNote {
  id: string;
  title: string;
  content: string;
  source_query: string;
  related_notes: string[];
  created_at: string;
}

export interface Project {
  name: string;
  path: string;
  git_branch: string | null;
  git_status: string | null;
  last_commit_msg: string | null;
  last_commit_date: number | null;
  language: string;
}

export interface ChatMessageRecord {
  role: string;
  content: string;
}

export interface Conversation {
  id: string;
  timestamp: number;
  messages: ChatMessageRecord[];
  context_notes: string[];
  summary: string;
}

export interface MemoryFact {
  fact: string;
  category: string;
  created_at: number;
}

export interface TerminalSession {
  id: string;
  cwd: string;
  shell: string;
  alive: boolean;
}

export interface TerminalOutputEvent {
  id: string;
  /** PTY bytes, base64-encoded so they arrive byte-exact (never lossy UTF-8). */
  dataBase64: string;
}

export interface CpuInfo {
  name: string;
  usage: number;
}

export interface MemoryInfo {
  total: number;
  used: number;
  available: number;
}

export interface DiskInfo {
  name: string;
  mount_point: string;
  total: number;
  used: number;
  available: number;
}

export interface NetworkInfo {
  interface: string;
  rx_rate: number;
  tx_rate: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_usage: number;
  memory: number;
}

export interface BatteryInfo {
  charging: boolean;
  percent: number;
}

export interface SystemMetrics {
  timestamp: number;
  cpus: CpuInfo[];
  overall_cpu: number;
  memory: MemoryInfo;
  disks: DiskInfo[];
  network: NetworkInfo[];
  processes: ProcessInfo[];
  battery: BatteryInfo | null;
  uptime: number;
}

export interface BrowserInfo {
  librewolf_installed: boolean;
  librewolf_path: string | null;
  default_browser: string;
}

export interface Backlink {
  note_path: string;
  note_name: string;
  line: number;
  context: string;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface ClippedPage {
  url: string;
  title: string;
  content_html: string;
  excerpt: string;
}

export type AgentAction =
  | { action: "create_note"; title: string; content: string }
  | { action: "append_note"; path: string; content: string }
  | { action: "append_daily"; content: string }
  | { action: "open_url"; url: string }
  | { action: "clip_url"; url: string }
  | { action: "add_memory_fact"; fact: string; category: string }
  | { action: "save_aether_note"; title: string; content: string }
  | { action: "create_calendar_event"; title: string; description: string; all_day: boolean; start: string; end: string; due: string | null; color: string | null; tags: string[]; attendees: string[]; location: string | null }
  | { action: "update_calendar_event"; id: string; title: string | null; description: string | null; all_day: boolean | null; start: string | null; end: string | null; due: string | null; color: string | null; tags: string[] | null; attendees: string[] | null; location: string | null }
  | { action: "delete_calendar_event"; id: string }
  | { action: "list_calendar_events"; from: string | null; to: string | null }
  | { action: "import_calendar_ics"; path: string; overwrite_existing: boolean; default_color: string | null };

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "typechange";

export interface GitStatusEntry {
  path: string;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
}

export interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  unborn: boolean;
  entries: GitStatusEntry[];
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
}

export interface CommitInfo {
  id: string;
  summary: string;
  author: string;
  time: number;
}

export interface FileDiff {
  path: string;
  old_content: string | null;
  new_content: string | null;
  is_binary: boolean;
}

// ── Calendar ─────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  uid: string;
  title: string;
  description: string;
  all_day: boolean;
  /** "YYYY-MM-DD" when all_day, RFC3339 timestamp when timed */
  start: string;
  /** Same format as start. Always present (single-day events have end == start + duration). */
  end: string;
  /** Optional deadline. Same format as start. */
  due: string | null;
  /** Hex like "#3b82f6" */
  color: string;
  tags: string[];
  attendees: string[];
  location: string | null;
  /** Set when the event was created from a vault note context by the AI. */
  source_note_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEventPatch {
  title?: string;
  description?: string;
  all_day?: boolean;
  start?: string;
  end?: string;
  due?: string | null;
  color?: string;
  tags?: string[];
  attendees?: string[];
  location?: string | null;
}

export type CalendarView = "month" | "week" | "day";

export interface IcsImportResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface ReminderSettings {
  enabled: boolean;
  lead_times_minutes: number[];
}

// ── Projects & Tasks (Kanban / Issue Board) ─────────────────

export type TaskStatus = "backlog" | "todo" | "in_progress" | "done";

export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface TaskProject {
  id: string;
  name: string;
  description: string;
  color: string;
  icon?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskProjectPatch {
  name?: string;
  description?: string;
  color?: string;
  icon?: string | null;
}

export interface TaskItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  labels: string[];
  order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskItemPatch {
  project_id?: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string | null;
  labels?: string[];
  order?: number;
}

