# Contributing to ay-dsh-vscode

Thanks for your interest! This project is an open-source VS Code extension that embeds the DeepSeek Harness runtime. Contributions are welcome.

## How PRs are handled

To get merged, your PR should:

- Be **small and focused** (ideally under ~500 changed lines).
- Pass CI (type check + build + VSIX packaging on Node 20/22).
- Include tests where behavior changes (we value the `scripts/verify-*.mjs` style of reproducible checks).
- Never commit secrets, API keys, or machine-local absolute paths.

Reviewers may request changes; simply push new commits and they will be re-reviewed. Large or architectural changes deserve discussion first — please open an issue before investing in them.

## Development setup

```powershell
npm install
npm run build          # esbuild bundle + media copy
npm run watch          # incremental
npm run package        # VSIX
npm run deploy         # install into VS Code (Windows)
```

## Code layout

| Path | Purpose |
| --- | --- |
| `host/agent-host.mjs` | DSH runtime host (independent Node process, JSONL protocol with the extension) |
| `src/extension.ts` | Extension entry: commands, config wizard, host lifecycle |
| `src/host.ts` | Subprocess management + session-event → view-event translation |
| `src/webviewPanel.ts` | Sidebar webview & message routing |
| `src/media/` | Chat UI (framework-free) |
| `scripts/` | Build / package / deploy / license scan |

## Protocol

The extension ↔ host protocol is defined in `src/protocol.ts` (newline-delimited JSON over stdio). When adding features, keep frames backward compatible; bump the host `CORE_VERSION` on breaking changes.

## License

MIT — by contributing you agree your contributions are licensed under the same terms.
