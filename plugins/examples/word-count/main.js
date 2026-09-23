/**
 * Word Count — an AETHER-OS example plugin.
 *
 * Shows the word count and reading time of the open note in the status bar
 * and a per-heading breakdown in the plugin panel. It refreshes when a note
 * is opened or saved, when its settings change and from the panel's
 * "Refresh" button.
 *
 * Permissions: vault:read (read the open note), ui:statusbar, ui:panel.
 */

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Remove everything that is not prose: frontmatter, fenced code, HTML tags,
 * link targets, image syntax and Markdown punctuation.
 * @param {string} markdown
 * @returns {string}
 */
export function stripMarkdown(markdown) {
  let text = String(markdown ?? "").replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  const lines = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/[*_~=]+/g, " ");
}

/**
 * Number of words in a Markdown document.
 * @param {string} markdown
 * @returns {number}
 */
export function countWords(markdown) {
  return (stripMarkdown(markdown).match(WORD) ?? []).length;
}

/**
 * Number of visible characters (whitespace excluded).
 * @param {string} markdown
 * @returns {number}
 */
export function countCharacters(markdown) {
  return [...stripMarkdown(markdown).replace(/\s+/g, "")].length;
}

/**
 * Split a note into heading sections with their own word counts. Text
 * before the first heading becomes an "Introduction" section.
 * @param {string} markdown
 * @returns {{ title: string, level: number, words: number }[]}
 */
export function sectionCounts(markdown) {
  const text = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  const sections = [];
  let current = { title: "Introduction", level: 0, lines: [] };
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push(current);
      current = { title: stripMarkdown(match[2]).trim() || "Untitled", level: match[1].length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ title: s.title, level: s.level, words: countWords(s.lines.join("\n")) }))
    .filter((s) => s.level > 0 || s.words > 0);
}

/**
 * Human reading time, e.g. "4 min" or "< 1 min".
 * @param {number} words
 * @param {number} wordsPerMinute
 * @returns {string}
 */
export function formatReadingTime(words, wordsPerMinute) {
  const wpm = Number.isFinite(wordsPerMinute) && wordsPerMinute > 0 ? wordsPerMinute : 230;
  if (words <= 0) return "0 min";
  const minutes = words / wpm;
  return minutes < 1 ? "< 1 min" : `${Math.round(minutes)} min`;
}

const format = (n) => n.toLocaleString("en-US");

let host = null;
let running = null;
let queued = false;
const disposers = [];

/**
 * Plugin entry point, called once by AETHER-OS.
 * @param {object} api the AETHER plugin API (see docs/PLUGIN-API.md)
 */
export async function activate(api) {
  host = api;
  disposers.push(
    api.events.on("note:opened", scheduleRefresh),
    api.events.on("note:saved", scheduleRefresh),
    api.events.on("settings:changed", scheduleRefresh),
    api.events.on("panel:action", (event) => {
      if (event.actionId === "refresh") scheduleRefresh();
    })
  );
  await refresh();
}

/** Called before the plugin is stopped. */
export function deactivate() {
  while (disposers.length) disposers.pop()();
  host = null;
}

/** Coalesce refresh requests so at most one runs and one waits. */
function scheduleRefresh() {
  if (running) {
    queued = true;
    return;
  }
  running = refresh()
    .catch((error) => console.error("[word-count] refresh failed", error))
    .finally(() => {
      running = null;
      if (queued) {
        queued = false;
        scheduleRefresh();
      }
    });
}

async function refresh() {
  if (!host) return;
  const settings = await host.settings.get();
  const wpm = Number(settings.wordsPerMinute) || 230;
  const note = await host.notes.current();

  if (!note) {
    await host.ui.statusbar.set(null);
    await host.ui.panel.set([
      { type: "heading", text: "Word count", level: 2 },
      { type: "text", text: "Open a note to see its word count and reading time.", tone: "muted" },
    ]);
    return;
  }

  const words = countWords(note.content);
  const characters = countCharacters(note.content);
  const reading = formatReadingTime(words, wpm);
  const sections = sectionCounts(note.content);

  await host.ui.statusbar.set(
    `${format(words)} words · ${reading}`,
    `${note.name}: ${format(words)} words, ${format(characters)} characters — about ${reading} to read at ${wpm} wpm`
  );

  const tree = [
    { type: "heading", text: note.name, level: 2 },
    { type: "badge", text: `${format(words)} words`, variant: "accent" },
    { type: "badge", text: `${reading} read`, variant: "neutral" },
  ];
  if (settings.showCharacters !== false) {
    tree.push({ type: "badge", text: `${format(characters)} characters`, variant: "neutral" });
  }
  tree.push({ type: "divider" }, { type: "heading", text: "By heading", level: 3 });
  if (sections.length === 0) {
    tree.push({ type: "text", text: "This note is empty.", tone: "muted" });
  } else {
    tree.push({
      type: "list",
      items: sections.map((s) => ({
        text: s.title,
        meta: `${format(s.words)} words`,
        indent: Math.max(0, Math.min(3, s.level - 1)),
      })),
    });
  }
  tree.push({ type: "button", label: "Refresh", actionId: "refresh", variant: "secondary" });
  await host.ui.panel.set(tree);
}
