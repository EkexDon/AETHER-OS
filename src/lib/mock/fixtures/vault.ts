/**
 * Seed content for the mock vault: a realistic, bilingual (German/English)
 * PARA-style knowledge base with frontmatter, `#tags`, a connected
 * `[[wikilink]]` graph, dated `- [ ]` tasks, flashcards, a mermaid diagram,
 * an image reference and a long tutorial note. Dates are relative to `now`
 * so daily notes and due dates always look current.
 */
import { addDays, localDate } from "../runtime";

/** Absolute path of the demo vault. */
export const MOCK_VAULT_ROOT = "/Users/demo/Documents/Second-Brain";

/** One seed note: vault-relative path, Markdown content, age in days. */
export interface VaultFixtureNote {
  rel: string;
  content: string;
  /** Days since the note was last modified. */
  ageDays: number;
}

/** Build the seed notes relative to `now`. */
export function buildVaultFixture(now: Date): VaultFixtureNote[] {
  const d = (offset: number) => localDate(addDays(now, offset));
  const today = d(0);

  return [
    {
      rel: "Welcome.md",
      ageDays: 30,
      content: `---
title: Welcome
tags: [start, meta]
---
# Welcome to your Second Brain

This vault follows the PARA method: [[00-Inbox]] style captures land in the inbox, active work lives in projects, long-lived responsibilities in areas and reference material in resources.

## Where to start
- The main project hub is [[AETHER-OS]].
- My writing system is described in [[Zettelkasten Methode]].
- Today's log: [[${today}]]
- Setting up local AI: [[Ollama Setup Tutorial]]

#meta #para
`,
    },
    {
      rel: "00-Inbox/Quick Capture.md",
      ageDays: 0,
      content: `# Quick Capture

Unsorted thoughts. Process them during the weekly review ([[Weekly Review Checklist]]).

- [ ] Look into SQLite FTS5 ranking for [[Universal Search]] 📅 ${d(2)} #aether
- [ ] Reply to Jonas about the home lab rack #homelab
- [x] Order new keyboard switches
- [ ] Try the \`llama3.2:1b\` model for quick summaries 📅 ${d(-1)} #ai
- Idea: a "focus mode" that hides everything except the current note.
- Quote: "Simplicity is prerequisite for reliability." — Dijkstra
`,
    },
    {
      rel: "00-Inbox/Ideen fürs Wochenende.md",
      ageDays: 2,
      content: `---
tags: [privat, ideen]
---
# Ideen fürs Wochenende

Samstag soll es sonnig werden, also raus in die Natur.

- [ ] Wanderung am Müggelsee planen 📅 ${d(3)} #freizeit
- [ ] Sauerteig ansetzen (siehe [[Sauerteigbrot Rezept]]) 📅 ${d(2)}
- [ ] Fahrrad-Werkstatt anrufen
- Flohmarkt am Mauerpark? Nur wenn es nicht regnet.

Verknüpft mit [[Umzug Berlin]], weil wir die neue Gegend erkunden wollen.
`,
    },
    {
      rel: "00-Inbox/Reading List.md",
      ageDays: 5,
      content: `# Reading List

Articles and books I want to read. Finished ones get a note in resources.

- [x] Deep Work — Cal Newport → [[Book Deep Work]]
- [ ] "Local-first software" (Ink & Switch) → relevant for [[Local-first Sync]]
- [ ] "Designing Data-Intensive Applications", chapter 5 on replication
- [ ] Rust async book, pinning chapter → [[Rust Ownership]]
- [ ] "How to take smart notes" — Sönke Ahrens → [[Zettelkasten Methode]]

#reading
`,
    },
    {
      rel: "00-Inbox/Meeting Notes Team Sync.md",
      ageDays: 1,
      content: `---
date: ${d(-1)}
attendees: Mara, Jonas, Priya
tags: [meeting]
---
# Team Sync

## Agenda
1. Release plan for [[AETHER-OS Roadmap]]
2. Mock mode for browser previews
3. Crash reporting

## Decisions
- We ship v0.2 with a design system and a mock backend so designers can review in any browser.
- Crash reports stay local; nothing is uploaded.

## Action items
- [ ] Mara: review the new tokens 📅 ${d(1)} #design
- [ ] Jonas: CI pipeline for macOS + Linux 📅 ${d(4)} #infra
- [ ] Priya: write the onboarding copy 📅 ${d(6)}
- [x] Me: share the architecture doc
`,
    },
    {
      rel: "01-Projects/AETHER-OS.md",
      ageDays: 0,
      content: `---
status: active
area: "[[Career]]"
tags: [project, aether, rust, react]
---
# AETHER-OS

A local-first AI homestation: vault, AI chat, IDE, terminal, calendar and tasks in one desktop app built with Tauri 2, Rust and React.

## Pillars
- Knowledge: vault reader, [[Vector Search Basics]] and graph view.
- Build: IDE with LSP, git, terminal — see [[Tauri 2 Cheatsheet]].
- Life: calendar, tasks, [[Health]] tracking later.

## Architecture
Everything privileged lives in Rust (see [[Rust Ownership]] for the mental model). The UI talks through typed IPC only. Patterns I use in the frontend: [[React Patterns]].

![[aether-architecture.png|480]]

## Open questions
- Should sync use CRDTs? → [[Local-first Sync]]
- Full-text search engine → [[SQLite FTS5]]

## Tasks
- [ ] Write release notes for v0.2 📅 ${d(5)} #aether
- [ ] Record a demo video of mock mode 📅 ${d(7)} #aether
- [x] Split the IPC layer into domain modules
- [ ] Fix flaky terminal resize on Linux #bug

Roadmap: [[AETHER-OS Roadmap]]
`,
    },
    {
      rel: "01-Projects/AETHER-OS Roadmap.md",
      ageDays: 3,
      content: `---
tags: [project, aether, roadmap]
---
# AETHER-OS Roadmap

Part of [[AETHER-OS]]. Waves are integrated by the orchestrator.

\`\`\`mermaid
flowchart LR
  W1[Wave 1: Design system + Infra] --> W2[Wave 2: Features]
  W2 --> W3[Wave 3: QA + Docs]
  W2 --> S[Search]
  W2 --> C[Clipboard]
  W2 --> H[History]
  W3 --> R((Release v0.2))
\`\`\`

## Milestones
| Milestone | Target | State |
| --- | --- | --- |
| Design tokens | ${d(-4)} | done |
| Mock backend | ${d(0)} | in progress |
| Feature wave | ${d(10)} | planned |

- [ ] Freeze scope for Wave 2 📅 ${d(1)} #aether
- [ ] Draft changelog 📅 ${d(9)}

See also [[Universal Search]] and [[Local-first Sync]].
`,
    },
    {
      rel: "01-Projects/Universal Search.md",
      ageDays: 4,
      content: `# Universal Search

Launcher that searches notes, commands, clipboard and tasks at once. Belongs to [[AETHER-OS]].

Ranking idea: combine BM25 from [[SQLite FTS5]] with embedding similarity from [[Vector Search Basics]].

- [ ] Prototype the fuzzy matcher 📅 ${d(6)} #aether #search
- [ ] Measure latency with 10k notes

#search
`,
    },
    {
      rel: "01-Projects/Local-first Sync.md",
      ageDays: 8,
      content: `---
tags: [project, sync, research]
---
# Local-first Sync

Goal: sync the vault between laptop and desktop without a cloud account.

Options:
1. Git-based sync (simple, conflicts are text merges)
2. CRDT (Automerge) for real-time collaboration
3. Syncthing folder sync plus conflict files

Leaning towards option 1 for v0.2 because [[AETHER-OS]] already ships git support.

Why it matters :: Your data stays usable offline and never depends on a server.

- [ ] Compare Automerge vs. Yjs bundle size 📅 ${d(12)} #sync
`,
    },
    {
      rel: "01-Projects/Masterarbeit.md",
      ageDays: 1,
      content: `---
title: Masterarbeit
betreuer: Prof. Dr. Weber
abgabe: ${d(60)}
tags: [uni, masterarbeit]
---
# Masterarbeit: Retrieval-Augmented Generation für persönliche Wissensbasen

Forschungsfrage: Wie gut beantworten lokale Sprachmodelle Fragen über eine persönliche Notizsammlung, wenn der Kontext per Vektorsuche ausgewählt wird?

## Gliederung
1. Einleitung
2. Grundlagen: Embeddings und [[Vector Search Basics]]
3. Methodik: Evaluation mit eigenen Notizen
4. Ergebnisse
5. Diskussion

## Nächste Schritte
- [ ] Kapitel 2 überarbeiten 📅 ${d(3)} #uni
- [ ] Evaluationsdatensatz mit 50 Fragen erstellen 📅 ${d(10)} #uni
- [ ] Termin mit Betreuer vereinbaren 📅 ${d(-2)} #uni
- [x] Exposé abgeben

Literatur: [[Masterarbeit Literatur]]
`,
    },
    {
      rel: "01-Projects/Masterarbeit Literatur.md",
      ageDays: 6,
      content: `# Masterarbeit Literatur

Gehört zu [[Masterarbeit]].

- Lewis et al. (2020): Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks
- Karpukhin et al. (2020): Dense Passage Retrieval
- Reimers & Gurevych (2019): Sentence-BERT

Was ist RAG? :: Ein Sprachmodell bekommt zur Frage passende Dokumente als Kontext.
Was misst Recall@k? :: Anteil der relevanten Dokumente unter den Top-k Treffern.

#uni #literatur
`,
    },
    {
      rel: "01-Projects/Home Lab.md",
      ageDays: 9,
      content: `---
tags: [project, homelab]
---
# Home Lab

Small rack in the storage room: a Proxmox node, a NAS and a Raspberry Pi running Pi-hole.

## Services
- Ollama on the GPU box (see [[Ollama Setup Tutorial]])
- Gitea mirror of my repos
- Backups every night to the NAS

- [ ] Replace the NAS fan, it is getting loud #homelab
- [ ] Set up DNSSEC on the Pi-hole 📅 ${d(14)}
`,
    },
    {
      rel: "01-Projects/Garden Planner App.md",
      ageDays: 20,
      content: `# Garden Planner App

A side project: plan raised beds, track sowing dates, get reminders.

Stack: React Native + SQLite. Reuses ideas from [[React Patterns]].

![First sketch of the bed editor](garden-sketch.png)

- [ ] Sketch the bed editor UI
- [ ] Research companion planting data sets

#sideproject
`,
    },
    {
      rel: "01-Projects/Umzug Berlin.md",
      ageDays: 2,
      content: `---
tags: [privat, umzug]
umzugstermin: ${d(21)}
---
# Umzug Berlin

Neue Wohnung in Friedrichshain, Einzug in drei Wochen.

## Checkliste
- [x] Mietvertrag unterschreiben
- [ ] Umzugsfirma buchen 📅 ${d(2)} #umzug
- [ ] Adresse beim Bürgeramt ummelden 📅 ${d(24)} #umzug
- [ ] Internetanschluss beantragen 📅 ${d(5)} #umzug
- [ ] Kartons besorgen

Budget siehe [[Finanzen]]. Ideen für die neue Gegend: [[Ideen fürs Wochenende]].
`,
    },
    {
      rel: "02-Areas/Health.md",
      ageDays: 11,
      content: `---
tags: [area, health]
---
# Health

- Sleep target: 7.5 h, tracked with the watch.
- Training: 3× strength, 2× running per week.
- Deep work blocks help with stress, see [[Book Deep Work]].

- [ ] Book dentist appointment 📅 ${d(8)} #health
- [x] Renew gym membership
`,
    },
    {
      rel: "02-Areas/Finanzen.md",
      ageDays: 7,
      content: `---
tags: [area, finanzen]
---
# Finanzen

Monatliches Budget und Sparziele.

| Kategorie | Budget |
| --- | --- |
| Miete | 1.150 € |
| Lebensmittel | 400 € |
| Sparen | 600 € |

- [ ] Steuererklärung 2025 abschließen 📅 ${d(15)} #finanzen
- [ ] Umzugskosten kalkulieren für [[Umzug Berlin]] 📅 ${d(1)}
`,
    },
    {
      rel: "02-Areas/Career.md",
      ageDays: 14,
      content: `# Career

Focus this year: ship [[AETHER-OS]], finish the [[Masterarbeit]], give one conference talk.

Skills to deepen: Rust ([[Rust Ownership]]), system design, technical writing.

- [ ] Submit talk proposal to RustFest 📅 ${d(18)} #career
`,
    },
    {
      rel: "02-Areas/Weekly Review Checklist.md",
      ageDays: 7,
      content: `# Weekly Review Checklist

1. Empty the inbox ([[Quick Capture]]).
2. Review project notes, especially [[AETHER-OS]] and [[Masterarbeit]].
3. Check the calendar for the next two weeks.
4. Pick three priorities.

#review
`,
    },
    {
      rel: "03-Resources/Rust Ownership.md",
      ageDays: 25,
      content: `---
tags: [rust, learning]
source: The Rust Book, chapter 4
---
# Rust Ownership

Every value has exactly one owner; when the owner goes out of scope the value is dropped.

## Rules
1. Each value has one owner.
2. You can have many shared references (\`&T\`) or one mutable reference (\`&mut T\`).
3. References must never outlive the value.

\`\`\`rust
fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.len() > b.len() { a } else { b }
}
\`\`\`

What does the borrow checker prevent? :: Data races and use-after-free at compile time.
When is a value dropped? :: When its owner goes out of scope.

Related: [[Tauri 2 Cheatsheet]] #rust
`,
    },
    {
      rel: "03-Resources/Tauri 2 Cheatsheet.md",
      ageDays: 12,
      content: `---
tags: [tauri, rust, cheatsheet]
---
# Tauri 2 Cheatsheet

## Commands
Top-level command arguments are converted from snake_case to camelCase for JavaScript; nested structs keep their serde field names.

\`\`\`rust
#[tauri::command]
async fn cmd_greet(name: String) -> Result<String, String> {
    Ok(format!("Hello {name}"))
}
\`\`\`

## Events
\`app.emit("event-name", payload)\` in Rust, \`listen("event-name", cb)\` in the webview.

Used heavily in [[AETHER-OS]]. Ownership questions → [[Rust Ownership]].

#tauri
`,
    },
    {
      rel: "03-Resources/React Patterns.md",
      ageDays: 18,
      content: `# React Patterns

- Keep pure logic in plain modules so it is testable without a DOM.
- Colocate state; lift only when two siblings need it.
- Error boundaries around every view so one crash does not blank the app.
- Prefer derived state over syncing with effects.

Used in [[AETHER-OS]] and [[Garden Planner App]].

#react #frontend
`,
    },
    {
      rel: "03-Resources/Zettelkasten Methode.md",
      ageDays: 40,
      content: `---
tags: [pkm, methode]
---
# Zettelkasten Methode

Niklas Luhmann schrieb über 90.000 Zettel und verknüpfte sie miteinander. Die Kernidee: jede Notiz enthält genau einen Gedanken und wird mit bestehenden Notizen verlinkt.

## Prinzipien
- Atomare Notizen
- Eigene Worte statt Zitate
- Verknüpfungen sind wichtiger als Ordner

Beispiel für eine gute Verknüpfung: [[Book Deep Work]] ↔ [[Health]].

Was ist ein Zettel? :: Eine atomare Notiz mit genau einem Gedanken.

#pkm
`,
    },
    {
      rel: "03-Resources/Vector Search Basics.md",
      ageDays: 16,
      content: `---
tags: [ai, search, learning]
---
# Vector Search Basics

Text is turned into embeddings — dense vectors — by a model such as \`nomic-embed-text\`. Similar meaning ends up close together, measured with cosine similarity.

## Steps
1. Chunk and embed every note.
2. Store the vectors with the note path.
3. Embed the query and rank by cosine similarity.

Cosine similarity :: dot(a, b) / (|a| · |b|)

Foundation for the [[Masterarbeit]] and [[Universal Search]]. Setup: [[Ollama Setup Tutorial]].

#ai
`,
    },
    {
      rel: "03-Resources/SQLite FTS5.md",
      ageDays: 10,
      content: `# SQLite FTS5

Full-text search extension that ships with SQLite.

\`\`\`sql
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body);
SELECT title FROM notes_fts WHERE notes_fts MATCH 'rust*' ORDER BY rank;
\`\`\`

- \`rank\` is BM25 by default.
- Use the \`trigram\` tokenizer for substring search.

Planned for [[Universal Search]].

#sqlite #search
`,
    },
    {
      rel: "03-Resources/Sauerteigbrot Rezept.md",
      ageDays: 21,
      content: `---
tags: [rezept, backen]
portionen: 1 Laib
---
# Sauerteigbrot Rezept

![Frisch gebackenes Sauerteigbrot](attachments/sourdough.jpg)

## Zutaten
- 500 g Weizenmehl Type 550
- 350 g Wasser
- 100 g aktiver Sauerteig
- 10 g Salz

## Zubereitung
1. Mehl und Wasser mischen, 1 Stunde Autolyse.
2. Sauerteig und Salz einarbeiten.
3. Vier Mal dehnen und falten, je 30 Minuten Abstand.
4. Über Nacht im Kühlschrank gehen lassen.
5. Im Gusseisentopf bei 250 °C 20 Minuten mit Deckel, 25 Minuten ohne backen.

Passt zu den [[Ideen fürs Wochenende]]. #backen
`,
    },
    {
      rel: "03-Resources/Book Deep Work.md",
      ageDays: 33,
      content: `---
author: Cal Newport
rating: 4/5
tags: [book, productivity]
---
# Book: Deep Work

Deep work is professional activity performed in distraction-free concentration that pushes your cognitive capabilities to their limit.

## Takeaways
- Schedule deep work blocks like meetings.
- Embrace boredom; do not reach for the phone.
- Quit social media that does not serve a core goal.

Applied in [[Health]] and my [[Weekly Review Checklist]].

#book #productivity
`,
    },
    {
      rel: "03-Resources/Keyboard Shortcuts.md",
      ageDays: 13,
      content: `# Keyboard Shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | ⌘K |
| Quick capture | ⌘⇧N |
| Toggle sidebar | ⌘B |
| Search vault | ⌘⇧F |

Configured in [[AETHER-OS]].

#reference
`,
    },
    {
      rel: "03-Resources/Ollama Setup Tutorial.md",
      ageDays: 6,
      content: `---
title: Ollama Setup Tutorial
tags: [tutorial, ai, ollama]
difficulty: beginner
---
# Ollama Setup Tutorial

This tutorial walks through installing Ollama, pulling models, wiring it into [[AETHER-OS]] and verifying that semantic search works. It takes about fifteen minutes on a recent laptop.

## 1. Install Ollama

On macOS the easiest way is Homebrew:

\`\`\`bash
brew install ollama
ollama serve
\`\`\`

On Linux use the official install script and enable the systemd service so the server starts at boot. Windows users download the installer from the website.

Check that the server answers:

\`\`\`bash
curl http://localhost:11434/api/tags
\`\`\`

An empty model list (\`{"models":[]}\`) means the server runs but nothing is installed yet.

## 2. Pull a chat model

Pick a model that fits your RAM. As a rule of thumb, a 7B model in 4-bit quantisation needs roughly 5 GB of memory.

\`\`\`bash
ollama pull qwen2.5:7b      # good general model, supports tool calls
ollama pull llama3.2:1b     # tiny and fast, great for summaries
\`\`\`

Tip: smaller models are fine for summarising a single note; for questions across many notes the 7B model gives noticeably better answers.

## 3. Pull the embedding model

Semantic search needs an embedding model. AETHER-OS uses \`nomic-embed-text\`:

\`\`\`bash
ollama pull nomic-embed-text
\`\`\`

Embeddings are vectors; see [[Vector Search Basics]] for how the ranking works.

## 4. Connect AETHER-OS

1. Open AETHER-OS and go to **Settings → AI Providers**.
2. The Ollama status dot turns green when the server is reachable on \`localhost:11434\`.
3. Pick \`qwen2.5:7b\` as the default chat model.

## 5. Index the vault

Open **Search** and click **Index vault**. Every note is embedded once; re-indexing only needs to happen after bigger changes. The progress shows how many notes were indexed and how many were skipped (notes with less than ten characters are skipped on purpose).

## 6. Verify

Ask the AI chat something only your notes can answer, for example "What is the research question of my thesis?" The answer should reference [[Masterarbeit]].

## Troubleshooting

- **"model not found"** — run the \`ollama pull\` command shown in the error message.
- **Slow answers** — close other GPU-heavy apps or switch to a smaller model.
- **Port already in use** — another Ollama instance is running; \`pkill ollama\` and start again.
- **Dimension mismatch after changing the embedding model** — re-index the vault, vectors from different models cannot be mixed.

## Checklist
- [x] Install Ollama
- [x] Pull qwen2.5:7b
- [ ] Benchmark gemma2:2b against llama3.2:1b 📅 ${d(4)} #ai
- [ ] Document GPU settings for the [[Home Lab]] box

What port does Ollama listen on? :: 11434
Which model does AETHER-OS use for embeddings? :: nomic-embed-text

#tutorial #ollama
`,
    },
    {
      rel: `daily/${d(0)}.md`,
      ageDays: 0,
      content: `# ${d(0)}

## Focus
- Mock backend for browser previews ([[AETHER-OS]])
- Two pomodoros on [[Masterarbeit]]

## Log
- **08:45** — Planned the day, inbox zero.
- **10:30** — Finished the IPC split, all tests green.

- [ ] Call the moving company ([[Umzug Berlin]]) 📅 ${d(0)} #umzug
- [ ] Review Mara's design tokens 📅 ${d(0)} #design
`,
    },
    {
      rel: `daily/${d(-1)}.md`,
      ageDays: 1,
      content: `# ${d(-1)}

- **09:10** — Team sync, notes in [[Meeting Notes Team Sync]].
- **14:00** — Read two papers for [[Masterarbeit Literatur]].
- **18:30** — 5 km run. #health

- [x] Push the design-system branch
- [ ] Clean up the reading list ([[Reading List]])
`,
    },
    {
      rel: `daily/${d(-2)}.md`,
      ageDays: 2,
      content: `# ${d(-2)}

Heute war produktiv. Viel an der Gliederung der [[Masterarbeit]] gearbeitet.

- **11:00** — Wohnungsübergabe besprochen ([[Umzug Berlin]]).
- **16:20** — Sauerteig gefüttert.

- [x] Kapitel 1 Korrektur lesen
`,
    },
    {
      rel: `daily/${d(-3)}.md`,
      ageDays: 3,
      content: `# ${d(-3)}

- **10:00** — Roadmap review ([[AETHER-OS Roadmap]]).
- **15:45** — Home lab: replaced a network cable ([[Home Lab]]).

Mood: focused. #journal
`,
    },
    {
      rel: `daily/${d(-6)}.md`,
      ageDays: 6,
      content: `# ${d(-6)}

Weekly review done ([[Weekly Review Checklist]]). Priorities for next week:
1. Mock mode
2. Thesis chapter 2
3. Moving boxes

#review
`,
    },
  ];
}
