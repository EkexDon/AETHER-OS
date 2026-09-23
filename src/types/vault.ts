/** Vault domain types — mirror `src-tauri/src/engine/vault_reader.rs`. */

/** A Markdown file inside the vault. `path` is absolute. */
export interface VaultNote {
  path: string;
  name: string;
  /** Last modification time, seconds since the Unix epoch. */
  mtime: number;
}

/** A `- [ ]` task extracted from a note by the NoPes indexer. */
export interface VaultTask {
  note_path: string;
  line: number;
  text: string;
  checked: boolean;
  due: string | null;
  tags: string[];
}

/** A spaced-repetition card extracted from a note. */
export interface VaultCard {
  key: string;
  note_path: string;
  front: string;
  back: string;
  card_type: string;
}

/** Parsed metadata of one note in `.nopes/index.json`. */
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

/** The NoPes vault index (`.nopes/index.json`). */
export interface VaultIndex {
  version: number;
  notes: VaultIndexEntry[];
}

/** Graph node: one note. `id` is the absolute note path. */
export interface GraphNode {
  id: string;
  label: string;
  tags: string[];
}

/** Graph edge: a resolved `[[wikilink]]` between two note paths. */
export interface GraphEdge {
  source: string;
  target: string;
}

/** Wikilink graph of the vault. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Aggregate counters shown on the dashboard. */
export interface VaultStats {
  note_count: number;
  total_tasks: number;
  open_tasks: number;
  total_cards: number;
  total_tags: number;
  total_links: number;
}
