# ◈ ay-dsh-vscode

**A Kilo Code-style AI coding agent for VS Code, powered by the DeepSeek Harness (DSH) runtime.**

Not just a "chat + autocomplete" wrapper — this extension embeds the **official DSH Agent runtime** (the same engine behind the `dsh` CLI and `dsh web`) directly into VS Code, bringing you: multi-agent orchestration, long-running goal-oriented tasks, full tool-call transparency, and a real sandbox with interactive approvals.

> 🌐 [中文文档 / Chinese README](README.zh-CN.md)

---

## Why stronger than a typical coding assistant

| Capability | Typical assistants | ay-dsh-vscode |
| --- | --- | --- |
| **Multi-agent orchestration** | ❌ single agent | ✅ built-in `subagent` / `subagent_fork` / `send_message` |
| **Workflows** | ❌ | ✅ built-in `workflow` tool: fan out one task to multiple agents in phases |
| **Long-running goals** | lost on interruption | ✅ built-in `goal` tools: objectives persist across rounds, auto-continue, resumable |
| **Tool transparency** | tool name only | ✅ streaming tokens, tool args/results inline, reasoning collapsible, token usage |
| **Real sandbox** | static confirm dialogs | ✅ true sandbox: `workspace-write` denies out-of-scope writes; one-time escalation prompts |
| **Plan mode** | ❌ | ✅ built-in plan mode: plan first, execute after approval |
| **Session logs** | proprietary | ✅ standard DSH JSONL logs, reusable by the `dsh` CLI |

## Features

- 🗨️ Sidebar chat: streaming output, collapsible reasoning, markdown rendering
- 🛠️ Tool calls rendered as inline blocks (args + results always visible)
- 🔐 Approval dialogs for permission escalation (allow / deny, one-time grants)
- ⚡ Editor integration: explain selection, run agent on selection, fix file diagnostics
- 🕘 Session history: list / resume / delete, plus one-click **full-session export** to a browser page
- 🔄 New session / stop / model switch; lazy session creation (no junk sessions)
- 🧠 Full DSH toolset: file read/write/edit, glob/grep, PowerShell, web search, subagents, workflows, goals, Ralph loops
- 🗂️ Complete isolation from official DSH data (own home directory, own session store)

## Requirements

- **Node.js ≥ 20** (22+ recommended)
- **VS Code ≥ 1.90** (with the `code` CLI on PATH)
- A **DeepSeek API Key** ([platform.deepseek.com](https://platform.deepseek.com))

> 💡 No prior DSH installation needed: the DSH kernel is bundled inside the VSIX — fully self-contained, offline-installable.

## Quick start (one-click deploy)

> ⭐ **Recommended: download the latest stable release from [GitHub Releases](https://github.com/kele688/ay-dsh-vscode/releases)** — every release is a verified, self-contained snapshot.
>
> Build and install from source:
```powershell
cd ay-dsh-vscode
npm run deploy
```

The script automates: `npm install` → `npm run build` (esbuild) → `npm run package` (vsce VSIX) → `code --install-extension` (install into VS Code).

Manual steps:

```powershell
npm install
npm run build
npm run package          # output: release/ay-dsh-vscode.vsix
code --install-extension release\ay-dsh-vscode.vsix --force
```

### Configuration

Open the panel and click the **⚙ gear** (or run `DSH: Configure`) for the graphical wizard:

| Setting | Description | Default |
| --- | --- | --- |
| API Key (secret store) | DeepSeek API Key; falls back to `DEEPSEEK_API_KEY` env | — |
| `dshVscode.model` | Model id (`deepseek-v4-flash` / `deepseek-v4-pro` / custom) | `deepseek-v4-flash` |
| `dshVscode.baseUrl` | Custom OpenAI-compatible endpoint | official API |
| `dshVscode.permissionMode` | `workspace-write` / `read-only` / `danger-full-access` | `workspace-write` |
| `dshVscode.nodePath` | Custom Node binary for the agent host | auto (system node, fallback VS Code's Node) |
| `dshVscode.defaultWorkspace` | Default working directory when no folder is open | `~/ay-dsh-workspace` |

### Working directory (where agent files go)

1. The VS Code workspace folder you have open (recommended: `File > Open Folder` first)
2. `dshVscode.defaultWorkspace` if set
3. `~/ay-dsh-workspace` (auto-created; never falls back to system directories)

> The panel footer always shows the current working directory (📁) — click it to open in your file manager.

### Permissions & approvals

- Operations **inside the workspace** run without prompting.
- Reads outside the workspace are allowed (read-only is safe).
- Writes outside the workspace are **denied by the sandbox**; the agent may request a **one-time escalation** (`sandbox_permissions` + justification) which shows an **approval dialog** — you choose allow (one-time) or deny.
- If you ignore a request, it auto-cancels after 120 s (never hangs forever).

### Session history

- Click 🕘 to list sessions (auto-titled, newest first, current session marked).
- ▶ resume a session to continue the conversation with full context.
- 🗑 delete with double-click confirm.
- **📄 export** (top toolbar, enabled once a session exists) opens a complete, zero-truncation HTML transcript in your browser.

## Data & isolation

| Item | Location |
| --- | --- |
| Session history | `%APPDATA%/Code/User/globalStorage/deepseek-harness.ay-dsh-vscode/dsh-home/sessions-ay-dsh/` |
| API Key | VS Code SecretStorage (per-extension) |
| Settings | VS Code `settings.json` (`dshVscode.*`) |
| Official dsh data | untouched — plugin never reads/writes `~/.dsh` |

## Architecture

```
┌──────────────────────────── VS Code ─────────────────────────────┐
│  Webview (chat UI)  ◄─JSONL─►  Extension host (extension.ts)      │
│                                   │ spawn (stdio JSONL)           │
│                            ┌──────▼──────┐                        │
│                            │ agent-host  │ independent Node proc  │
│                            │ (DSH Cordis │ boot() plugin tree     │
│                            │  runtime)   │ agents.create()        │
│                            └──────┬──────┘                        │
│                                   │ DSH kernel                    │
│             sandbox/approval · tools · subagent · workflow        │
│             goal · plan-mode · session logs · token metering      │
└───────────────────────────────────────────────────────────────────┘
```

- `host/agent-host.mjs` — DSH runtime host (unbundled, runs directly; protocol in `src/protocol.ts`)
- `src/host.ts` — subprocess management + session-event → view-event translation
- `src/webviewPanel.ts` — sidebar view & message routing
- `src/media/` — chat UI (framework-free, lightweight markdown)

## Development

```powershell
npm install
npm run build          # build
npm run watch          # incremental build
npm run package        # VSIX
```

## Publishing this repository

One-command local init + commit (+ optional push):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 `
  -Remote https://github.com/<your-account>/ay-dsh-vscode.git
```

See [CONTRIBUTING](docs/CONTRIBUTING.md) for contribution guidelines.

## License

MIT — see [LICENSE](LICENSE). Third-party notices: [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md).
