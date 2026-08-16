/**
 * extension.ts — DSH VS Code 扩展入口。
 *
 * 职责：
 * - 注册侧边栏聊天视图（ChatViewProvider），视图打开即自动拉起宿主
 * - 管理 AgentHost 子进程（按工作区 + 配置创建）
 * - 命令：focus / newSession / stop / configure / explainSelection / runOnSelection / fixDiagnostics
 * - 图形化配置向导：API Key（SecretStorage 密钥库）、模型、Base URL、权限模式
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { AgentHost } from "./host";
import { ChatViewProvider } from "./webviewPanel";
import { openConfigPanel } from "./configPanel";

let provider: ChatViewProvider | undefined;
let host: AgentHost | undefined;
/** 配置面板保存事务标志（保存期间忽略逐项配置变更事件，由 onSaved 统一重启）。 */
let configSaveTransaction = false;
/** 配置变更后的宿主重启防抖定时器（settings.json 直接编辑等非面板场景）。 */
let configRestartTimer: NodeJS.Timeout | undefined;
/** 最近一次因配置保存而重启宿主的时间戳（抑制面板保存的延迟配置事件）。 */
let lastConfigRestartAt = 0;

const SECRET_KEY = "dshVscode.apiKey";
const CONFIG_NS = "dshVscode";
const DEFAULT_MODEL = "deepseek-v4-flash";

let workspaceMigrated = false;

/**
 * 一次性迁移：默认工作目录不再放在 ~/.dsh/workspaces/default（与官方 dsh 解耦），
 * 改为用户目录下的 ~/ay-dsh-workspace。首次调用时自动把旧位置整体搬过去（幂等）；
 * 目录被占用（宿主进程 cwd）时退化为复制 + 尽力删除旧目录。
 */
function migrateDefaultWorkspace(): void {
  if (workspaceMigrated) return;
  workspaceMigrated = true;
  try {
    const legacy = path.join(os.homedir(), ".dsh", "workspaces", "default");
    const target = path.join(os.homedir(), "ay-dsh-workspace");
    if (!fs.existsSync(legacy) || fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(legacy, target);
    } catch {
      // 目录被占用：退化为复制（复制不要求源目录空闲），旧目录尽力删除
      fs.cpSync(legacy, target, { recursive: true });
      try {
        fs.rmSync(legacy, { recursive: true, force: true });
      } catch {
        /* 仍被占用则保留，下次可手动清理 */
      }
    }
    // 清理旧空壳目录（尽力而为）
    try {
      fs.rmdirSync(path.join(os.homedir(), ".dsh", "workspaces"));
    } catch {
      /* 非空或不存在则保留 */
    }
    try {
      fs.rmdirSync(path.join(os.homedir(), ".dsh"));
    } catch {
      /* 非空（官方 dsh 数据）则保留 */
    }
  } catch {
    // 迁移失败不阻塞：回退路径仍可用，只是旧文件留在原位
  }
}

/**
 * 解析 Agent 的工作目录（优先级）：
 * 1. 当前打开的 VS Code 工作区文件夹（workspaceFolders[0]）
 * 2. 设置项 dshVscode.defaultWorkspace（用户显式指定的默认目录）
 * 3. ~/ay-dsh-workspace（自动创建；与官方 dsh 的 ~/.dsh 完全无关）
 */
function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) return folder;
  const configured = vscode.workspace.getConfiguration(CONFIG_NS).get<string>("defaultWorkspace");
  if (configured && configured.trim() !== "") return configured.trim();
  migrateDefaultWorkspace();
  const fallback = path.join(os.homedir(), "ay-dsh-workspace");
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    // 目录创建失败时保持原路径，宿主启动时会有明确报错
  }
  return fallback;
}

/** 无工作区时引导用户选择默认工作目录（一次性提示，可忽略）。 */
async function ensureWorkspaceChoice(): Promise<void> {
  if (vscode.workspace.workspaceFolders?.[0]) return;
  const configured = vscode.workspace.getConfiguration(CONFIG_NS).get<string>("defaultWorkspace");
  if (configured && configured.trim() !== "") return;
  const fallback = workspaceRoot();
  const choice = await vscode.window.showWarningMessage(
    `当前未打开任何文件夹，DSH Agent 将把生成的文件保存到默认工作目录：\n${fallback}`,
    { modal: false },
    "选择其他目录…",
    "使用默认目录"
  );
  if (choice === "选择其他目录…") {
    const picked = await vscode.window.showOpenDialog({
      title: "选择 DSH Agent 默认工作目录",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "选择此目录",
    });
    if (picked?.[0]) {
      await setConfigValue("defaultWorkspace", picked[0].fsPath);
      vscode.window.showInformationMessage(`✅ 默认工作目录已设为 ${picked[0].fsPath}`);
    }
  }
}

function readConfig(): {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
  permissionMode: string;
  nodePath: string;
  maxSteps: number;
  subagentMaxDepth: number;
  maxParallelSubagents: number;
} {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const apiKeySetting = cfg.get<string>("apiKey");
  const apiKey =
    (apiKeySetting && apiKeySetting.trim() !== "" ? apiKeySetting : undefined) ??
    process.env.DEEPSEEK_API_KEY;
  const baseUrl = cfg.get<string>("baseUrl") || undefined;
  const model = cfg.get<string>("model") || DEFAULT_MODEL;
  const permissionMode = cfg.get<string>("permissionMode") || "workspace-write";
  const nodePath = cfg.get<string>("nodePath") || "";
  // 借鉴 dsh web：思考轮次上限（0 = 不限制）、子代理递归深度、并行子代理数
  const maxSteps = Math.max(0, Number(cfg.get<number>("maxSteps") ?? 100) || 0);
  const subagentMaxDepth = Math.max(1, Number(cfg.get<number>("subagentMaxDepth") ?? 3) || 3);
  const maxParallelSubagents = Math.max(1, Number(cfg.get<number>("maxParallelSubagents") ?? 5) || 5);
  return { apiKey, baseUrl, model, permissionMode, nodePath, maxSteps, subagentMaxDepth, maxParallelSubagents };
}

/** 配置摘要（推送给 UI 展示）。SecretStorage 密钥库是 API Key 的主存储，必须纳入判断。 */
async function getConfigSummary(context: vscode.ExtensionContext): Promise<{
  keyConfigured: boolean;
  model: string;
  baseUrl: string;
  permissionMode: string;
  cwd: string;
}> {
  const c = readConfig();
  const secretKey = await context.secrets.get(SECRET_KEY);
  const keyConfigured = Boolean(c.apiKey ?? secretKey);
  return {
    keyConfigured,
    model: c.model,
    baseUrl: c.baseUrl ?? "",
    permissionMode: c.permissionMode,
    cwd: workspaceRoot(),
  };
}

/** 在系统文件管理器中打开 Agent 的工作目录。 */
async function openWorkspaceFolder(): Promise<void> {
  const dir = workspaceRoot();
  try {
    await vscode.env.openExternal(vscode.Uri.file(dir));
  } catch (err) {
    vscode.window.showErrorMessage(`无法打开工作目录 ${dir}: ${String(err)}`);
  }
}

/** 保存普通配置项（更新 workspace configuration）。 */
async function setConfigValue<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_NS).update(key, value, vscode.ConfigurationTarget.Global);
}

/** 重启宿主（配置变更后下次使用时按新配置拉起）。 */
function disposeHost(): void {
  const old = host;
  host = undefined;
  provider?.setHost(undefined);
  void old?.dispose();
}

/** 插件专属 DSH home：VS Code globalStorage 下，与官方 dsh 的 ~/.dsh 完全隔离。 */
function pluginDshHome(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "dsh-home");
}

/** 旧 DSH home（会话迁移源）：用户环境变量或默认 ~/.dsh。 */
function legacyDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 确保宿主存在且已启动（惰性创建；视图/命令首次使用时才拉起子进程）。 */
async function ensureHost(context: vscode.ExtensionContext): Promise<AgentHost> {
  if (host) {
    if (!host.sessionId) {
      try {
        await host.start();
      } catch (err) {
        vscode.window.showErrorMessage(`DSH 宿主启动失败: ${String(err)}`);
        throw err;
      }
    }
    return host;
  }
  await ensureWorkspaceChoice();
  const cfg = readConfig();
  const secretKey = await context.secrets.get(SECRET_KEY);
  const apiKey = cfg.apiKey ?? secretKey ?? undefined;
  const h = new AgentHost(
    {
      extensionPath: context.extensionUri.fsPath,
      workspaceRoot: workspaceRoot(),
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      nodePath: cfg.nodePath,
      maxSteps: cfg.maxSteps,
      subagentMaxDepth: cfg.subagentMaxDepth,
      maxParallelSubagents: cfg.maxParallelSubagents,
      dshHome: pluginDshHome(context),
      legacyDshHome: legacyDshHome(),
    },
    context
  );
  host = h;
  provider?.setHost(h);
  context.subscriptions.push({
    dispose: () => {
      void h.dispose();
    },
  });
  await h.start();
  return h;
}

/** 把一段任务文本投递给聊天视图（宿主未启动则先启动；视图未打开则先聚焦）。 */
async function deliverTask(context: vscode.ExtensionContext, text: string): Promise<void> {
  await ensureHost(context);
  provider?.queueTask(text);
  await vscode.commands.executeCommand("dshVscode.chatView.focus");
}

/**
 * 构造"快捷引用原文"文本（对标 Kilo Code 的 Ctrl+K Ctrl+A）：
 *   文件相对路径 + 起止位置（行,列，1-based）+ 代码围栏内的原文摘录。
 * 原文 ≤5 行全量；>5 行取前 3 行 + 省略行 + 末 1 行。
 * 围栏自动加长：原文含 ``` 时用更长的反引号围栏，避免提前闭合。
 */
function buildSelectionRef(editor: vscode.TextEditor): string {
  const doc = editor.document;
  const sel = editor.selection;
  const text = doc.getText(sel);
  if (!text.trim()) return "";
  const relPath = vscode.workspace.asRelativePath(doc.uri, false) || doc.uri.fsPath;
  // VS Code 位置 0-based，引用展示用 1-based
  const sLine = sel.start.line + 1;
  const sCol = sel.start.character + 1;
  const eLine = sel.end.line + 1;
  const eCol = sel.end.character + 1;
  const lines = text.split(/\r?\n/);
  const excerpt =
    lines.length <= 5 ? lines : [...lines.slice(0, 3), "…", lines[lines.length - 1]];
  let fence = "```";
  while (excerpt.some((l) => l.includes(fence))) fence += "`";
  return [`[${relPath} (${sLine},${sCol})-(${eLine},${eCol})]`, `${fence}text`, ...excerpt, fence].join("\n");
}

/* ------------------------------------------------------------------ */
/* 配置：完整配置面板（src/configPanel.ts）                              */
/* ------------------------------------------------------------------ */

/**
 * 打开统一配置面板。
 *
 * 配置保存视为**一个整体事务**：面板保存期间（onConfigSaveStart → onConfigSaveEnd）
 * 逐项 cfg.update 触发的 onDidChangeConfiguration 一律忽略；保存成功（onSaved）后
 * 一次性判断并重启宿主——不依赖单个配置项的事件，避免"半套配置重启"与
 * "多次触发互相覆盖"。
 */
function openSettings(context: vscode.ExtensionContext): void {
  openConfigPanel(context, {
    readConfig,
    workspaceRoot,
    onConfigSaveStart: () => {
      configSaveTransaction = true;
    },
    onConfigSaveEnd: () => {
      configSaveTransaction = false;
    },
    onSaved: () => {
      configSaveTransaction = false;
      // 记录本次重启时间：抑制 onDidChangeConfiguration 的延迟事件（面板保存
      // 的配置事件可能在事务结束后才到达），避免宿主被重复重启
      lastConfigRestartAt = Date.now();
      if (configRestartTimer) clearTimeout(configRestartTimer);
      configRestartTimer = undefined;
      // 会话 id 已在会话存续期间持久化（storedSessionId），此处只需锁定 UI +
      // 按新配置重启宿主；重启就绪后自动恢复原会话。
      // 保存结果提示统一走 VS Code 状态栏（configPanel.ts setStatusBarMessage），
      // 不弹任何通知/弹框。
      provider?.noteHostRestart();
      disposeHost();
      provider?.restartHost();
      provider?.pushConfigToView?.();
    },
  });
}

/* ------------------------------------------------------------------ */
/* 激活 / 停用                                                          */
/* ------------------------------------------------------------------ */

export function activate(context: vscode.ExtensionContext): void {
  provider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    getModel: () => readConfig().model,
    getConfigSummary: () => getConfigSummary(context),
    ensureHost: () => ensureHost(context),
    // 当前会话 id 跨 Reload 持久化（workspaceState）：Reload 窗口后自动恢复原会话，
    // 不默认停在"新会话"
    getStoredSessionId: () => context.workspaceState.get<string>("currentSessionId"),
    setStoredSessionId: (id) => {
      void context.workspaceState.update("currentSessionId", id ?? undefined);
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      // 保留上下文：视图隐藏/切换时不销毁 webview，聊天与历史状态不丢失
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 命令注册
  context.subscriptions.push(
    vscode.commands.registerCommand("dshVscode.focus", () => {
      void vscode.commands.executeCommand("dshVscode.chatView.focus");
    }),
    vscode.commands.registerCommand("dshVscode.newSession", () => {
      if (host) host.newSession();
      else void ensureHost(context);
    }),
    vscode.commands.registerCommand("dshVscode.stop", () => {
      host?.stop();
    }),
    vscode.commands.registerCommand("dshVscode.configure", () => openSettings(context)),
    vscode.commands.registerCommand("dshVscode.openWorkspace", () => openWorkspaceFolder()),
    vscode.commands.registerCommand("dshVscode.explainSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) return;
      void deliverTask(
        context,
        `请解释以下选中代码（来自 ${path.basename(editor.document.uri.fsPath)}）：\n\`\`\`\n${selection}\n\`\`\``
      );
    }),
    vscode.commands.registerCommand("dshVscode.runOnSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) return;
      void deliverTask(
        context,
        `请处理以下选中代码（来自 ${path.basename(editor.document.uri.fsPath)}）：\n\`\`\`\n${selection}\n\`\`\`\n请分析、改进或按需修改它。`
      );
    }),
    vscode.commands.registerCommand("dshVscode.fixDiagnostics", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
      if (diagnostics.length === 0) {
        void vscode.window.showInformationMessage("当前文件没有诊断问题。");
        return;
      }
      const lines = diagnostics
        .slice(0, 30)
        .map(
          (d) =>
            `- L${d.range.start.line + 1} [${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}]: ${d.message}`
        )
        .join("\n");
      void deliverTask(
        context,
        `当前文件 ${path.basename(editor.document.uri.fsPath)} 有以下诊断问题，请修复它们：\n${lines}`
      );
    }),
    // Ctrl+K Ctrl+I：快捷引用选中代码到聊天输入框（对标 Kilo Code Ctrl+K Ctrl+A）。
    // 只追加不发送——用户可继续编辑后回车，或继续追加更多引用。
    vscode.commands.registerCommand("dshVscode.addSelectionRef", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const ref = buildSelectionRef(editor);
      if (!ref) return;
      void vscode.commands.executeCommand("dshVscode.chatView.focus").then(() => {
        provider?.appendInput(ref);
      });
    })
  );

  // 配置变更（非配置面板保存路径，如直接编辑 settings.json）→ 解绑并重启宿主。
  // 面板保存事务期间（configSaveTransaction）本事件由 onSaved 统一处理，此处忽略；
  // 面板保存刚重启过（时间戳窗口内）的延迟事件同样忽略，避免重复重启。
  // 重启前先锁定 UI（noteHostRestart），就绪后自动恢复原会话（storedSessionId）。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_NS)) return;
      if (configSaveTransaction) return; // 面板保存事务中：onSaved 统一处理
      if (Date.now() - lastConfigRestartAt < 1500) return; // 面板保存刚重启过：忽略延迟事件
      provider?.noteHostRestart();
      disposeHost();
      if (configRestartTimer) clearTimeout(configRestartTimer);
      configRestartTimer = setTimeout(() => {
        configRestartTimer = undefined;
        provider?.restartHost();
      }, 400);
      provider?.pushConfigToView?.();
    })
  );

  // 工作区变化 → 重启宿主，让 Agent 工作目录跟随当前打开的工作区。
  // 说明：VS Code 打开/切换文件夹（File > Open Folder）会重载窗口，扩展重新激活，
  // 宿主自动以新工作区重建，无需额外处理；这里兜底的是"添加/移除文件夹到工作区"
  // （多根工作区）这类不重载窗口的场景。
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // 仅当宿主已创建且工作区根路径确实变化时才重启（避免无谓重启）
      const newRoot = workspaceRoot();
      if (host && newRoot !== host.workspaceRoot) {
        disposeHost();
        void ensureHost(context);
      }
    })
  );
}

export function deactivate(): void {
  if (configRestartTimer) clearTimeout(configRestartTimer);
  configRestartTimer = undefined;
  void host?.dispose();
  host = undefined;
}
