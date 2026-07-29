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
