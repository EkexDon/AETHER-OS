/** Note editing types — mirror `engine/vault_reader.rs` and `engine/web_clipper.rs`. */

/** A note linking to another note via `[[wikilink]]`, with line context. */
export interface Backlink {
  note_path: string;
  note_name: string;
  line: number;
  context: string;
}

/** Readable content extracted from a web page. */
export interface ClippedPage {
  url: string;
  title: string;
  content_html: string;
  excerpt: string;
}
