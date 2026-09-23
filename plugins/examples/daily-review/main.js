/**
 * Daily Review — an AETHER-OS example plugin.
 *
 * Registers the command "Daily review". It reads today's daily note
 * (`<folder>/YYYY-MM-DD.md`), asks the configured AI model for a short
 * summary with that note as context and writes the answer under a
 * `## Review` heading — replacing an earlier review instead of stacking
 * them up.
 *
 * Permissions: vault:read, vault:write, ai:query, ui:commands.
 */

/**
 * Local calendar date as `YYYY-MM-DD`.
 * @param {Date} [date]
 * @returns {string}
 */
export function todayIso(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Vault-relative path of the daily note for `date` inside `folder`.
 * @param {string} folder
 * @param {Date} [date]
 * @returns {string}
 */
export function dailyNotePath(folder, date = new Date()) {
  const clean = String(folder ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean ? `${clean}/${todayIso(date)}.md` : `${todayIso(date)}.md`;
}

/**
 * Remove agent action blocks and an echoed "Review" heading from an AI
 * answer so only the summary itself is written to the note.
 * @param {string} answer
 * @returns {string}
 */
export function cleanAnswer(answer) {
  return String(answer ?? "")
    .replace(/```action[\s\S]*?```/g, "")
    .replace(/^\s*#{1,6}\s*review\s*$/im, "")
    .trim();
}

/**
 * Insert or replace the `## <heading>` section of a Markdown document. The
 * section ends at the next heading of level 1 or 2 (or the end of the note).
 * @param {string} markdown
 * @param {string} heading
 * @param {string} body
 * @returns {string}
 */
export function upsertSection(markdown, heading, body) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const target = heading.trim().toLowerCase();
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (!inFence && /^##\s+/.test(lines[i]) && lines[i].replace(/^##\s+/, "").trim().toLowerCase() === target) {
      start = i;
      break;
    }
  }
  const section = [`## ${heading}`, "", body.trim(), ""];
  if (start === -1) {
    const text = lines.join("\n").replace(/\s+$/, "");
    return `${text}${text ? "\n\n" : ""}${section.join("\n")}`;
  }
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (!inFence && /^#{1,2}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  return [...before, ...section, ...after].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

/**
 * Plugin entry point, called once by AETHER-OS.
 * @param {object} api the AETHER plugin API (see docs/PLUGIN-API.md)
 */
export async function activate(api) {
  await api.commands.register({
    id: "run",
    title: "Daily review",
    run: () => runReview(api),
  });
}

/**
 * Summarise today's daily note and write the result under `## Review`.
 * @param {object} api
 */
export async function runReview(api) {
  const settings = await api.settings.get();
  const path = dailyNotePath(settings.folder || "daily");

  try {
    await api.vault.read(path);
  } catch {
    await api.ui.toast(`There is no daily note for today yet (${path}).`, "info");
    return;
  }

  await api.ui.toast("Writing your daily review…", "info");
  const style = settings.style === "paragraph" ? "one short paragraph" : "three to five concise bullet points";
  const prompt =
    `Review today's daily note (${path}). Summarise it as ${style}: what got done, ` +
    "what is still open and one concrete suggestion for tomorrow. " +
    "Reply with the summary only, in the language of the note, without a heading.";
  const summary = cleanAnswer(await api.ai.query(prompt, { notes: [path] }));
  if (!summary) throw new Error("The AI returned an empty summary.");

  // Re-read right before writing so edits made while the AI was thinking survive.
  const latest = await api.vault.read(path);
  await api.vault.write(path, upsertSection(latest, "Review", summary));
  await api.ui.toast("Daily review added under “## Review”.", "success");
  if (settings.openAfterReview !== false) await api.notes.open(path);
}
