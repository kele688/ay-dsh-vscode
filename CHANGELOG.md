# Changelog

## [0.5.4] - 2026-09-12

DSH core 0.1.5-rc.2 adaptation — fixes "session history not restored / final answer text lost / feels slow" after the core upgrade:

- Fix session history not restored after a host restart: 0.1.5 removed `sessionPersistence.inspect`, so the preview path's `typeof === "function"` guard failed silently and **no `history` frame was ever sent** (title and log size stayed, message list was cleared, stats reset to zero). Replaced with a cross-version read-only helper (`inspect` → `open(id,"read")` → `sessionQuery.readSession`) used by preview, read-only browsing and pagination.
- Fix only the first step's text being shown while the final summary report disappeared: once 0.1.5 stopped emitting `assistant/chunk` session events, `translateEvent` wrongly assumed "already streamed" and dropped the text of every later `assistant/message` in the turn. Now decided by whether the step really had streaming deltas.
- Restore live streaming output: bridge 0.1.5's process-local `agent/assistant-stream` frames back into `assistant/chunk`, leaving the whole front-end streaming pipeline unchanged.
- Handle 0.1.5's new `assistant/attempt` terminal event (attempt that committed no visible message).
- Multi-generation immutable session logs: stats `lastSeq` is recomputed when a generation renumbers `seq`; log size / listing / deletion recognize every generation (`session.jsonl.zstd` = v0, `session.v3.jsonl.zstd` = v3).
- Performance: session stats persistence now slices by `seq` instead of copying and rescanning the whole log on every flush (measured 8.7 ms → ~0 ms per flush on a 310k-event session).
- Diagnostics: host stderr is mirrored to `<DSH home>/dsh-host.log` (recreated above 5 MB) so kernel boot problems (session load refusal, format refusal, migration failure) can be inspected offline.
- Session-list project filter is now case-insensitive on Windows: directory keys come from the session's creation-time cwd (and legacy-migrated sessions keep their old key), so a drive-letter case difference used to silently empty the list.

## [0.5.3] - 2026-09-11

- patch
- feat: label system rules, add per-round reiteration directive; fix updater latest/next logic

## [0.5.2] - 2026-09-04

- Isolate sessions history list based on project to avoid restore session in non-relevent workspace
- disable dsh_goal associated functions, long turn task without person is not complicate with ay-dsh work mode, it may lead to dead loop in AI think loop
- chore: bump version to 0.5.2

## [0.5.1] - 2026-09-02

- fix: session rotation summary/title & idle-check, stats reset, ripgrep exec, bump lock sync

## [0.5.0] - 2026-08-31

- per-group Save buttons persist only (no host restart)
- Restart & Apply group/command restarts host once after confirmation
- fix boolean env switch injection so off-state actually disables
- register 6 missing config keys (rotate*/enable*)
- approval rules show read-only system defaults and reject duplicate tool names
- personality prompt injection + auto-learning gated by enable switches
- fix missing L.on/L.off i18n keys

## [0.4.1] - 2026-08-27

- tool-level auto-approval rules
- cross-platform koffi native fix
- DSH core stays 0.1.1-rc.2

## [0.4.0] - 2026-08-23

- self-contained DSH core 0.1.1-rc.2 (replaces 0.1.0-rc.6)
- multimodal model support: DeepSeek-V4-Vision-Exp for image understanding
- paste images into a scrollable horizontal rail with an [imageN] anchor reference
- lightbox card: prev/next buttons, mouse-wheel navigation, close button, filename & counter
- history message images scroll horizontally and open a multi-image lightbox
- gentle image limits (PNG/JPG/WebP/GIF, 20/message, ≤5MB each, content dedup)
- configurable auto-compaction (auto / thresholdRatio / maxTokens) in the control-params group; threshold ratio as percent (80% default)
- compaction start/end surfaced on the status bar with the freed-token count
- chat header logo rebranded to AY-DSH; input placeholder updated
- paste is the only image entry (drag-and-drop and the attach button removed)

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
