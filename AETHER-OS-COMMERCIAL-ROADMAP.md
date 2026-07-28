# AETHER-OS — Commercial Product Analysis & Execution Roadmap

> **Classification:** Internal strategy document  
> **Author:** Ekin — Medieninformatik, Hochschule der Medien Stuttgart  
> **Date:** July 2026  

---

## 1. Executive Summary

AETHER-OS is a local-first personal operating system built with Rust (Tauri v2) and React 19. It combines knowledge management, AI-assisted thinking, project orchestration, and persistent memory into a single desktop application that runs entirely on the user's machine.

**The thesis:** The productivity software market is splitting into two camps — cloud-locked SaaS (Notion, $600M ARR, 100M users) and local-first sovereign tools (Obsidian, $25M ARR, 1.5M users, zero VC). AETHER-OS targets the gap: the power user who wants local-first privacy AND built-in AI AND a real OS feel, without paying $20/user/month to a cloud provider.

---

## 2. Market Analysis

### 2.1 Market Size

| Segment | 2025 | 2030 | CAGR |
|---------|------|------|------|
| PKM Software | $1.8B | $5.2B | 14.2% |
| Personal Knowledge Base AI | $1.65B | $6.15B | 30.0% |
| Knowledge Management (broader) | $27.89B | $61.28B | 17.1% |
| Personal AI Assistant | $3.4B | $19.6B | 42% |

**Key insight:** AI-augmented PKM is growing at 30% CAGR — nearly double the base market. AETHER-OS is already in this high-growth segment.

### 2.2 Competitive Landscape

| Competitor | Users | Revenue | Strength | Weakness |
|-----------|-------|---------|----------|----------|
| Notion | 100M+ | $600M ARR | Teams, databases, AI agents | Cloud-locked, expensive |
| Obsidian | 1.5M | $25M/yr | Local-first, 4,264 plugins | No built-in AI, no terminal |
| Evernote | ~225M | ~$200M | Brand | Trust deficit, cloud-only |
| Apple Notes | ~1B | $0 (bundled) | Zero friction | Locked to Apple, no AI |
| Atlas Notes | Emerging | N/A | Voice, CRM, calendar | New, unproven |
| NeumanOS | Emerging | N/A | 60+ widgets | Browser-only (IndexedDB) |
| Sorana | Emerging | N/A | Spatial canvas, memory | Windows-only |
| Thoth | Emerging | N/A | 30 tools, 5 channels | Python, not desktop OS |

### 2.3 AETHER-OS Position

No competitor hits all three: **Local-first AND AI-native AND OS-grade.**

### 2.4 Target Personas

- **Sovereign Developer (60%):** Age 22-35, uses VS Code/Cursor/Devin, has Ollama. Values privacy. Pays $49-99 one-time.
- **Privacy Knowledge Worker (25%):** Age 28-45, consulting/research. Wants AI without feeding OpenAI. Pays $49 + sync.
- **Student/Academic (15%):** Age 18-25, limited budget. Free tier. Word-of-mouth growth.

---

## 3. Pricing Strategy

### 3.1 Model: Perpetual License + Optional Services

Subscription fatigue is real. Obsidian proved free + paid services = $25M/yr. Local-first audience values ownership.

### 3.2 Tiers

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | Full app, local AI, core features. No sync, no plugins. |
| Pro | $49 one-time | + terminal, clipboard, quick launcher, auto-git, plugins, editor, backlinks, daily notes. 12mo updates. |
| Pro+ | $99 one-time | + web clipper, agent actions, universal search, auto-compaction, priority support. 24mo updates. |
| Sync | $4/mo | E2E-encrypted sync, 3 devices. Works with Free or Pro. |
| Sync+ | $8/mo | 10GB sync, 5 devices, 30-day version history. |
| Team | $15/user/mo | Shared vaults, RBAC, audit logs. Phase 5+. |

### 3.3 Revenue Projections (Conservative)

| Year | Users | Paid | Revenue | Costs | Net |
|------|-------|------|---------|-------|-----|
| Y1 | 5K | 400 | $24K | $8K | $16K |
| Y2 | 25K | 2.5K | $160K | $30K | $130K |
| Y3 | 100K | 12K | $850K | $120K | $730K |
| Y4 | 300K | 42K | $3.2M | $400K | $2.8M |
| Y5 | 750K | 112K | $8.9M | $1.2M | $7.7M |

### 3.4 Payment Processing

- **Lemon Squeezy** (5% + $0.50) — one-time licenses, handles global VAT/tax
- **Stripe** (2.9% + $0.30) — recurring subscriptions (Sync/Team)
- Both integrate with license key systems via webhooks

---

## 4. Licensing Architecture

### 4.1 System: Keylight (Rust-native, Ed25519)

- Ed25519 signed offline leases — no network call to validate
- Machine-bound activation (device fingerprinting)
- Offline grace period (7 days configurable)
- Tauri v2 plugin with TypeScript bindings
- Entitlement-based feature gating

### 4.2 Flow

```
Purchase → Lemon Squeezy webhook → Keylight API → license key emailed
→ User enters key in AETHER-OS → Online activation → Signed lease in keychain
→ Local Ed25519 verify on every launch → Offline >7d → graceful Free tier
```

### 4.3 Entitlements

| Entitlement | Free | Pro | Pro+ |
|-------------|------|-----|------|
| core.* (notes, ai, projects, search, graph, dashboard) | ✓ | ✓ | ✓ |
| pro.terminal, pro.clipboard, pro.quick_launcher | — | ✓ | ✓ |
| pro.auto_git, pro.plugins, pro.editor, pro.backlinks | — | ✓ | ✓ |
| pro.daily_notes | — | ✓ | ✓ |
| proplus.web_clipper, proplus.agent_actions | — | — | ✓ |
| proplus.universal_search, proplus.auto_compaction | — | — | ✓ |
| proplus.priority_support | — | — | ✓ |

---

## 5. Current Architecture Audit

### 5.1 What Exists (v0.1)

**Backend (Rust/Tauri v2):** VaultReader, VectorEngine (lancedb), LocalAiEngine (Ollama streaming), AetherNotes, MemoryStore, ProjectCommands (scan, git, editor launch). 27 registered Tauri commands.

**Frontend (React 19):** Dashboard, AgentChat (streaming), SemanticSearch, VaultGraph (D3), AetherNotes, Projects, SettingsPanel, CommandBar (Cmd+K), Zustand store with localStorage.

### 5.2 Commercial Gaps

| Gap | Severity |
|-----|----------|
| No note editor (read-only) | Critical |
| No tests | Critical |
| No license system | Critical |
| No update mechanism | High |
| No crash reporting | High |
| No onboarding flow | Medium |
| No CI/CD pipeline | High |
| JSON storage (not SQLite) | Medium |
| No cross-platform builds | High |
| No accessibility | Medium |

---

## 6. Feature Roadmap — Commercial Edition

### Phase 0: Foundation (Weeks 1-3)

| Feature | What | Effort |
|---------|------|--------|
| 0.1 CI/CD | GitHub Actions: cargo test, clippy, npm test, build, tauri build (mac+linux+win) | 2d |
| 0.2 Test Suite | Rust integration tests, Vitest component tests, Playwright E2E. 80% backend / 70% frontend | 5d |
| 0.3 Auto-Update | Tauri updater plugin, signed updates from GitHub Releases | 1d |
| 0.4 Crash Reporting | Rust panic handler + React error boundary. Optional Sentry (opt-in) | 2d |
| 0.5 Onboarding | First-run wizard: vault path, Ollama check, model selection | 2d |
| 0.6 Cross-Platform | CI builds: macOS Universal, Linux AppImage+.deb, Windows NSIS | 3d |

### Phase 1: Core OS Layer (Weeks 4-8)

| Feature | What | Tech | Effort |
|---------|------|------|--------|
| 1.1 Terminal | PTY-backed, multi-tab, xterm.js, split panes | `portable-pty` + `@xterm/xterm` | 7d |
| 1.2 System Monitor | CPU/RAM/disk/network/battery, top processes, 2Hz refresh | `sysinfo` crate | 3d |
| 1.3 Clipboard Manager | System-wide history, searchable, pin, 500 items max | `arboard` crate + SQLite | 4d |
| 1.4 Quick Launcher | Cmd+Space, fuzzy search across everything | `tauri-plugin-global-shortcut` + `fuzzy-matcher` | 3d |

### Phase 2: Knowledge Engine (Weeks 9-16)

| Feature | What | Tech | Effort |
|---------|------|------|--------|
| 2.1 Note Editor | CodeMirror 6, live preview, wikilink/tag autocomplete, Vim mode | CodeMirror 6 | 8d |
| 2.2 Backlinks | Reverse link index, unlinked mentions, context previews | Rust scan + React panel | 3d |
| 2.3 Daily Notes | Auto-create `YYYY-MM-DD.md`, Cmd+Shift+N quick capture | Tauri global shortcut | 2d |
| 2.4 AI Agent Actions | Structured actions: create_note, run_command, web_search, summarize_url. Approval system. | JSON action parser + safety classifier | 6d |
| 2.5 Web Clipper | URL → fetch → extract content → Markdown note | `reqwest` + `scraper` | 3d |

### Phase 3: Productivity Layer (Weeks 17-22)

| Feature | What | Tech | Effort |
|---------|------|------|--------|
| 3.1 Kanban Tasks | Extract `- [ ]` from notes, drag-and-drop board, updates source file | `@hello-pangea/dnd` | 4d |
| 3.2 Calendar | Monthly view, due dates from frontmatter, ICS import/export, notifications | `ics` crate + `tauri-plugin-notification` | 5d |
| 3.3 Pomodoro | 25/5 timer, focus mode (dim UI), time tracking on dashboard | React timer + Zustand | 2d |
| 3.4 Bookmarks | Pin notes/projects/commands to sidebar, drag-to-reorder, groups | Zustand + localStorage | 2d |

### Phase 4: Intelligence Layer (Weeks 23-28)

| Feature | What | Tech | Effort |
|---------|------|------|--------|
| 4.1 Auto-Git Versioning | Auto-commit on file change, version history, diff viewer, restore | `notify` crate + `git2` | 4d |
| 4.2 AI Note Suggestions | Real-time related note suggestions while writing, auto-tag proposals | Vector similarity during editing | 3d |
| 4.3 Conversation Auto-Compaction | Summarize long conversations when token threshold exceeded | Ollama summarization + MemoryStore | 2d |
| 4.4 Universal Search | One search across notes, projects, conversations, memory, clipboard, files | Unified index: vector + BM25 + file | 4d |

### Phase 5: Extension Layer (Weeks 29-40)

| Feature | What | Tech | Effort |
|---------|------|------|--------|
| 5.1 Plugin System | Sandboxed JS/TS modules, plugin API (vault, AI, UI), manifest format | `deno_core` or Web Workers | 12d |
| 5.2 Export & Publishing | PDF export, HTML export, static site generation from vault | `printpdf` + static site gen | 5d |
| 5.3 E2E Sync | AES-256-GCM encrypted sync, relay server, conflict resolution | Rust sync engine + relay | 10d |
| 5.4 SQLite Migration | Migrate MemoryStore + AetherNotes + Clipboard from JSON to SQLite | `rusqlite` + migration scripts | 3d |
| 5.5 License Integration | Keylight SDK, activation UI, entitlement gating | `tauri-plugin-keylight` | 3d |
| 5.6 App Store Submission | macOS notarization, code signing, DMG packaging, potential Setapp | Apple Developer cert + CI | 3d |

---

## 7. Testing Strategy

### 7.1 Test Pyramid

| Layer | Tool | Coverage | What |
|-------|------|----------|------|
| Unit | `cargo test` / Vitest | 80% BE / 70% FE | Individual functions, parsers, indexers |
| Integration | `cargo test` (Tauri commands) | 90% of commands | Each Tauri command with real vault |
| E2E | Playwright (Tauri WebDriver) | Critical paths | Onboarding, create note, AI chat, search |
| Performance | `criterion` (Rust) | Key operations | Vault scan <1s for 1000 notes, search <100ms |

### 7.2 Critical Path Tests (Must pass before any release)

1. First-run onboarding completes successfully
2. Create vault → add note → edit note → save → verify on disk
3. AI chat with streaming → save conversation → verify in memory store
4. Semantic search returns relevant results after indexing
5. Project scan finds git repos → open in editor works
6. License activation (Pro) → entitlement-gated features unlock
7. App update → download → install → relaunch → new version
8. Cross-platform: all above on macOS, Linux, Windows

---

## 8. Go-To-Market Plan

### 8.1 Launch Sequence

| Stage | When | What | Goal |
|-------|------|------|------|
| Teaser | Week 8 (Phase 1 done) | GitHub README + screenshot, landing page email list | 500 signups |
| Beta | Week 16 (Phase 2 done) | Free beta via GitHub Releases, Product Hunt "coming soon" | 2,000 users |
| PH Launch | Week 22 (Phase 3 done) | Product Hunt launch, Hacker News Show HN, LinkedIn | 10,000 users |
| Commercial | Week 28 (Phase 4 done) | v1.0 with license system, paid Pro/Pro+ tiers | First revenue |
| Growth | Week 40+ | Plugin marketplace, sync service, team tier | Scale |

### 8.2 Channels

- **GitHub:** Open-source core (Free tier), stars as social proof, issues as feedback loop
- **Product Hunt:** Time launch for Tuesday/Wednesday, prepare maker comment
- **Hacker News:** Show HN with technical depth (Rust + Tauri + local AI)
- **LinkedIn:** Technical posts about architecture decisions, build-in-public
- **YouTube:** Short demos (60s) of each feature, one longer overview (10min)
- **Reddit:** r/productivity, r/obsidianmd (carefully), r/rust, r/selfhosted
- **Setapp:** Distribution partnership (macOS), recurring revenue, existing audience

### 8.3 Messaging

**Tagline:** "Your knowledge. Your machine. Your OS."

**Elevator pitch:** "AETHER-OS is a local-first personal operating system that combines Obsidian's knowledge management, a built-in terminal, and AI that actually knows your notes — all running on your machine, no cloud required."

**Anti-positioning:** "Notion owns your data. Obsidian doesn't have AI. AETHER-OS is what happens when you build both right."

---

## 9. Technical Architecture — Target State

```
Frontend (React 19 + TypeScript)
  ├── Dashboard (stats, activity, focus time)
  ├── Note Editor (CodeMirror 6 + live preview)
  ├── Agent Chat (streaming + action approval)
  ├── Terminal (xterm.js, multi-tab, split)
  ├── System Monitor (live charts)
  ├── Kanban Board (drag-and-drop tasks)
  ├── Calendar (monthly view + reminders)
  ├── Semantic Search (vector + keyword)
  ├── Vault Graph (D3 force-directed)
  ├── Clipboard Manager (searchable history)
  ├── Quick Launcher (Cmd+Space universal)
  ├── Settings (vault, AI model, editor, license)
  └── Plugin Runtime (sandboxed extensions)
       ↕ Tauri IPC
Backend Kernel (Rust)
  ├── Vault Engine (scan, read, write, backlinks, daily notes)
  ├── AI Engine (Ollama chat, embeddings, agent actions, suggestions, compaction)
  ├── Project Engine (scan, git, terminal PTY)
  ├── System Engine (monitor, clipboard, notifications)
  ├── Search Engine (universal: vector + BM25 + file index)
  ├── Storage Engine (SQLite: memory, notes, clipboard, tasks)
  ├── Sync Engine (AES-256-GCM, relay, conflict resolution)
  ├── License Engine (Keylight: activation, entitlements, offline verify)
  └── Plugin Runtime (deno_core: sandboxed JS execution)
       ↕
  Ollama (local LLM) | SQLite | File System | Git
```

---

## 10. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Ollama API breaking changes | Medium | High | Pin Ollama version, abstract API layer |
| Tauri v2 breaking changes | Low | High | Pin Tauri version, follow changelog |
| Apple notarization issues | Medium | Medium | Test early, maintain cert, automate in CI |
| User can't install Ollama | High | High | Bundle Ollama installer, or provide cloud AI fallback |
| Obsidian adds built-in AI | Medium | High | Differentiate with terminal, OS feel, agent actions |
| Notion adds local-first mode | Low | High | Differentiate with privacy, no subscription, terminal |
| Scope creep delays launch | High | Critical | Ship Phase 0-1 as beta, monetize at Phase 4 |
| Solo developer burnout | Medium | Critical | AI-assisted dev (Claude/Devin/Kimi), strict scope |

---

## 11. Development Strategy with AI Assistants

### 11.1 Tool Assignment

| Tool | Role | Best At |
|------|------|---------|
| Claude Code Max | Rust backend | Command modules, engine logic, tests, CI config |
| Devin | React frontend | Components, UI, state management, styling |
| Kimi 3 | Integration + docs | Glue code, documentation, test writing, code review |

### 11.2 Parallelization Rules

- **Never** have two AIs edit the same file simultaneously
- Backend and frontend can be developed in parallel (different file trees)
- Integration points: define IPC contract (command names + types) FIRST, then parallelize
- Daily merge: integrate work, run full test suite, fix conflicts

### 11.3 Quality Gates

Every AI-generated code must:
1. Pass `cargo clippy` with zero warnings
2. Pass `cargo test` for affected modules
3. Pass `npm run build` (TypeScript strict)
4. Pass `npm test` for affected components
5. Be reviewed by human (Ekin) before merge to main

---

## 12. Timeline Summary

| Phase | Weeks | Features | Output |
|-------|-------|----------|--------|
| Phase 0 | 1-3 | CI/CD, tests, updates, crash reporting, onboarding, cross-platform | Testable, shippable codebase |
| Phase 1 | 4-8 | Terminal, system monitor, clipboard, quick launcher | "It feels like an OS" |
| Phase 2 | 9-16 | Editor, backlinks, daily notes, agent actions, web clipper | "It replaces Obsidian" |
| Phase 3 | 17-22 | Kanban, calendar, pomodoro, bookmarks | "It replaces my todo app" |
| Phase 4 | 23-28 | Auto-git, AI suggestions, compaction, universal search | "It's smarter than me" |
| Phase 5 | 29-40 | Plugins, export, sync, SQLite, licensing, app store | "It's a product" |

**Total: 40 weeks (~10 months) to commercial v1.0**

**Beta at Week 16 (4 months) — usable product with editor + AI + terminal.**  
**Commercial launch at Week 28 (7 months) — paid product with licensing.**  
**Full v1.0 at Week 40 (10 months) — plugins, sync, app store.**

---

## 13. The North Star

AETHER-OS replaces:

- Activity Monitor → System Monitor
- Notes app → Vault with full editor
- Todo app → Kanban from notes
- Calendar app → Built-in calendar
- Spotlight → Quick Launcher
- Clipboard manager → Built-in history
- Terminal → Built-in PTY terminal
- ChatGPT/Claude → Local AI with your context
- Obsidian → Full knowledge management with AI

**One app. Your data. Your machine. Your OS.**
