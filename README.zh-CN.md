# ◈ ay-dsh-vscode

**一款 Kilo Code 风格的 VS Code AI 编码智能体，内核由 DeepSeek Harness (DSH) 驱动。**

不只是"聊天+补全"——本插件将 **DSH 官方 Agent 运行时**（与 `dsh` CLI / `dsh web` 同源）直接内嵌进 VS Code：多智能体编排、长时目标任务、工具调用全透明、真实沙箱与交互式授权。

> 🌐 [English README](README.md)

---

## 为什么比普通 AI 助手更强

| 能力 | 普通助手 | ay-dsh-vscode |
| --- | --- | --- |
| **多智能体编排** | ❌ 单 Agent | ✅ 内置 `subagent` / `subagent_fork` / `send_message` |
| **工作流** | ❌ | ✅ 内置 `workflow` 工具：一次任务分阶段 fan-out 多个 Agent |
| **长时目标任务** | 中断即丢 | ✅ 内置 `goal` 工具：目标跨轮次持久化、自动续跑、可恢复 |
| **工具透明化** | 仅显示工具名 | ✅ 流式 token、工具参数/结果内联显示、思考过程可折叠 |
| **真实沙箱** | 静态确认框 | ✅ 真实沙箱：`workspace-write` 拒绝越界写入；一次性升级需授权 |
| **计划模式** | ❌ | ✅ 内置 plan-mode：先规划，批准后执行 |
| **会话日志** | 私有格式 | ✅ 标准 DSH JSONL，`dsh` CLI 可复用 |

## 功能

- 🗨️ 侧边栏聊天：流式输出、思考折叠、Markdown 渲染
- ⌨️ **Ctrl+K Ctrl+I** 快捷引用：选中代码一键追加到输入框（文件路径+行列号+原文摘录，Kilo Code Ctrl+K Ctrl+A 同款）
- 🛠️ 工具调用内联文本块（参数 + 结果始终可见）
- 🔐 权限升级授权弹框（允许/拒绝，一次性放行）
- ⚡ 编辑器集成：解释选中代码、处理选中代码、修复文件诊断
- 🕘 会话历史：列表 / 继续 / 删除，以及**一键导出完整对话**（浏览器网页，零截断）
- 🔄 新会话 / 停止 / 模型切换；惰性创建会话（不产生垃圾会话）
- 🧠 完整 DSH 工具集：文件读写编辑、glob/grep、PowerShell、web 搜索、子 Agent、工作流、目标、Ralph 循环
- 🗂️ 与官方 DSH 数据**完全隔离**（独立 home、独立会话存储）

## 环境要求

- **Node.js ≥ 20**（推荐 22+）
- **VS Code ≥ 1.90**（含 `code` CLI 于 PATH）
- 一个 **DeepSeek API Key**（[platform.deepseek.com](https://platform.deepseek.com)）

> 💡 无需预先安装 DSH：DSH 内核已打包进 VSIX，自包含、离线可装。

## 快速开始（一键部署）

> ⭐ **推荐：从 [GitHub Releases](https://github.com/kele688/ay-dsh-vscode/releases) 下载最新稳定版** —— 每个 Release 都是经过验证的完整快照。
>
> 从源码构建并安装：
```powershell
cd ay-dsh-vscode
npm run deploy
```

脚本自动完成：`npm install` → `npm run build`（esbuild）→ `npm run package`（vsce 生成 VSIX）→ `code --install-extension`（安装到 VS Code）。

手动分步：

```powershell
npm install
npm run build
npm run package          # 产物在 release/ay-dsh-vscode.vsix
code --install-extension release\ay-dsh-vscode.vsix --force
```

### 配置

打开面板后点 **⚙ 齿轮**（或执行 `DSH: Configure`）打开图形化配置向导：

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| API Key（密钥库） | DeepSeek API Key；留空读 `DEEPSEEK_API_KEY` 环境变量 | — |
| `dshVscode.model` | 模型 id（`deepseek-v4-flash` / `deepseek-v4-pro` / 自定义） | `deepseek-v4-flash` |
| `dshVscode.baseUrl` | 自定义 OpenAI 兼容端点 | 官方 API |
| `dshVscode.permissionMode` | `workspace-write` / `read-only` / `danger-full-access` | `workspace-write` |
| `dshVscode.nodePath` | 自定义 Node 路径 | 自动（系统 node，回退 VS Code 内置） |
| `dshVscode.defaultWorkspace` | 未打开文件夹时的默认工作目录 | `~/ay-dsh-workspace` |

### 工作目录（Agent 生成文件的位置）

1. 当前打开的 VS Code 工作区文件夹（推荐：先 `File > Open Folder`）
2. 设置项 `dshVscode.defaultWorkspace`
3. `~/ay-dsh-workspace`（自动创建；**绝不**回退到系统目录）

> 面板底部常显当前工作目录（📁），点击可在文件管理器中打开。

### 权限与授权

- 工作区**内**操作：直接执行，不弹框。
- 工作区**外读取**：允许（只读安全）。
- 工作区**外写入**：沙箱拒绝；Agent 可请求**一次性权限升级**（`sandbox_permissions` + 理由），此时弹出**授权对话框**——你选择"允许"（一次性放行）或"拒绝"。
- 若长时间未处理，请求 **120 秒后自动取消**（绝不会永久卡住）。

### 会话历史

- 点 🕘 查看会话列表（自动标题、最新在前、当前会话标记）
- ▶ 继续会话：完整上下文恢复后接着聊
- 🗑 删除（二次确认）
- **📄 导出**（顶部工具栏，有会话内容时可用）：浏览器打开完整零截断对话记录

## 数据与隔离

| 内容 | 位置 |
| --- | --- |
| 会话历史 | `%APPDATA%/Code/User/globalStorage/deepseek-harness.ay-dsh-vscode/dsh-home/sessions-ay-dsh/` |
| API Key | VS Code 密钥库（随扩展隔离） |
| 设置 | VS Code `settings.json`（`dshVscode.*`） |
| 官方 dsh 数据 | 完全不触碰 `~/.dsh` |

## 架构

```
┌──────────────────────────── VS Code ─────────────────────────────┐
│  Webview（聊天 UI）  ◄─JSONL─►  扩展宿主 (extension.ts)            │
│                                   │ spawn (stdio JSONL)          │
│                            ┌──────▼──────┐                       │
│                            │ agent-host  │ 独立 Node 子进程       │
│                            │ (DSH Cordis │ boot() 装载插件树      │
│                            │  运行时)     │ agents.create()       │
│                            └──────┬──────┘                       │
│                                   │ DSH 内核                      │
│             sandbox/审批 · 工具 · subagent · workflow             │
│             goal · plan-mode · 会话日志 · token 计量              │
└──────────────────────────────────────────────────────────────────┘
```

- `host/agent-host.mjs` — DSH 运行时宿主（不打包，直接运行；协议见 `src/protocol.ts`）
- `src/host.ts` — 子进程管理 + 会话事件 → 视图事件翻译
- `src/webviewPanel.ts` — 侧边栏视图与消息路由
- `src/media/` — 聊天 UI（无框架，轻量 Markdown）

## 开发

```powershell
npm install
npm run build          # 构建
npm run watch          # 增量构建
npm run package        # 打包 VSIX
```

贡献指南见 [CONTRIBUTING](docs/CONTRIBUTING.md)（英文）。

## License

MIT — 见 [LICENSE](LICENSE)。第三方声明： [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。
