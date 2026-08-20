# Changelog

## [0.3.0] - 2026-08-20

- Multi-provider LLM routing (DeepSeek/Zhipu/ZAI) with in-session model switching
- session restore via history preview + immediate agent resume (zero-wait first message)
- per-turn efficiency system (static rules in system prompt + dynamic STEPS_USED/TOOLS_USED/ELAPSED_SEC fields + mandatory wrap-up report)
- stats strongly synced to log flush
- history list & restore speed (zero-decompression scan + shared prepared cache)
- optimistic delete UX with status-bar hints
- unified sub-session naming (subsession_ + sessionId)
- bilingual CHANGELOG (en/zh-CN)

## [0.2.1] - 2026-08-17

- cross-platform native packaging (one VSIX for win32/linux/darwin)
- config panel refreshes after save (API key hint)
- modelInfo re-pulled on webview ready (fixes empty model dropdown)
- step-limit log noise removed

Maintained by scripts/bump-version.mjs (appends a version entry before each release).

## [0.2.0] - 2026-08-16

### Added
- Reasoning effort tiers off/low/high/max (lowercase, matching kernel effort values; default high; low is normalized to high by the host — the official low tier is not yet implemented in the current kernel adapter)
- Per-turn step limit (maxSteps): soft termination on reaching the limit (a wrap-up directive is injected to prompt a summary), never a hard cancel; 0 = unlimited
- Subagent recursion depth (subagentMaxDepth) and parallel subagent count (maxParallelSubagents) settings
- Session auto-restore: resumes the previous session after config changes / VS Code Reload instead of creating a new one
- Send/stop merged into a single button (turns into "Stop" while running; stop immediately interrupts and discards unfinished output)
- Minimal inline hint in the composer row (ⓘ + ellipsis-truncated text; hover shows the full message, also synced to the status bar)
- Markdown table rendering and one-click code-block copy
- Step counter in the top bar (session-cumulative AI call count)
- Config save notification moved to the VS Code status bar (no dialogs); the config panel no longer auto-closes after save
- Transactional config save: per-item config events are ignored during save and the host restarts once with the new config

### Changed
- Cost stats currency unified to CNY (¥)
- deepseek-chat / deepseek-reasoner are retired; current models are deepseek-v4-flash / deepseek-v4-pro (memoized in code comments)
- Host frame handling serialized (resume/chat etc. run in order to prevent concurrent session creation)
- User message appears in the list before the AI response (sending is locked during history restore)
- Post-restore hints unified through setHint (panel ⓘ + status bar)

### Fixed
- Continuing a conversation after a config change no longer creates a new session or loses the user message
- Reasoning-effort metadata used the wrong llm API (resolveModel → resolveModelInfo)
- Resume failure now emits sessionResumed {ok:false}; the UI no longer hangs on "restoring session"
- Bundle kept in sync with source (CI drift check guards the build artifact)

### Internal
- Added scripts/effort-probe.mjs (reasoning-effort capability probe, --live supported), scripts/bump-version.mjs, scripts/release.mjs, scripts/verify-i18n.mjs
