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
import { AgentHost, getOutputChannel, resolveNode, hostLoaderArgs } from "./host";
import { ChatViewProvider } from "./webviewPanel";
import { openConfigPanel, type ProviderInfo } from "./configPanel";
import { bundledDshVersion, startDshUpdateChecker, LAST_CHECK_KEY } from "./dshUpdater";
import { DshRuntimeManager } from "./dshRuntime";
import { UpgradeCenter } from "./upgradeCenter";

let provider: ChatViewProvider | undefined;
let host: AgentHost | undefined;
/** DSH 运行时管理器（P2：动态解析升级/回滚/黑名单；采纳 UI 见顶栏横幅）。 */
let runtimeManager: DshRuntimeManager | undefined;
/** 版本升级中心（配置面板"版本升级"组后端：GitHub 查询/缓存/升级/重置编排）。 */
let upgradeCenter: UpgradeCenter | undefined;
/** 当前 DSH 升级候选（顶栏横幅常驻显示，直到用户操作；latest 为空 = 无候选）。 */
let dshCandidate: { latest: string; upgrading: boolean } | undefined;
/** 候选版本持久化键（跨 Reload 保留横幅，直到用户操作）。 */
const DSH_CANDIDATE_KEY = "dshCandidateVersion";
/** 宿主就绪时刻与版本（退出时结算运行时长，计入稳定性统计）。 */
let hostReadyAt: number | undefined;
let hostReadyVersion: string | undefined;
/** 指数退避计数（仅回退后的稳定基线/内置版本崩溃时递增；宿主 ready 时重置）。 */
let backoffAttempt = 0;

/** 设置/清除 DSH 升级候选（持久化 + 推送顶栏横幅）。 */
function setDshCandidate(context: vscode.ExtensionContext, latest: string | undefined): void {
  dshCandidate = latest ? { latest, upgrading: false } : undefined;
  void context.workspaceState.update(DSH_CANDIDATE_KEY, latest ?? undefined);
  provider?.pushDshUpdate();
}

/** 执行升级（横幅路径：使用候选版本；配置面板路径：指定版本）：后台安装+自检
 *  （不影响进行中的对话）→ 空闲后切换宿主。两入口共用同一编排。 */
async function doDshUpgradeTo(context: vscode.ExtensionContext, version?: string): Promise<void> {
  const latest = version ?? dshCandidate?.latest;
  if (!latest || !runtimeManager) return;
  if (!version) dshCandidate = { latest, upgrading: true };
  provider?.pushDshUpdate();
  // ① 后台安装闭包 + 宿主自检：全程不触碰正在运行的宿主进程，对话不受影响
  const ok = await runtimeManager.upgrade(latest);
  if (!ok) {
    setDshCandidate(context, undefined); // 失败已进黑名单，收起横幅
    return;
  }
  // ② 切换避让：等待当前对话空闲再重启宿主（不打断进行中的对话）
  setDshCandidate(context, undefined);
  await waitForHostIdle();
  // ③ 切换（对话保护）：noteHostRestart 锁定发送 + 会话自动恢复（storedSessionId）；
  //    输入区内容保留（"先记着"），就绪后用户可继续（"切换后再发"），全程静默
  provider?.noteHostRestart();
  disposeHost();
  void ensureHost(context);
}

/** 横幅升级入口（候选版本）。 */
async function doDshUpgrade(context: vscode.ExtensionContext): Promise<void> {
  return doDshUpgradeTo(context);
}

/** 重置 DSH 运行时为 VSIX 内置（清空候选/黑名单/已采纳版本/检测周期；测试与紧急恢复用）。 */
async function resetDshRuntimeFlow(context: vscode.ExtensionContext): Promise<void> {
  runtimeManager?.reset();
  setDshCandidate(context, undefined);
  // 清除检测周期：重置后 1 分钟内即可重新检测（测试升级流程的关键）
  void context.workspaceState.update(LAST_CHECK_KEY, undefined);
  disposeHost();
  void ensureHost(context);
}

/** 等待宿主空闲（升级切换避让；每 5s 轮询，最多 10 分钟，期间静默不打扰）。 */
async function waitForHostIdle(): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (!host?.isRunning) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
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
  autoCompaction: boolean;
  compactionThresholdRatio: number;
  compactionMaxTokens: number;
  autoApproveRules: { match: string; action: string }[];
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
  // 上下文自动压缩（借鉴 dsh web）：是否启用、触发比例（0~1）、摘要 token 上限
  const autoCompaction = cfg.get<boolean>("autoCompaction") ?? true;
  const compactionThresholdRatio = Math.min(1, Math.max(0.1, Number(cfg.get<number>("compactionThresholdRatio") ?? 0.8) || 0.8));
  const compactionMaxTokens = Math.max(1, Number(cfg.get<number>("compactionMaxTokens") ?? 8192) || 8192);
  // 自动授权规则（工具级，Kilo Code 风格）：glob/grep/read 等只读工具可自动放行
  const rawRules = cfg.get<{ match?: string; action?: string }[]>("autoApproveRules");
  const autoApproveRules: { match: string; action: string }[] = Array.isArray(rawRules)
    ? rawRules
        .map((r) => ({ match: String(r?.match ?? "").trim(), action: ["allow", "ask", "deny"].includes(String(r?.action)) ? String(r.action) : "ask" }))
        .filter((r) => r.match)
    : [];
  return { apiKey, baseUrl, model, permissionMode, nodePath, maxSteps, subagentMaxDepth, maxParallelSubagents, autoCompaction, compactionThresholdRatio, compactionMaxTokens, autoApproveRules };
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
    // 防御：运行时闭包路径是 AgentHost 构造时快照，若与当前解析不一致
    // （崩溃回退 / resetDshRuntime 等状态变更后未走 disposeHost 的路径），
    // 销毁旧实例走下方重建，避免用旧版本闭包启动（"回退了却没退"的复现条件）。
    const currentRuntime = runtimeManager?.runtimeNodeModules();
    if (host.runtimeNodeModulesPath !== currentRuntime) {
      disposeHost();
    } else {
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
  }
  await ensureWorkspaceChoice();
  const cfg = readConfig();
  const secretKey = await context.secrets.get(SECRET_KEY);
  // deepseek-official（llm-deepseek 插件路由）密钥：配置面板统一界面保存于密钥库，
  // 此处注入宿主 DEEPSEEK_API_KEY 环境变量（llm-deepseek 默认凭据引用），
  // 用户无需手动配置环境变量；环境变量/设置已有值时优先（readConfig 已读入 cfg.apiKey）
  const officialKey = await context.secrets.get("dshVscode.provider.deepseek-official.apiKey");
  const apiKey = cfg.apiKey ?? officialKey ?? secretKey ?? undefined;
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
      autoCompaction: cfg.autoCompaction,
      compactionThresholdRatio: cfg.compactionThresholdRatio,
      compactionMaxTokens: cfg.compactionMaxTokens,
      autoApproveRules: cfg.autoApproveRules,
      dshHome: pluginDshHome(context),
      legacyDshHome: legacyDshHome(),
      runtimeNodeModulesPath: runtimeManager?.runtimeNodeModules(),
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
    onSaved: (restart: boolean) => {
      configSaveTransaction = false;
      // 记录本次保存时间：抑制 onDidChangeConfiguration 的延迟事件（面板保存
      // 的配置事件可能在事务结束后才到达），避免宿主被重复重启
      lastConfigRestartAt = Date.now();
      if (configRestartTimer) clearTimeout(configRestartTimer);
      configRestartTimer = undefined;
      if (restart) {
        // 宿主运行参数确实变化：锁定 UI + 按新配置重启宿主（重启就绪后自动恢复原会话）。
        // 保存结果提示统一走 VS Code 状态栏（configPanel.ts setStatusBarMessage）。
        provider?.noteHostRestart();
        disposeHost();
        provider?.restartHost();
      }
      // 无论是否重启都刷新聊天视图（如提供商热生效后的模型列表）
      provider?.pushConfigToView?.();
    },
    // 查询 DSH 提供商目录（配置面板 Provider ID 下拉数据源；宿主未运行则先拉起）。
    // 兜底补充 deepseek-official（llm-deepseek 插件注册路由）：确保它始终出现在
    // "添加提供商"目录中，与 pi-ai 供应商一致——用户删除后仍可重新添加配置。
    queryProviders: async (): Promise<{ id: string; name: string }[]> => {
      let list: { id: string; name: string }[] = [];
      try {
        const h = await ensureHost(context);
        if (h) list = await h.llmProviders();
      } catch {
        // 宿主不可用（如缺配置）：返回空，面板按空目录处理（可手动输入/自定义）
      }
      if (!list.some((p) => p.id === "deepseek-official")) {
        list = [{ id: "deepseek-official", name: "DeepSeek (Official)" }, ...list];
      }
      return list;
    },
    // 把配置面板保存的提供商配置同步进 DSH（llm-pi-ai settings + credentials，热生效）。
    // deepseek-official 是 llm-deepseek 插件注册路由，配置在 llm-deepseek 命名空间
    // （apiKey 走 DEEPSEEK_API_KEY 环境变量），不写入 llm-pi-ai.providers——过滤掉，
    // 避免无效写入与路由干扰；其余提供商原样同步。
    // 宿主不可用时静默失败（返回错误信息，不影响面板本身）。
    applyProviders: async (providers): Promise<string | undefined> => {
      const list = providers ?? [];
      const hasOfficial = list.some((p) => p.id === "deepseek-official");
      const piAi = list.filter((p) => p.id !== "deepseek-official");
      try {
        const h = await ensureHost(context);
        if (h) {
          const err = await h.applyProviders(piAi);
          // deepseek-official 密钥注入宿主 DEEPSEEK_API_KEY 环境变量需重启宿主生效；
          // 检测到本次保存包含该路由即重启（其余提供商仍热生效，不重启）
          if (!err && hasOfficial) {
            disposeHost();
            void ensureHost(context);
          }
          return err;
        }
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return "host unavailable";
    },
    // 模型发现：catalog 提供商免网络返回模型+元数据；未知提供商探活端点。
    // deepseek-official 是插件路由（llm-deepseek），模型由其默认公布（含多模态），
    // 不走 pi-ai catalog/网络查询——直接返回官方模型清单（与插件 DEFAULT_MODELS 一致）。
    discoverModels: async (opts): Promise<{ models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[] }[]; error?: string }> => {
      if (opts.provider === "deepseek-official") {
        return {
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 1000000, maxTokens: 384000, inputModalities: ["text"] },
            { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 1000000, maxTokens: 384000, inputModalities: ["text"] },
            { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp", contextWindow: 1000000, maxTokens: 384000, inputModalities: ["text", "image"] },
          ],
        };
      }
      try {
        const h = await ensureHost(context);
        if (h) return await h.discoverModels(opts);
      } catch {
        // 宿主不可用：回退网络查询
      }
      return { models: [], error: "host unavailable" };
    },
    // 提供商配置同步完成后：触发宿主 getModelInfo，让聊天面板底部模型选择器
    // 立即反映新增/变更的提供商与模型（宿主已通过 llm-pi-ai settings 热生效）。
    onProvidersSynced: () => {
      void ensureHost(context).then((h) => h?.getModelInfo());
    },
    // 版本升级（配置面板"版本升级"组）：状态快照 + 缓存 + 查询/升级/重置
    upgradeState: () => ({
      dshCurrent: upgradeCenter?.dshCurrent(),
      dshBundled: upgradeCenter?.dshBundled(),
      pluginCurrent: upgradeCenter?.pluginCurrent() ?? "0.0.0",
    }),
    cachedDshVersions: () => upgradeCenter?.cachedDshVersions() ?? [],
    cachedPluginVersions: () => upgradeCenter?.cachedPluginVersions() ?? [],
    queryDshVersions: () => upgradeCenter?.queryDshVersions() ?? Promise.resolve({ versions: [] }),
    queryPluginVersions: () => upgradeCenter?.queryPluginVersions() ?? Promise.resolve({ versions: [] }),
    upgradeDsh: (version) => (upgradeCenter ? upgradeCenter.upgradeDsh(version) : Promise.resolve(false)),
    upgradePlugin: (version) => (upgradeCenter ? upgradeCenter.upgradePlugin(version) : Promise.resolve({ ok: false })),
    resetDsh: () => (upgradeCenter ? upgradeCenter.resetDsh() : Promise.resolve()),
  });
}

/* ------------------------------------------------------------------ */
/* 激活 / 停用                                                          */
/* ------------------------------------------------------------------ */

/* ---------------- DSH 版本详情：直接调系统浏览器打开官方发布说明 ---------------- */

/** 打开 DSH 内核官方 GitHub Release 页面（tag 格式 dsh-v<version>，官方发布说明最完整）。 */
function openDshDetails(version: string): void {
  void vscode.env.openExternal(
    vscode.Uri.parse(`https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`)
  );
}





export function activate(context: vscode.ExtensionContext): void {
  provider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    // 当前生效 DSH 版本（升级后 = 采纳版本；未升级 = VSIX 内置），顶栏展示
    getDshVersion: () => runtimeManager?.currentVersion ?? bundledDshVersion(context.extensionUri.fsPath),
    getModel: () => readConfig().model,
    getConfigSummary: () => getConfigSummary(context),
    ensureHost: () => ensureHost(context),
    // 当前会话 id 跨 Reload 持久化（workspaceState）：Reload 窗口后自动恢复原会话，
    // 不默认停在"新会话"
    getStoredSessionId: () => context.workspaceState.get<string>("currentSessionId"),
    setStoredSessionId: (id) => {
      void context.workspaceState.update("currentSessionId", id ?? undefined);
    },
    // 宿主异常退出：先结算运行时长（稳定性统计，任何退出都累计），再做崩溃检测
    // （重启 vs 回退，见决策文档 1.6：时间窗内连续崩溃 < 阈值仅重启；≥ 阈值回退稳定基线）。
    onHostExit: (code) => {
      if (hostReadyAt !== undefined && hostReadyVersion) {
        runtimeManager?.addRunTime(hostReadyVersion, Date.now() - hostReadyAt);
        hostReadyAt = undefined;
        hostReadyVersion = undefined;
      }
      const active = runtimeManager?.currentVersion;
      if (code !== 0 && active && runtimeManager?.runtimeNodeModules()) {
        const decision = runtimeManager.noteHostCrash(active);
        if (decision === "rollback") {
          // 关键：回退只更新了持久化状态（KEY_CURRENT），而当前 AgentHost 实例
          // 构造时缓存的 runtimeNodeModulesPath 仍是旧版本闭包（构造时快照）。
          // 必须销毁实例，让随后的 scheduleHostRestart → ensureHost 重建并按回退后的
          // 版本重新解析运行时路径；否则重启会继续加载已失效的旧版本闭包
          // （如缺失 overlay 文件的目录），表现为"回退了却还在用旧版本启动"。
          disposeHost();
        }
      }
    },
    // 宿主正常就绪：清零崩溃计数与退避计数 + 记录就绪时刻（用于运行时长结算）。
    onHostReady: () => {
      const v = runtimeManager?.currentVersion;
      if (!v) return;
      runtimeManager?.markHostHealthy(v);
      backoffAttempt = 0;
      hostReadyAt = Date.now();
      hostReadyVersion = v;
    },
    // 对话完成：累计稳定性统计（previous 提升门槛：>1h 且 >10 次对话）。
    onChatDone: () => {
      const v = runtimeManager?.currentVersion;
      if (v) runtimeManager?.addChat(v);
    },
    // 自动重启延迟决策：试用版本（current !== previous）→ 0（崩溃后立即重启，前 3 次
    // 尽快恢复，第 3 次后崩溃检测回退）；回退后的稳定基线/内置 → 指数退避（1.5s 起步
    // 每次翻倍，无限——已是最低底线时永不放弃、但绝不高频重启拖垮 VS Code）。
    getHostRestartDelay: () => {
      const v = runtimeManager?.currentVersion;
      const prev = runtimeManager?.previousVersion;
      if (v && prev && v !== prev) {
        backoffAttempt = 0;
        return 0;
      }
      backoffAttempt++;
      return 1500 * 2 ** (backoffAttempt - 1);
    },
    // DSH 升级候选横幅（顶栏常驻）：状态读取 + 按钮回调
    getDshUpdate: () => dshCandidate,
    onDshUpgrade: () => {
      void doDshUpgrade(context);
    },
    onDshIgnore: () => {
      if (dshCandidate?.latest) runtimeManager?.ignore(dshCandidate.latest);
      setDshCandidate(context, undefined);
    },
    onDshDetails: () => {
      if (dshCandidate?.latest) openDshDetails(dshCandidate.latest);
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

  // DSH 更新检测（P1：闲时 24h 周期检测，跨生命周期；P2：候选移交运行时管理器）
  runtimeManager = new DshRuntimeManager({
    extensionPath: context.extensionUri.fsPath,
    globalStoragePath: context.globalStorageUri.fsPath,
    workspaceState: context.workspaceState,
    nodeResolver: () => resolveNode(readConfig().nodePath),
    hostScript: () => path.join(context.extensionUri.fsPath, "host", "agent-host.bundle.mjs"),
    // 宿主 ESM 重定向器加载参数：统一由 host.ts 的 hostLoaderArgs 决策（复用同一逻辑）
    loaderArgs: () => hostLoaderArgs(context.extensionUri.fsPath),
    log: (msg) => getOutputChannel().appendLine(msg),
    statusBar: (msg) => {
      void vscode.window.setStatusBarMessage(msg, 8000);
    },
  });
  // 版本升级中心（配置面板"版本升级"组后端）：GitHub Releases 查询/缓存 +
  // DSH 升级/重置复用运行时管理器与宿主切换编排；插件升级下载 VSIX 安装。
  upgradeCenter = new UpgradeCenter({
    extensionPath: context.extensionUri.fsPath,
    globalState: context.globalState,
    runtime: runtimeManager,
    pluginVersion: () => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(context.extensionUri.fsPath, "package.json"), "utf8")) as { version?: string };
        return pkg.version ?? "0.0.0";
      } catch {
        return "0.0.0";
      }
    },
    onDshUpgraded: async (version) => {
      await doDshUpgradeTo(context, version);
    },
    onDshReset: async () => {
      await resetDshRuntimeFlow(context);
    },
    log: (msg) => getOutputChannel().appendLine(msg),
    statusBar: (msg) => {
      void vscode.window.setStatusBarMessage(msg, 8000);
    },
  });

  context.subscriptions.push(
    startDshUpdateChecker({
      workspaceState: context.workspaceState,
      extensionPath: context.extensionUri.fsPath,
      isChatActive: () => host?.isRunning ?? false,
      log: (msg) => getOutputChannel().appendLine(msg),
      onCandidate: (latest) => {
        if (!runtimeManager?.isCandidate(latest)) return;
        // 顶栏横幅常驻显示（不弹窗），直到用户操作（升级/忽略/详情）
        setDshCandidate(context, latest);
      },
    })
  );

  // 恢复跨 Reload 的升级候选横幅（持久化于 workspaceState，直到用户操作）
  const savedCandidate = context.workspaceState.get<string>(DSH_CANDIDATE_KEY);
  if (savedCandidate && runtimeManager?.isCandidate(savedCandidate)) {
    dshCandidate = { latest: savedCandidate, upgrading: false };
  }

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
    // 重置 DSH 运行时为 VSIX 内置（清空候选/黑名单/已采纳版本/检测周期；测试与紧急恢复用）
    vscode.commands.registerCommand("dshVscode.resetDshRuntime", () => {
      void resetDshRuntimeFlow(context);
    }),
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
      // 权限审批规则单独保存：仅 autoApproveRules 变化不自动重启（由"立即应用"显式触发）
      if (e.affectsConfiguration(`${CONFIG_NS}.autoApproveRules`)) return;
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
