# 🎓 Education Advisor

> **Education Advisor — the Tauri 2 desktop edition of the open-source multi-agent education management system.**
> Migrated from Electron 33. Same project, new platform. 18 specialized agents, privacy-preserving PII engine, cross-platform LLM orchestration, Rust data engine, and full local-first data ownership — now in a native Tauri shell with a Node.js sidecar.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Tauri](https://img.shields.io/badge/tauri-2-FFC131?logo=tauri&logoColor=black)](https://tauri.app)
[![Electron](https://img.shields.io/badge/electron-33%20(legacy)-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/react-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Rust backend](https://img.shields.io/badge/backend-Rust%20%2B%20eaa--cli-DEA584?logo=rust&logoColor=black)](https://github.com/232252/education-advisor)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](./CODE_OF_CONDUCT.md)

> 📖 **Read the full project introduction**: [`PROJECT_INTRO.md`](./PROJECT_INTRO.md)
> 📚 **Read the structured code wiki**: [`docs/CODE_WIKI.md`](./docs/CODE_WIKI.md)
> 📝 **Read the migration report**: [`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md)
> 🚀 **Just want to run it?** Jump to [Quick start](#-quick-start).
> 🤖 **Why is this open-source interesting?** Jump to [What makes it different](#-what-makes-it-different).

---

## Table of contents

- [What is this?](#-what-is-this)
- [What makes it different?](#-what-makes-it-different)
- [Screenshots & tour](#-screenshots--tour)
- [Architecture at a glance](#-architecture-at-a-glance)
- [Quick start](#-quick-start)
- [The 18 agents](#-the-18-agents)
- [Built-in tools & features](#-built-in-tools--features)
- [Configuration](#-configuration)
- [Build, package, distribute](#-build-package-distribute)
- [Build guide](#-build-guide) — [`BUILD.md`](./BUILD.md)
- [Project layout](#-project-layout)
- [Privacy, security, and the Rust bridge](#-privacy-security-and-the-rust-bridge)
- [Contributing](#-contributing)
- [Roadmap](#-roadmap)
- [FAQ](#-faq)
- [License & acknowledgments](#-license--acknowledgments)

---

## 🧭 What is this?

**Education Advisor** is a **cross-platform desktop application** — the **desktop edition** of [`education-advisor`](https://github.com/232252/education-advisor), the same open-source multi-agent system, now wrapped in a native-feeling UI.

This repository (`education-advisor-tuari`) is the **Tauri 2 edition**, migrated from the original Electron 33 build. The migration uses a **Tauri (Rust) shell + Node.js sidecar** architecture: the Rust shell owns the window and the lifecycle, while the entire original Electron main-process business logic (8200+ lines of services, handlers, agents) runs unchanged inside a Node sidecar via an `electron` API shim. The Rust `eaa-cli` remains the data engine. The original Electron entry (`src/main/index.ts`) is preserved so both modes coexist during the migration/testing period.

In plain English:

> If you are a **class teacher (班主任)** in a Chinese high school or middle school, and you spend too much of your day keeping track of "+2 / -3" conduct points, writing parent messages, generating weekly reports, and following up on at-risk students — **this app gives you a desktop cockpit** for all of that, powered by 18 cooperating AI agents that talk to your local data, your choice of LLM provider, and (optionally) a Feishu (Lark) workspace.

It is **not a chat bot**. It is **not a SaaS**. It is a **local-first desktop tool** that:

- Reads & writes a **Rust event-sourced event store** (the EAA CLI) — every action is auditable, every event is append-only, the data is yours.
- Runs **18 specialized agents** on schedule (cron) or on demand — each one has a clear role (academic, psychology, safety, weekly report, …) and a tight set of permissions.
- Encrypts **all PII** (student names, IDs, phone numbers, addresses) with **AES-256-GCM** before anything leaves the machine.
- Speaks to **30+ LLM providers** through the bundled [`@earendil-works/pi-ai`](https://www.npmjs.com/) SDK — including OpenAI, Anthropic, Google, Mistral, DeepSeek, Qwen, Doubao, Zhipu, Ollama, LM Studio, and any OpenAI-compatible endpoint.
- Syncs to **Feishu Bitable** so the whole teaching team can see the same numbers in the same spreadsheet.
- Ships as a **Windows installer (NSIS + MSI) and a standalone .exe** out of the box via `tauri build`, with macOS / Linux targets one config flip away. The legacy Electron packaging path (`npm run package`) is also retained for backward compatibility.

---

## ✨ What makes it different?

There are a lot of "AI for education" tools. Here's what we think is genuinely different about this one:

### 1. **Truly local-first, with a Rust spine**
Every byte of student data lives in a Rust-managed event store on your disk. The LLM is the only thing that talks to the network, and only with the slice of data it needs. The Rust CLI handles **all** reads, writes, validation, concurrency (file locks), atomic persistence (`tmp → fsync → rename`), and PII encryption. The AI layer is intentionally **stateless and replaceable** — you can swap out GPT-4o for Qwen 4B, run the same agents, get the same data, pay nothing per query.

### 2. **18 cooperating agents, not one chat**
The 18 agents aren't "personalities" — they are **role-defined worker bees** with explicit permission scopes:

- `class-monitor` records a +2 / −3 conduct point
- `risk-alert` correlates 14-day trends and flags a kid who's slipping
- `weekly-reporter` drafts Friday's class report
- `validator` cross-checks that `class-monitor`'s math matches the event log
- `psychology` watches for warning signs and never **writes** events — only flags

This is closer to a **teaching-team operating system** than a chatbot.

### 3. **The "small model rulebook"**
We deliberately designed every agent's prompt to work with **3–4B parameter models**. Run Qwen 3.5 4B on a 6 GB GPU and the system still works — because the agents are constrained by **tools, not by vibes**. Every number must come from a tool call, every write must be authorized, every output is validated against a JSON schema. See [`config/SMALL_MODEL_RULES.md`](./config/SMALL_MODEL_RULES.md) for the 5 ironclad rules.

### 4. **PII is opt-in, reversible, and audited**
Privacy is not a checkbox. The Rust PII engine builds a per-install **encrypted mapping table** (AES-256-GCM) from "Alice" to `S_017`, and exposes 11 IPC operations: `init`, `load`, `enable`, `disable`, `list`, `add`, `anonymize`, `deanonymize`, `filter` (per recipient!), `dryrun`, `backup`. You can hand an LLM your entire class list anonymized, then re-hydrate names only in the final report that goes to a parent.

### 5. **Reproducible builds, no surprises**
`npm ci` → `npm run tauri:build` produces a native Windows NSIS + MSI installer (modulo timestamps) on any Windows machine with Node 22 and the Rust toolchain. No hidden system state, no opaque installers, no "magic" native modules beyond `better-sqlite3` and the Rust EAA binary. The whole supply chain is in this repo.

---

## 📸 Screenshots & tour

> _Screenshots will be added in the first release tag. The product pages are:_

| Page | Route | Purpose |
| --- | --- | --- |
| **Dashboard** | `#/dashboard` | Top-line numbers: today's events, weekly trends, top movers |
| **Chat** | `#/chat` | Talk to any agent, stream responses, full tool-call visibility |
| **Students** | `#/students` | Roster, conduct scores, history, profile expansion |
| **Agents** | `#/agents` | The 18-agent control panel — enable, disable, edit SOUL.md |
| **Models** | `#/models` | LLM providers, API keys, custom models, model tier assignment |
| **Skills (能力中心)** | `#/skills` | 3 Tab 工作台:Markdown 技能 / MCP 服务器管理(stdio·sse·websocket 三种传输 + 预设模板) / 插件(预留) |
| **Scheduler** | `#/scheduler` | Cron jobs across all agents, logs, manual triggers |
| **Privacy** | `#/privacy` | PII mapping table, anonymization, per-recipient filtering |
| **Settings** | `#/settings` | Theme, language, log level, update channel, factory reset |

---

## 🏗️ Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│              Renderer (React 18 + Vite + Tailwind)               │
│  Dashboard · Chat · Students · Agents · Models · Skills · ...    │
│  Zustand stores · i18n (zh/en) · 9 routes · 12 hooks             │
│  window.api (tauri-bridge.ts, signature-compatible with preload) │
└────────────────────────┬─────────────────────────────────────────┘
                         │  Tauri invoke('ipc_invoke', {channel, args})
                         │  115 IPC channels · 1 type-safe surface
┌────────────────────────▼─────────────────────────────────────────┐
│            Tauri 主进程 (Rust · src-tauri/)                       │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────────────┐   │
│  │ ipc_invoke │  │ sidecar.rs  │  │ sys_bridge.rs            │   │
│  │  命令      │──│ spawn(node) │  │ openExternal/dialog/path │   │
│  │            │  │ stdio RPC   │  │ (Tauri 原生插件)         │   │
│  └────────────┘  │ → window.emit│  └──────────────────────────┘   │
│  插件: shell / dialog / notification / os / single-instance      │
└────────────────────────┬─────────────────────────────────────────┘
                         │  stdio JSON-RPC (newline-delimited)
┌────────────────────────▼─────────────────────────────────────────┐
│     Node Sidecar (dist/sidecar/sidecar.mjs · electron-shim)      │
│  ┌────────────────────┐  ┌───────────────────────────────────┐   │
│  │ electron-shim.ts   │  │ 复用原 Electron 全部业务(零改动)   │   │
│  │ ipcMain/app/       │  │ 13 IPC handler · 20+ service      │   │
│  │ BrowserWindow/...  │  │ agent/pi-ai/eaa-bridge/cron/db/   │   │
│  └────────────────────┘  │ feishu/ollama/keystore/...        │   │
│         18 agents ───────┤ governed by config/agents.yaml     │   │
│  triggered by node-cron  └────────────────┬──────────────────┘   │
└──────────────────────────────────────────┬───────────────────────┘
                         │  cross-spawn (stdin/stdout JSON)
┌────────────────────────▼─────────────────────────────────────────┐
│         eaa-cli  (Rust · events · privacy · dashboard)           │
│   https://github.com/232252/education-advisor  (same project)   │
└──────────────────────────────────────────────────────────────────┘
```

> **Migration design**: the original Electron main-process code is reused unchanged inside the Node sidecar via an `electron` API shim (`src/sidecar/electron-shim.ts`). The renderer talks to `window.api`, which `tauri-bridge.ts` reconstructs with signatures identical to the Electron preload. This gives 100% feature parity with zero business-code changes. See [`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md) and [`docs/CODE_WIKI.md`](./docs/CODE_WIKI.md) for the full breakdown.

Read the full architecture breakdown in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## 🚀 Quick start

> **Prerequisites**: Node.js ≥ 22, npm ≥ 10, [Rust toolchain](https://rustup.rs/) (for the Tauri build), and a working C++ toolchain on your platform (so `better-sqlite3` can build its native binding).

### 1. Clone & install

```bash
git clone https://github.com/232252/education-advisor.git
cd education-advisor
npm ci
```

### 2. Fetch the Rust backend

The Rust `eaa-cli` binary is the data engine of this same `education-advisor`
project — it is the same Rust code that powered the v3.x CLI-only release,
shipped to this app as a pre-built binary per platform.

```bash
npm run build:eaa
```

This downloads the latest release of `eaa-cli` for your platform into `resources/eaa-binaries/`.
You can also build it yourself from source — see [`docs/EAA_BRIDGE.md`](./docs/EAA_BRIDGE.md).

### 3. Run in development mode (Tauri — recommended)

```bash
npm run tauri:dev
```

This single command:

1. builds the Node sidecar bundle (`vite build --config vite.config.sidecar.ts`)
2. invokes `tauri dev`, which compiles the Rust shell (`src-tauri/`), spawns the sidecar, and opens the native Tauri window.

The renderer is served by Tauri's built-in dev server with HMR. The original Electron dev path (`npm run dev` + `npm run dev:electron`) is also retained as a fallback — see [Build, package, distribute](#-build-package-distribute) below.

### 4. Build a release (Tauri — recommended)

```bash
npm run tauri:build
```

This produces native installers in `src-tauri/target/release/bundle/`:

- `nsis/Education Advisor_0.1.0_x64-setup.exe` — Windows NSIS installer
- `msi/Education Advisor_0.1.0_x64_en-US.msi` — Windows MSI installer

> 📖 **完整构建流程见 [`BUILD.md`](./BUILD.md)** —— 环境要求、分步构建、产物说明、清理重建与常见问题排查的权威指南。

The legacy Electron packaging path (`npm run build` + `npm run package`) is also retained for backward compatibility and produces `release/Education Advisor-Setup-0.1.0.exe`.

### 5. First-run checklist

When the app opens, go to `#/settings` and:

- Pick a theme (light / dark / system) and a language (中文 / English).
- Add at least one LLM API key in `#/models`.
- (Optional) Configure Feishu credentials in `#/settings` → Feishu panel.
- (Optional) Initialize the privacy engine in `#/privacy`.

Then visit `#/agents`, click **Run manual** on `class-monitor`, and add a conduct event. The whole pipeline will fire end-to-end.

---

## 🤖 The 18 agents

Every agent is a **plain Markdown file pair** — `SOUL.md` (personality + scope) and `AGENTS.md` (working rules) — plus a YAML registration entry in [`config/agents.yaml`](./config/agents.yaml). The main process loads them on boot, decorates them with the small-model rulebook, and registers them with the agent loop.

| # | Agent | Role | Tier | Cadence | Capability scope |
|---|-------|------|------|---------|------------------|
| 1 | `main` | Education advisor coordinator | high-quality | on demand | All read + push + scheduling |
| 2 | `governor` | Inspector general (复盘 + 校验) | low-cost | 6× daily + weekly | read · summary · range · stats · ranking |
| 3 | `counselor` | Counselor (谈话计划 + 学业日报) | low-cost | 2× daily | read · summary · ranking · add-event |
| 4 | `supervisor` | Daily digest officer | low-cost | 3× daily | read · summary · ranking · stats · range |
| 5 | `validator` | Data auditor | low-cost | every 6h | read · stats · codes |
| 6 | `academic` | Academic analyst | high-quality | 1× daily | read · summary · stats · ranking |
| 7 | `psychology` | Psychology watcher | low-cost | 1× daily | read · search · history · summary |
| 8 | `safety` | Safety inspector | low-cost | Mon 08:00 | read · add-event |
| 9 | `home_school` | Family-school liaison | low-cost | 1× daily | read · summary · ranking |
| 10 | `research` | Research assistant | low-cost | 1× nightly | read · summary · stats |
| 11 | `executor` | System executor | low-cost | 1× nightly | read · stats · codes |
| 12 | `bug-hunter` | Bug hunter (agent self-test) | low-cost | on demand | read only |
| 13 | `class-monitor` | Class monitor | low-cost | on demand | read · add-event · list · summary |
| 14 | `risk-alert` | Risk alerter | low-cost | 2× daily + Fri | read · ranking · stats · summary · range |
| 15 | `data-analyst` | Data analyst | high-quality | Mon 09:00 | read · stats · ranking · summary · range |
| 16 | `student-care` | Student-care officer | low-cost | on demand | read · history · search · list · ranking · summary · add-event |
| 17 | `discipline-officer` | Discipline officer | low-cost | on demand | read · add-event · ranking · history |
| 18 | `weekly-reporter` | Weekly reporter | high-quality | Fri 16:00 | read · summary · stats · ranking · range |

Writing a new agent? Read [`docs/AGENT_AUTHORING.md`](./docs/AGENT_AUTHORING.md).

---

## 🛠️ Built-in tools & features

- **Multi-LLM orchestration** — 30+ providers through `pi-ai`, model-tier routing (high-quality vs low-cost), per-agent cost caps, custom-model registration, OAuth login, automatic failover, retry with backoff.
- **Streaming chat** — full Server-Sent-Event-style streaming from the LLM to the renderer, with abort, follow-up, and steering modes.
- **Compaction** — automatic context compaction when the conversation window fills up, with a configurable threshold.
- **Cron scheduler** — `node-cron` with hot-reload, manual `run now`, per-task log, and Feishu Bitable sync hooks.
- **SQLite persistence** — `better-sqlite3` for chat history, cron logs, agent execution history, session metadata. Schema is auto-migrated on first run.
- **System tray** — show / hide / quit, balloon notifications, "minimize to tray on close" option.
- **Auto-update** — checks the GitHub Releases endpoint on a configurable interval, prompts the user, downloads in the background, applies on next launch.
- **Logging** — 5-level logger (`debug` / `info` / `warn` / `error` / `fatal`), 3 rotating files, console hijack for the renderer, level filtering, full-text search, export to file.
- **i18n** — full Chinese / English support across all 9 pages, 200+ keys, hot-swap at runtime, persisted in localStorage.
- **Theming** — light / dark / system-follows-OS, CSS variables, no FOUC.
- **Keyboard shortcuts** — `Ctrl+N` (new chat), `Enter` (send), `Esc` (abort), navigation hotkeys, all remappable in Settings.
- **File sandboxing** — all file writes go through a tool layer that sanitizes paths, blocks `..` traversal, and respects a per-call working directory.
- **Excel / CSV import-export** — drag a spreadsheet onto the Students page and the Rust side will parse, validate, and bulk-insert. Export handles proper Chinese encodings and BOM.

---

## ⚙️ Configuration

The app reads its configuration from three places, in order of precedence (highest first):

1. **In-app Settings page** (`#/settings`) — runtime config, persisted to `userData/settings.json`.
2. **`config/` directory** in the installation — defaults shipped with the app. Editable on disk.
3. **Hard-coded fallbacks** in `src/main/services/settings-service.ts` — for first-run.

The shipped [`config/agents.yaml`](./config/agents.yaml) is the canonical registry of all 18 agents — their `id`, `role`, `model_tier`, `capabilities` (least-privilege), `schedule.cron`, and `risk_thresholds`. Open it in any editor; it's a single file you can read top to bottom in five minutes.

For a deep dive, see [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md).

---

## 📦 Build, package, distribute

### Tauri (primary, recommended)

| Command | Output | Purpose |
| --- | --- | --- |
| `npm run tauri:dev` | Tauri dev window + HMR | Day-to-day development (builds sidecar + Rust shell + renderer) |
| `npm run tauri:build` | `src-tauri/target/release/bundle/{nsis,msi}/*` | Production Windows NSIS + MSI installers |
| `npm run build:sidecar` | `dist/sidecar/sidecar.mjs` | Build only the Node sidecar bundle |
| `npm run build:tauri` | `dist/main/*` + `dist/renderer/*` + `dist/sidecar/*` | Build all three JS bundles for Tauri |

### Electron (legacy, retained for compatibility)

| Command | Output | Purpose |
| --- | --- | --- |
| `npm run dev` | dev server on `:5173` | Electron main + renderer dev with HMR |
| `npm run dev:electron` | Electron window | Launch the Electron shell against the dev build |
| `npm run build` | `dist/main/*` + `dist/renderer/*` | Production bundle, no installer |
| `npm run package` | `release/Education Advisor-Setup-0.1.0.exe` | Windows NSIS installer (Electron) |
| `npm run package:portable` | `release/Education Advisor-0.1.0-Portable.exe` | Single-file Windows portable (Electron) |
| `npm run package:installer` | same as `package` | Explicit target name |

### Shared tooling

| Command | Output | Purpose |
| --- | --- | --- |
| `npm run typecheck` | exit code | `tsc --noEmit` |
| `npm run lint` | exit code | `biome check src/` |
| `npm run test` | test report | `vitest run` |
| `npm run clean` | — | `rimraf dist release` |

For macOS / Linux Tauri targets, edit [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json) `bundle.targets` and add the `app`/`dmg`/`deb`/`appimage` targets — we kept the configuration Windows-first because that's where the maintainer-team runs it. For the legacy Electron path, edit [`electron-builder.yml`](./electron-builder.yml). See [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md) for the full guide.

---

## 📁 Project layout

```
education-advisor-tuari/
├── src/
│   ├── main/                # Electron main process (33 files) — legacy entry, preserved
│   │   ├── ipc/             #   11 IPC handler modules
│   │   ├── services/        #   13 service modules (agent, EAA, cron, ...)
│   │   ├── preload/         #   contextBridge bridge
│   │   ├── utils/           #   logger, etc.
│   │   └── index.ts         #   main entry (Electron mode)
│   ├── sidecar/             # Node sidecar (Tauri mode) — reuses src/main/* unchanged
│   │   ├── sidecar-entry.ts #   sidecar bootstrap + stdin/stdout JSON-RPC loop
│   │   ├── electron-shim.ts #   mocks ipcMain/app/BrowserWindow/dialog/shell/...
│   │   └── wire-protocol.ts #   newline-delimited JSON wire message types
│   ├── renderer/            # React 18 renderer (23 files)
│   │   ├── pages/           #   9 page modules
│   │   ├── components/      #   shared UI
│   │   ├── hooks/           #   12 custom hooks
│   │   ├── stores/          #   4 Zustand stores
│   │   ├── i18n/            #   zh + en
│   │   ├── lib/             #   typed IPC client + tauri-bridge.ts
│   │   └── main.tsx         #   renderer entry (auto-detects Tauri vs Electron)
│   └── shared/              # Code shared by main + sidecar + renderer
│       ├── ipc-channels.ts  #   90+ channel constants
│       └── types/           #   539 lines of shared TypeScript types
├── src-tauri/               # Tauri 2 Rust shell (NEW — the migration target)
│   ├── src/
│   │   ├── main.rs          #   Tauri main entry — plugins + 4 invoke commands
│   │   ├── sidecar.rs       #   SidecarHandle: spawn/request/shutdown, stdio RPC
│   │   └── sys_bridge.rs    #   Tauri-native reimplementations of Electron APIs
│   ├── Cargo.toml           #   tauri + plugins (shell/dialog/notification/os/...)
│   ├── tauri.conf.json      #   identifier, bundle targets (nsis/msi), resources
│   └── icons/               #   app icons per platform
├── core/eaa-cli/            # Rust data engine (eaa v3.2.2, 27 subcommands)
├── agents/                  # 18 agents × (SOUL.md + AGENTS.md)
├── config/                  # agents.yaml, reason-codes.json, default-settings.json
├── docs/                    # Full documentation (CODE_WIKI.md, ARCHITECTURE.md, ...)
├── resources/               # Icons, Rust EAA binaries per platform (eaa-binaries/)
├── scripts/                 # Dev-time tools (prebuild-check, build-eaa, self-check, ...)
├── skills/                  # User-injected Markdown skills
├── single-agent/            # "Single-agent mode" fallback prompt
├── examples/                # Example student records (anonymized)
├── tests/                   # Vitest suites (main + e2e)
├── test-volume-data/        # Stress-test data (101 students, 193K+ events)
├── electron-builder.yml     # Legacy Windows installer config (Electron)
├── vite.config.main.ts      # Main-process Vite config
├── vite.config.renderer.ts  # Renderer Vite config
├── vite.config.sidecar.ts   # Sidecar Vite config (NEW)
├── vitest.config.ts         # Two-project test config
├── biome.json               # Linter + formatter config
├── tsconfig.json            # TS config with path aliases
├── .env.example             # Environment-variable template
├── .editorconfig            # Editor defaults
├── .gitignore               # Comprehensive ignore rules
├── MIGRATION_REPORT.md      # Electron → Tauri migration report (NEW)
├── CHANGELOG.md             # Version history
├── CODE_OF_CONDUCT.md       # Community standards
├── CONTRIBUTING.md          # How to contribute
├── DEPLOY_TO_AI.md          # AI-assisted setup guide
├── LICENSE                  # MIT
├── PROJECT_INTRO.md         # Detailed project introduction
├── README.md                # You are here
├── ROADMAP.md               # Future plans
└── SECURITY.md              # Security policy
```

---

## 🛡️ Privacy, security, and the Rust bridge

The Rust EAA CLI is a **separate compilation unit** that this app spawns as a child process.
We deliberately did **not** ship the Rust source in this repo's `dist/` (it lives in
[`core/eaa-cli/`](./core/eaa-cli/) in this same repository), for two reasons:

1. **Separation of concerns.** The Rust side is a stable, audited data engine. The TS side
   is where the agents, the UI, and the LLM integration live. Keeping the Rust data engine
   in its own crate lets it be reviewed and re-used independently — it is the same binary
   that powers the headless CLI-only deployment.
2. **Reproducible builds.** When you `npm run build:eaa`, you get a **specific tagged
   binary** for your platform. You can also build it from source with
   `cargo build --release` inside `core/eaa-cli/`. See [`docs/EAA_BRIDGE.md`](./docs/EAA_BRIDGE.md)
   for instructions.

In the Tauri edition, the process topology is:

```
Tauri window (Rust shell)
   └─ spawns → Node sidecar (electron-shim + all original services)
                  └─ spawns → eaa-cli (Rust data engine, file-locked event store)
```

The Node sidecar inherits all the original Electron main-process security properties
(sandboxed file tool layer, `..` traversal blocking, per-call working directory), and the
Rust EAA CLI retains its AES-256-GCM PII mapping, append-only event log, advisory file
locks, and atomic `tmp → fsync → rename` writes. The Tauri Rust shell itself only handles
window lifecycle, native dialogs, notifications, and single-instance enforcement — it never
touches student data directly.

For the full security policy — including the PII engine's threat model, our CVE reporting
process, and supported versions — see [`SECURITY.md`](./SECURITY.md).

---

## 🤝 Contributing

We welcome pull requests, bug reports, feature requests, and translations. Start with
[`CONTRIBUTING.md`](./CONTRIBUTING.md); it covers the developer workflow, the coding
standards, the commit-message format, and how to add a new agent. By participating, you
agree to abide by the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

**Good first issues** are tagged [`good first issue`](https://github.com/232252/education-advisor/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
in the issue tracker.

---

## 🗺️ Roadmap

The 12-month plan is in [`ROADMAP.md`](./ROADMAP.md). Highlights:

- **Q3 2026** — Multi-class support (one teacher, N parallel classes)
- **Q4 2026** — macOS & Linux release tiers, signed installers, auto-update channel
- **Q1 2027** — Plugin marketplace for community-contributed agents & skills
- **Q2 2027** — Voice channel (push-to-talk during class) with on-device transcription

---

## ❓ FAQ

**Q: Is this a Chinese-only product?**
A: The UI and the data (student names, classes, schools) are inherently Chinese. The code, the prompts, and the developer documentation are bilingual. The agent prompts can be edited to any language.

**Q: Does it work without the internet?**
A: The app works fully offline. Only the LLM calls need network. If you point it at Ollama / LM Studio on `localhost`, the whole stack runs offline.

**Q: Can I delete the Rust EAA dependency?**
A: Yes — every IPC call to EAA is a single funnel (`src/main/services/eaa-bridge.ts`). You can swap it for any other data engine (PostgreSQL, Firestore, your own service) by replacing that file. The agent prompts and the UI are decoupled.

**Q: Why Tauri and not Electron?**
A: The project started on Electron 33 and has since been migrated to Tauri 2. The Tauri edition uses a Rust shell + Node sidecar architecture that reuses 100% of the original Electron business code (via an `electron` API shim) with zero changes, while dropping the bundled Chromium runtime for a much smaller native binary. The original Electron entry is preserved in `src/main/index.ts` so both modes coexist during the migration/testing period. See [`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md) for the full breakdown.

**Q: How big is the bundled installer?**
A: The Tauri NSIS installer is ~15–25 MB on Windows x64 (no Chromium runtime — it uses the OS WebView2), plus the ~20 MB Rust EAA binary and your code/configs/agents. The legacy Electron installer is ~85 MB (NSIS) / ~75 MB (portable), dominated by the Chromium runtime.

**Q: How do I add a new agent?**
A: Read [`docs/AGENT_AUTHORING.md`](./docs/AGENT_AUTHORING.md). The TL;DR: drop a `SOUL.md` and an `AGENTS.md` into `agents/your-id/`, add an entry to `config/agents.yaml`, restart the app. That's it.

---

## 📄 License & acknowledgments

This project is released under the [MIT License](./LICENSE). You are free to use it in
commercial products, in schools, in research, and to fork it.

**Acknowledgments**

- The [`pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) and
  [`pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) packages
  from `earendil-works` — the LLM SDK and the agent loop that power this app.
- The [`Tauri`](https://tauri.app/) team for the Rust-based desktop shell that made the
  migration from Electron possible — and for the `tauri-plugin-shell/dialog/notification/os`
  ecosystem that replaced Electron's native APIs.
- The [`@electron`](https://www.electronjs.org/) team for the original runtime — the
  business code still runs on Node, and the `electron` API shim keeps it compatible.
- The [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) maintainers — the
  fastest synchronous SQLite binding in the Node ecosystem.
- The Rust [`tokio`](https://tokio.rs/) / [`serde`](https://serde.rs/) / [`clap`](https://clap.rs/)
  crates that the EAA CLI is built on.
- Every teacher who has ever lost sleep over a "+2 conduct point that should have been +3"
  — this app is for you.

---

**If this project helps you, please ⭐ star the repo — it helps others find it.**
**让教育更智能，让教师更轻松。**
