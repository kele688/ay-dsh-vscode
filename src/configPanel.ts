/**
 * configPanel.ts — DSH 完整配置面板（独立 WebviewPanel）。
 *
 * 取代旧的 QuickPick 循环式配置向导：一个统一的表单界面，集中编辑
 * API Key（SecretStorage）、模型、Base URL、权限模式、Node 路径、
 * 默认工作目录与输出上限，保存后写入密钥库/设置并重启宿主。
 *
 * 消息协议（postMessage）：
 *   panel -> ext: {t:"init"} | {t:"save", values} | {t:"pickFolder", field} | {t:"cancel"}
 *   ext -> panel: {t:"config", config} | {t:"folder", field, path} | {t:"saved", ok, message}
 *
 * ── 保存规则（各组独立"保存"按钮 + 功能组菜单"重启应用"，与 src/media/config-panel.js 保持一致）──
 *   · "模型配置" / "版本升级" 组：修改立即生效，无需保存、无需重启宿主，
 *     组内无"保存"按钮。
 *   · "运行环境" / "控制参数" / "日志管理" / "权限审批" / "个性定制" 五组
 *     各自独立"保存"按钮（cfgSaveRuntime / cfgSaveControl / cfgSaveLog /
 *     cfgSavePermission / cfgSavePersonal），点击**只落盘本组字段、绝不重启宿主**。
 *   · 功能组菜单最下面"重启应用"功能组：本身是命令入口——点击即弹模态确认框，
 *     确认后**统一重启宿主一次**，使所有已保存的配置生效；取消则停留在当前功能组。
 *     （组内无按钮；命令 dshVscode.restartHost 为同一入口）
 *   · 没点"保存"就不落盘、不生效；保存只落盘，重启才生效——两者完全解耦，
 *     连续修改多组可最后统一重启一次应用。
 *   · 生效机制区分（事先可确定）：
 *       - **需要重启宿主才生效（多数）**：运行环境 / 控制参数 / 日志管理 /
 *         权限审批 / 个性定制五组——宿主启动时从环境变量/文件快照读取
 *         （maxSteps、轮转参数、autoApproveRules、个性提示词注入等），
 *         保存后必须经"重启应用"功能组重启才生效。
 *       - **不需要重启（少数）**：模型配置组——提供商/模型/API Key 保存后
 *         立即落盘生效（热生效），无需重启宿主。
 *   · 状态栏提示（VS Code 状态栏，非弹窗）：保存中 "⏳ 正在保存配置…"、
 *     成功 "✅ 配置保存成功，重启宿主后生效"、失败 "✗ 配置保存失败：…"。
 *     面板内不显示文字，只负责恢复按钮。
 */
import * as vscode from "vscode";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderApplyItem } from "./protocol";
import type { UpgradeVersionInfo } from "./upgradeCenter";

/** 配置命名空间（与 extension.ts 的 CONFIG_NS 一致）。 */
const CONFIG_NS = "dshVscode";
const SECRET_KEY = "dshVscode.apiKey";

/** 已接入的模型提供商（持久化于 workspaceState；可增删改）。 */
export interface ProviderModel {
  id: string;
  displayName?: string;
  contextWindow?: string;
  maxOutput?: string;
  /** 模态能力（如 ["text"] / ["text","image"]）；自定义模型由用户选择，知名模型由发现结果携带。 */
  inputModalities?: string[];
}
export interface ProviderInfo {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  protocol?: string;
  models: ProviderModel[];
}

/** 首次打开时的预置提供商。
 *  deepseek-official 是 llm-deepseek 插件注册的官方路由（含多模态模型），
 *  与 pi-ai 的 deepseek 路由并存互补；其 API Key 走环境变量 DEEPSEEK_API_KEY，
 *  保存时不写入 llm-pi-ai.providers（由扩展侧 applyProviders 过滤）。 */
const DEFAULT_PROVIDERS: ProviderInfo[] = [
  { id: "deepseek", name: "DeepSeek", type: "deepseek", baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] },
  { id: "deepseek-official", name: "DeepSeek (Official)", type: "deepseek-official", baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash-vision-exp" }] },
  { id: "ollama", name: "Ollama (local)", type: "ollama", baseUrl: "http://localhost:11434/v1", models: [{ id: "llama3.1" }, { id: "qwen2.5" }] },
];
const PROVIDERS_KEY = "dshProviders";
const providerSecretKey = (id: string): string => `dshVscode.provider.${id}.apiKey`;

export interface ConfigPanelDeps {
  /** 读取当前生效配置（API Key 不含密钥库，面板侧自行合并判断）。 */
  readConfig: () => {
    apiKey?: string;
    baseUrl?: string;
    model: string;
    permissionMode: string;
    nodePath: string;
    maxSteps: number;
    subagentMaxDepth: number;
    maxParallelSubagents: number;
    autoCompaction: boolean;
    compactionThresholdRatio: number;
    compactionMaxTokens: number;
    rotateBytes: number;
    rotateSummary: boolean;
    rotateFallbackMsgs: number;
    enableCustom: boolean;
    enableLearning: boolean;
    enableAutoLearn: boolean;
    autoApproveRules: { match: string; action: string }[];
  };
  /** 当前 Agent 工作目录（展示用）。 */
  workspaceRoot: () => string;
  /** DSH home 路径（个性定制文件 ay-dsh-custom.md / ay-dsh-learning.md 所在）。 */
  dshHomePath: string;
  /**
   * 配置保存**事务边界**：onConfigSaveStart 在保存开始（首次写配置前）调用，
   * onConfigSaveEnd 在保存结束（无论成败）调用。期间扩展忽略逐项配置变更事件，
   * 由 onSaved（成功）统一按新配置重启宿主——避免"半套配置重启"。
   */
  onConfigSaveStart: () => void;
  onConfigSaveEnd: () => void;
  /** 保存成功后回调：restart=true 表示宿主运行参数已变化（锁定 UI + 重启宿主），
   *  false 表示仅刷新视图（提供商变更已热生效，无需重启）。 */
  onSaved: (restart: boolean) => void;
  /** 查询 DSH 提供商目录（Provider ID 下拉数据源；宿主未运行则先拉起）。 */
  queryProviders: () => Promise<{ id: string; name: string }[]>;
  /** 把整套提供商配置同步进 DSH（llm-pi-ai settings + credentials，热生效）。 */
  applyProviders: (providers: ProviderApplyItem[]) => Promise<string | undefined>;
  /** 模型发现（catalog 提供商免网络返回模型+元数据；未知提供商探活端点）。 */
  discoverModels: (opts: { provider?: string; baseURL?: string; api?: string; apiKey?: string }) => Promise<{ models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[] }[]; error?: string }>;
  /** 提供商配置同步完成后回调（扩展侧触发宿主 getModelInfo，刷新聊天面板模型列表）。 */
  onProvidersSynced: () => void;
  /* ---------------- 版本升级（配置面板"版本升级"组） ---------------- */
  /** 当前版本快照（DSH 当前/内置 + 插件当前）。 */
  upgradeState: () => { dshCurrent?: string; dshBundled?: string; pluginCurrent: string };
  /** 缓存的版本列表（仅版本信息；无缓存返回空数组）。 */
  cachedDshVersions: () => UpgradeVersionInfo[];
  cachedPluginVersions: () => UpgradeVersionInfo[];
  /** 重新查询（GitHub Releases，只列比基线更高的版本），结果写入缓存。 */
  queryDshVersions: () => Promise<{ versions: UpgradeVersionInfo[]; error?: string }>;
  queryPluginVersions: () => Promise<{ versions: UpgradeVersionInfo[]; error?: string }>;
  /** 执行升级（DSH 核心 / 插件）。返回成功与否；状态栏提示由扩展侧负责。 */
  upgradeDsh: (version: string) => Promise<boolean>;
  upgradePlugin: (version: string) => Promise<{ ok: boolean; message?: string }>;
  /** 重置 DSH 核心回插件包原始版本。 */
  resetDsh: () => Promise<void>;
}

let activePanel: vscode.WebviewPanel | undefined;

export function openConfigPanel(context: vscode.ExtensionContext, deps: ConfigPanelDeps): void {
  if (activePanel) {
    activePanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "dshVscode.configPanel",
    "AY-DSH — 配置",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    }
  );
  activePanel = panel;
  // 个性定制文件（DSH home 固定路径固定文件名，跨项目共享）
  const customPromptFile = join(deps.dshHomePath, "ay-dsh-custom.md");
  const learningFile = join(deps.dshHomePath, "ay-dsh-learning.md");
  let customMtime = 0;
  let learningMtime = 0;
  const readCustomFile = (p: string): string => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    } catch {
      return "";
    }
  };
  const mtimeOf = (p: string): number => {
    try {
      return existsSync(p) ? statSync(p).mtimeMs : 0;
    } catch {
      return 0;
    }
  };
  /** 刷新个性定制预览（显示用；mtime 保持基准值，供"保存"检测编辑）。 */
  const refreshCustomFiles = (): void => {
    panel.webview.postMessage({
      t: "customFiles",
      custom: { text: readCustomFile(customPromptFile), mtime: customMtime },
      learning: { text: readCustomFile(learningFile), mtime: learningMtime },
    });
  };
  // 从编辑器切回配置面板时刷新个性定制预览（用户编辑保存后可见新内容）
  panel.onDidChangeViewState(() => {
    if (panel.visible) refreshCustomFiles();
  });
  panel.onDidDispose(() => {
    if (activePanel === panel) activePanel = undefined;
  });

  const zh = vscode.env.language.startsWith("zh");
  // 升级/重置确认框按钮文案（扩展侧原生对话框；webview 内 window.confirm 被禁用）
  const CONFIRM_UPGRADE = zh ? "确认升级" : "Upgrade";
  const CONFIRM_RESET = zh ? "确认重置" : "Reset";
  const CONFIRM_CANCEL = zh ? "取消" : "Cancel";
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "config-panel.js"));
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "config-panel.css"));
  panel.webview.html = renderHtml(panel.webview, scriptUri, styleUri, zh);

  /** 读取已接入提供商（globalState 跨工作区持久化；首次自动初始化预置列表）。
   *  兼容迁移：重构前存于 workspaceState（per-workspace），读到则迁入 globalState。 */
  const loadProviders = (): ProviderInfo[] => {
    const saved = context.globalState.get<ProviderInfo[]>(PROVIDERS_KEY);
    if (Array.isArray(saved) && saved.length > 0) return saved;
    const legacy = context.workspaceState.get<ProviderInfo[]>(PROVIDERS_KEY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      void context.globalState.update(PROVIDERS_KEY, legacy);
      return legacy;
    }
    const init = DEFAULT_PROVIDERS;
    void context.globalState.update(PROVIDERS_KEY, init);
    return init;
  };
  const saveProviders = (list: ProviderInfo[]): void => {
    void context.globalState.update(PROVIDERS_KEY, list);
  };

  /** 把当前提供商列表（含已存密钥）全量同步进 DSH（llm-pi-ai settings + credentials，热生效）。
   *  失败不阻塞面板：宿主侧记录错误，下次保存会再次尝试。 */
  const syncProvidersToHost = async (): Promise<void> => {
    try {
      const items: ProviderApplyItem[] = await Promise.all(
        loadProviders().map(async (p) => {
          let apiKey: string | undefined;
          try {
            apiKey = (await context.secrets.get(providerSecretKey(p.id))) ?? undefined;
          } catch {
            apiKey = undefined;
          }
          return { id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol, models: p.models, apiKey };
        })
      );
      await deps.applyProviders(items);
      deps.onProvidersSynced();
    } catch {
      // 同步失败不阻塞面板
    }
  };

  /** 向面板推送当前配置快照（init 与保存成功后复用）。防御：任何异常都推最小快照，
   *  避免面板白屏（providers/字段全空的表象往往是 sendConfig 抛错）。 */
  const sendConfig = async () => {
    try {
      const c = deps.readConfig();
      const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
      // 快路径：providers 列表立即推送（密钥状态先置 false），不等密钥库——
      // 密钥库 IPC 较慢（尤其首次解锁），逐项 await 会让面板"先空后满"（两阶段感）
      const providers = loadProviders().map((p) => ({ ...p, apiKeyConfigured: false }));
      panel.webview.postMessage({
        t: "config",
        config: {
          permissionMode: c.permissionMode,
          nodePath: c.nodePath,
          defaultWorkspace: cfg.get<string>("defaultWorkspace") ?? "",
          maxOutputChars: cfg.get<number>("maxOutputChars") ?? 40000,
          maxSteps: cfg.get<number>("maxSteps") ?? 100,
          subagentMaxDepth: cfg.get<number>("subagentMaxDepth") ?? 3,
          maxParallelSubagents: cfg.get<number>("maxParallelSubagents") ?? 5,
          autoCompaction: cfg.get<boolean>("autoCompaction") ?? true,
          compactionThresholdRatio: cfg.get<number>("compactionThresholdRatio") ?? 0.8,
          compactionMaxTokens: cfg.get<number>("compactionMaxTokens") ?? 8192,
          rotateBytes: Number.isFinite(cfg.get<number>("rotateBytes")) && (cfg.get<number>("rotateBytes") ?? 0) > 0 ? cfg.get<number>("rotateBytes") : 10,
          rotateSummary: cfg.get<boolean>("rotateSummary") ?? true,
          rotateFallbackMsgs: Number.isFinite(cfg.get<number>("rotateFallbackMsgs")) && (cfg.get<number>("rotateFallbackMsgs") ?? 0) > 0 ? cfg.get<number>("rotateFallbackMsgs") : 5,
          enableCustom: cfg.get<boolean>("enableCustom") ?? false,
          enableLearning: cfg.get<boolean>("enableLearning") ?? false,
          enableAutoLearn: cfg.get<boolean>("enableAutoLearn") ?? false,
          autoApproveRules: cfg.get<{ match: string; action: string }[]>("autoApproveRules") ?? [],
          cwd: deps.workspaceRoot(),
        },
        providers,
      });
      // 慢路径：异步读密钥库，完成后补发密钥状态（🔑 徽标）——不阻塞列表渲染
      void (async () => {
        try {
          const states: Record<string, boolean> = {};
          await Promise.all(
            loadProviders().map(async (p) => {
              let configured = false;
              try {
                configured = Boolean(await context.secrets.get(providerSecretKey(p.id)));
                // 旧版全局 API Key（dshVscode.apiKey）迁移兜底：deepseek 条目读不到专属 key 时
                // 视为已配置（旧面板曾把 deepseek key 存在全局键）。
                if (!configured && p.id === "deepseek") {
                  configured = Boolean(await context.secrets.get(SECRET_KEY));
                }
              } catch {
                configured = false;
              }
              states[p.id] = configured;
            })
          );
          panel.webview.postMessage({ t: "providerKeys", states });
        } catch {
          // 密钥状态读取失败不影响面板（徽标保持未显示）
        }
      })();
    } catch (e) {
      vscode.window.setStatusBarMessage(
        `✗ Config panel load failed: ${e instanceof Error ? e.message : String(e)}`,
        8000
      );
      panel.webview.postMessage({
        t: "config",
        config: {
          permissionMode: "workspace-write",
          nodePath: "",
          defaultWorkspace: "",
          maxOutputChars: 40000,
          maxSteps: 100,
          subagentMaxDepth: 3,
          maxParallelSubagents: 5,
          autoCompaction: true,
          compactionThresholdRatio: 0.8,
          compactionMaxTokens: 8192,
          rotateBytes: 10,
          rotateSummary: true,
          rotateFallbackMsgs: 5,
          autoApproveRules: [],
          cwd: "",
        },
        providers: [],
      });
    }
  };

  /** 推送版本升级初始状态（当前版本 + 缓存列表，无缓存则面板显示当前版本）。 */
  const pushUpgradeState = (): void => {
    const st = deps.upgradeState();
    panel.webview.postMessage({
      t: "upgradeState",
      dsh: { current: st.dshCurrent, bundled: st.dshBundled, versions: deps.cachedDshVersions() },
      plugin: { current: st.pluginCurrent, versions: deps.cachedPluginVersions() },
    });
  };

  /** 查询并推送结果（kind: "dsh" | "plugin"）。 */
  const runQuery = async (kind: "dsh" | "plugin"): Promise<void> => {
    const r = kind === "dsh" ? await deps.queryDshVersions() : await deps.queryPluginVersions();
    panel.webview.postMessage({ t: `${kind}QueryResult`, versions: r.versions, error: r.error });
  };

  /** 执行升级并推送结果。 */
  const runApply = async (kind: "dsh" | "plugin", version: string): Promise<void> => {
    if (kind === "dsh") {
      const ok = await deps.upgradeDsh(version);
      panel.webview.postMessage({ t: "dshApplyResult", ok });
    } else {
      const r = await deps.upgradePlugin(version);
      panel.webview.postMessage({ t: "pluginApplyResult", ok: r.ok, message: r.message });
    }
  };

  /** 重置 DSH 核心回插件包原始版本。 */
  const runReset = async (): Promise<void> => {
    await deps.resetDsh();
    panel.webview.postMessage({ t: "dshResetResult", ok: true });
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.t) {
      case "init": {
        await sendConfig();
        pushUpgradeState();
        // 个性定制文件（DSH home 固定名）：记录 mtime 基准（"保存"比对用）
        customMtime = mtimeOf(customPromptFile);
        learningMtime = mtimeOf(learningFile);
        refreshCustomFiles();
        break;
      }
      case "editCustomFile": {
        // 打开 VS Code 编辑器编辑个性文件（首次编辑时创建）
        const file = msg.kind === "learning" ? learningFile : customPromptFile;
        if (!existsSync(file)) {
          writeFileSync(file, msg.kind === "learning" ? "# 自动学习的工作经验\n\n" : "# 用户定制提示词\n\n", "utf8");
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
        break;
      }
      case "saveCustom": {
        // "个性定制"组"保存"：落盘三个开关（enableCustom/enableLearning/enableAutoLearn）
        // + 保存打开中的 dirty 文档 + 更新 mtime 基准。**不重启宿主**——生效由
        // 功能组菜单"重启应用"（restartApply）统一触发（见文件头部"保存规则"注释）。
        const sv = (msg as { values?: Record<string, unknown> }).values ?? {};
        deps.onConfigSaveStart();
        try {
          for (const doc of vscode.workspace.textDocuments) {
            if (doc.isDirty && (doc.uri.fsPath === customPromptFile || doc.uri.fsPath === learningFile)) {
              await doc.save();
            }
          }
          const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
          if (typeof sv.enableCustom === "boolean") {
            await cfg.update("enableCustom", sv.enableCustom, vscode.ConfigurationTarget.Global);
          }
          if (typeof sv.enableLearning === "boolean") {
            await cfg.update("enableLearning", sv.enableLearning, vscode.ConfigurationTarget.Global);
          }
          if (typeof sv.enableAutoLearn === "boolean") {
            await cfg.update("enableAutoLearn", sv.enableAutoLearn, vscode.ConfigurationTarget.Global);
          }
          customMtime = mtimeOf(customPromptFile);
          learningMtime = mtimeOf(learningFile);
          deps.onSaved(false);
          vscode.window.setStatusBarMessage(
            zh ? "✅ 配置保存成功，重启宿主后生效" : "✅ Settings saved; effective after host restart",
            5000
          );
          panel.webview.postMessage({ t: "saved", ok: true, message: zh ? "配置保存成功，重启宿主后生效" : "Settings saved; effective after host restart" });
          await sendConfig();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.setStatusBarMessage(zh ? `✗ 配置保存失败：${message}` : `✗ Failed to save settings: ${message}`, 8000);
          panel.webview.postMessage({ t: "saved", ok: false, message });
        } finally {
          deps.onConfigSaveEnd();
        }
        break;
      }
      case "pickFolder": {
        const isNode = msg.field === "nodePath";
        const picked = await vscode.window.showOpenDialog({
          title: isNode ? "选择 Node 可执行文件" : "选择默认工作目录",
          canSelectFiles: isNode,
          canSelectFolders: !isNode,
          canSelectMany: false,
          openLabel: isNode ? "选择此文件" : "选择此目录",
        });
        panel.webview.postMessage({ t: "folder", field: msg.field, path: picked?.[0]?.fsPath });
        break;
      }
      case "providerSave": {
        // 新增/编辑提供商：id 存在则更新，否则追加；API Key 单独存密钥库。
        // provider id 是唯一标识：新增时 id 已存在（重复添加）直接拒绝并提示。
        const p = msg.provider as ProviderInfo | undefined;
        if (!p?.id || !p?.name?.trim()) break;
        const isEdit = msg.isEdit === true;
        const list = loadProviders();
        const idx = list.findIndex((x) => x.id === p.id);
        if (!isEdit && idx >= 0) {
          vscode.window.setStatusBarMessage(
            zh ? `✗ 提供商 ${p.id} 已存在：id 唯一，请编辑而非重复添加` : `✗ Provider ${p.id} already exists: id is unique — edit it instead`,
            6000
          );
          break;
        }
        const clean = { ...p, name: p.name.trim(), baseUrl: (p.baseUrl ?? "").trim(), models: Array.isArray(p.models) ? p.models : [] };
        if (idx >= 0) list[idx] = clean;
        else list.push(clean);
        saveProviders(list);
        if (typeof msg.apiKey === "string" && msg.apiKey !== "") {
          await context.secrets.store(providerSecretKey(p.id), msg.apiKey);
        }
        await sendConfig();
        void syncProvidersToHost();
        break;
      }
      case "providerDelete": {
        if (typeof msg.id !== "string") break;
        saveProviders(loadProviders().filter((x) => x.id !== msg.id));
        await context.secrets.delete(providerSecretKey(msg.id));
        await sendConfig();
        void syncProvidersToHost();
        break;
      }
      case "queryProviders": {
        // 提供商目录（DSH listProviders + listConfigurableProviders），Provider ID 下拉数据源
        const list = await deps.queryProviders();
        panel.webview.postMessage({ t: "providersCatalog", providers: list });
        break;
      }
      case "fetchModels": {
        // 实时查询提供商模型列表：优先走 DSH 模型发现（catalog 提供商返回模型+元数据，
        // 无需网络与 key）；未知提供商回退 OpenAI 兼容 /models 端点查询（仅 id）。
        // 编辑已配置密钥的提供商时输入框为空，用密钥库中已存 key 兜底。
        const baseUrl = typeof msg.baseUrl === "string" ? msg.baseUrl.trim().replace(/\/+$/, "") : "";
        const providerId = typeof msg.providerId === "string" ? msg.providerId : "";
        let apiKey = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
        if (!apiKey && providerId !== "") {
          try {
            apiKey = (await context.secrets.get(providerSecretKey(providerId))) ?? "";
            if (!apiKey) apiKey = (await context.secrets.get(SECRET_KEY)) ?? ""; // 旧版全局 key 迁移兜底
          } catch {
            apiKey = "";
          }
        }
        const protocol = typeof msg.protocol === "string" ? msg.protocol : "openai-completions";
        // 1) DSH 模型发现（知名提供商 catalog 免网络；自定义提供商用 baseURL/apiKey 探活）
        if (providerId !== "") {
          try {
            const disc = await deps.discoverModels({
              provider: providerId,
              baseURL: baseUrl,
              api: protocol,
              apiKey: apiKey || undefined,
            });
            if (!disc.error && Array.isArray(disc.models) && disc.models.length > 0) {
              panel.webview.postMessage({
                t: "models",
                models: disc.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, inputModalities: m.inputModalities })),
              });
              break;
            }
          } catch {
            // 发现失败 → 回退网络查询
          }
        }
        // 2) 回退：OpenAI 兼容 /models 端点
        if (!baseUrl) {
          panel.webview.postMessage({ t: "models", models: [], error: "missing baseUrl" });
          break;
        }
        try {
          // 网络查询加超时（10s）：慢端点/无响应时不至于让面板一直停在"查询中…"
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 10000);
          let res: Response;
          try {
            res = await fetch(`${baseUrl}/models`, {
              headers: {
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                "User-Agent": "ay-dsh-vscode",
              },
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { data?: { id?: string }[] };
          const models = (data.data ?? [])
            .map((m) => m.id)
            .filter((x): x is string => typeof x === "string")
            .map((id) => ({ id }));
          panel.webview.postMessage({ t: "models", models });
        } catch (e) {
          panel.webview.postMessage({
            t: "models",
            models: [],
            error: e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e),
          });
        }
        break;
      }
      case "save": {
        const v = msg.values ?? {};
        // 方案 B：各组独立"保存"按钮 → 本分支**只落盘本次提供的字段**（部分更新），
        // 绝不重启宿主；生效由功能组菜单"重启应用"（restartApply）统一触发。
        // 事务标志：抑制 onDidChangeConfiguration 的自动重启，保存本身不重启宿主。
        deps.onConfigSaveStart();
        // 保存中提示常显（60s 兜底），保存完成时被成功/失败提示立即覆盖——
        // 保证保存全程状态栏都有明确反馈
        vscode.window.setStatusBarMessage(zh ? "⏳ 正在保存配置…" : "⏳ Saving settings…", 60000);
        try {
          // 1. API Key：清除 / 写入密钥库（写入时清空设置项，保持"密钥库优先"策略）
          if (v.clearKey) {
            await context.secrets.delete(SECRET_KEY);
          } else if (typeof v.apiKey === "string" && v.apiKey !== "") {
            await context.secrets.store(SECRET_KEY, v.apiKey);
            await vscode.workspace
              .getConfiguration(CONFIG_NS)
              .update("apiKey", "", vscode.ConfigurationTarget.Global);
          }
          // 2. 普通配置项（Global）：**仅更新本次提供的字段**（未提供 = 不触碰），
          //    避免"保存运行环境组"把控制参数/日志字段重置为默认值。
          const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
          if (typeof v.model === "string" && v.model.trim() !== "") {
            await cfg.update("model", v.model.trim(), vscode.ConfigurationTarget.Global);
          }
          if (typeof v.baseUrl === "string") {
            await cfg.update("baseUrl", v.baseUrl.trim(), vscode.ConfigurationTarget.Global);
          }
          if (typeof v.permissionMode === "string") {
            await cfg.update(
              "permissionMode",
              ["workspace-write", "read-only", "danger-full-access"].includes(v.permissionMode) ? v.permissionMode : "workspace-write",
              vscode.ConfigurationTarget.Global
            );
          }
          // 运行环境相关参数（nodePath/defaultWorkspace/maxOutputChars）存入**工作区设置**：
          // 跟随项目目录、按环境天然隔离（本地 / Remote 各自读写本机的 .vscode/settings.json），
          // 不受 VS Code 设置同步（Settings Sync）的跨环境污染；无工作区时回退用户设置。
          const runtimeTarget = vscode.workspace.workspaceFolders?.[0]
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
          if (typeof v.nodePath === "string") {
            await cfg.update("nodePath", v.nodePath.trim(), runtimeTarget);
          }
          if (typeof v.defaultWorkspace === "string") {
            await cfg.update("defaultWorkspace", v.defaultWorkspace.trim(), runtimeTarget);
          }
          if (typeof v.maxOutputChars === "number") {
            await cfg.update("maxOutputChars", v.maxOutputChars > 0 ? v.maxOutputChars : 40000, runtimeTarget);
          }
          if (typeof v.maxSteps === "number") {
            await cfg.update("maxSteps", v.maxSteps >= 0 ? v.maxSteps : 100, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.subagentMaxDepth === "number") {
            await cfg.update("subagentMaxDepth", v.subagentMaxDepth > 0 ? v.subagentMaxDepth : 3, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.maxParallelSubagents === "number") {
            await cfg.update("maxParallelSubagents", v.maxParallelSubagents > 0 ? v.maxParallelSubagents : 5, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.autoCompaction === "boolean") {
            await cfg.update("autoCompaction", v.autoCompaction, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.compactionThresholdRatio === "number") {
            await cfg.update("compactionThresholdRatio", v.compactionThresholdRatio > 0 ? Math.min(1, v.compactionThresholdRatio) : 0.8, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.compactionMaxTokens === "number") {
            await cfg.update("compactionMaxTokens", v.compactionMaxTokens > 0 ? v.compactionMaxTokens : 8192, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.rotateBytes === "number") {
            await cfg.update("rotateBytes", v.rotateBytes > 0 ? v.rotateBytes : 10, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.rotateSummary === "boolean") {
            await cfg.update("rotateSummary", v.rotateSummary, vscode.ConfigurationTarget.Global);
          }
          if (typeof v.rotateFallbackMsgs === "number") {
            await cfg.update("rotateFallbackMsgs", v.rotateFallbackMsgs > 0 ? v.rotateFallbackMsgs : 5, vscode.ConfigurationTarget.Global);
          }
          // （enableCustom/enableLearning/enableAutoLearn 由"个性定制"组保存处理；
          //  autoApproveRules 由"权限审批"组保存处理——本分支不再触碰，避免跨组覆盖）
          // 刷新面板状态：API Key 提示（keyConfigured）与各字段回显保存后的真实值
          await sendConfig();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // 保存失败：同样走 VS Code 状态栏提示（不弹任何通知/弹框）
          vscode.window.setStatusBarMessage(
            zh ? `✗ 配置保存失败：${message}` : `✗ Failed to save settings: ${message}`,
            8000
          );
          panel.webview.postMessage({ t: "saved", ok: false, message });
        } finally {
          // 事务结束（无论成败）：恢复对逐项配置变更事件的监听
          deps.onConfigSaveEnd();
        }
        break;
      }
      case "dshApplyConfirm": {
        const v = String(msg.version ?? "");
        if (!v) break;
        const pick = await vscode.window.showWarningMessage(
          zh ? `将 DSH 核心升级到 ${v} 版本？` : `Upgrade DSH core to ${v}?`,
          { modal: true },
          CONFIRM_UPGRADE,
          CONFIRM_CANCEL
        );
        if (pick === CONFIRM_UPGRADE) void runApply("dsh", v);
        else panel.webview.postMessage({ t: "dshApplyResult", ok: false });
        break;
      }
      case "pluginApplyConfirm": {
        const v = String(msg.version ?? "");
        if (!v) break;
        const pick = await vscode.window.showWarningMessage(
          zh ? `将 AY-DSH 升级到 ${v} 版本？` : `Upgrade AY-DSH to ${v}?`,
          { modal: true },
          CONFIRM_UPGRADE,
          CONFIRM_CANCEL
        );
        if (pick === CONFIRM_UPGRADE) void runApply("plugin", v);
        else panel.webview.postMessage({ t: "pluginApplyResult", ok: false });
        break;
      }
      case "dshResetConfirm": {
        const st = deps.upgradeState();
        const bundled = st.dshBundled ?? st.dshCurrent ?? "?";
        const pick = await vscode.window.showWarningMessage(
          zh ? `确认要回退到插件包原始版本 ${bundled}？` : `Reset DSH core back to the bundled version ${bundled}?`,
          { modal: true },
          CONFIRM_RESET,
          CONFIRM_CANCEL
        );
        if (pick === CONFIRM_RESET) void runReset();
        else panel.webview.postMessage({ t: "dshResetResult", ok: false });
        break;
      }
      case "savePermission": {
        // "权限审批"组"保存"：整体写回工具级规则列表 {match, action}。**只落盘，不重启**
        // ——autoApproveRules 变更在扩展侧已单独排除自动重启（onDidChangeConfiguration），
        // 生效由功能组菜单"重启应用"（restartApply）统一触发。
        const raw = (msg as { rules?: unknown }).rules;
        const rules = Array.isArray(raw)
          ? raw
              .filter((r): r is { match?: string; action?: string } => Boolean(r) && typeof r === "object")
              .map((r) => ({ match: String(r.match ?? "").trim(), action: ["allow", "ask", "deny"].includes(String(r.action)) ? String(r.action) : "ask" }))
              .filter((r) => r.match && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.match))
              // 防御性查重：同名规则只保留第一条（前端已查重，此处兜底）
              .filter((r, idx, arr) => arr.findIndex((x) => x.match === r.match) === idx)
          : [];
        await vscode.workspace.getConfiguration(CONFIG_NS).update("autoApproveRules", rules, vscode.ConfigurationTarget.Global);
        deps.onSaved(false);
        vscode.window.setStatusBarMessage(
          zh ? "✅ 配置保存成功，重启宿主后生效" : "✅ Settings saved; effective after host restart",
          5000
        );
        panel.webview.postMessage({ t: "saved", ok: true, message: zh ? "配置保存成功，重启宿主后生效" : "Settings saved; effective after host restart" });
        await sendConfig();
        break;
      }
      case "restartApply": {
        // "重启应用"功能组（命令入口）：确认弹框已由前端在配置**页面内**完成
        // （modal 风格、标题 AY-DSH、确认/取消各一个），此处只执行重启。
        deps.onSaved(true); // 锁定 UI + 重启宿主 + 就绪后自动恢复原会话
        break;
      }
      case "dshQuery":
        void runQuery("dsh");
        break;
      case "pluginQuery":
        void runQuery("plugin");
        break;
      case "dshApply":
        void runApply("dsh", String(msg.version ?? ""));
        break;
      case "pluginApply":
        void runApply("plugin", String(msg.version ?? ""));
        break;
      case "dshReset":
        void runReset();
        break;
      case "cancel":
        panel.dispose();
        break;
    }
  });
}

function renderHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri, zh: boolean): string {
  const L = {
    title: zh ? "AY-DSH 配置" : "AY-DSH Settings",
    navLabel: zh ? "配置分组" : "Settings groups",
    groupModel: zh ? "模型配置" : "Model",
    providersTitle: zh ? "已接入模型提供商" : "Connected model providers",
    addProvider: zh ? "＋ 添加提供商" : "+ Add provider",
    addCustomProvider: zh ? "＋ 自定义提供商" : "+ Custom provider",
    groupRuntime: zh ? "运行环境" : "Runtime",
    groupControl: zh ? "控制参数" : "Control",
    groupLog: zh ? "日志管理" : "Logs",
    groupPersonal: zh ? "个性定制" : "Personalization",
    customPromptTitle: zh ? "用户定制品格" : "Custom persona",
    learningTitle: zh ? "自动学习经验" : "Learned rules",
    editBtn: zh ? "编辑" : "Edit",
    enableCustom: zh ? "启用定制" : "Enable customization",
    enableLearning: zh ? "启用经验" : "Enable learned rules",
    enableAutoLearn: zh ? "启动学习" : "Auto-learn",
    on: zh ? "开" : "On",
    off: zh ? "关" : "Off",
    customPromptHint: zh ? "点击“编辑”在VSCode编辑器修改（首次编辑自动创建文件）；点击“保存”落盘，重启宿主后生效。" : "Click Edit to modify your custom persona in the VS Code editor (auto-created on first edit); then click Save, and restart the host via the “Restart & Apply” group on the left.",
    learningHint: zh ? "点击“编辑”用VSCode编辑器修改（首次编辑自动创建文件）；点击“保存”落盘，重启宿主后生效。" : "Click Edit to modify your learned rules in the VS Code editor (auto-created on first edit); then click Save, and restart the host via the “Restart & Apply” group on the left.",
    saveCustom: zh ? "保存" : "Save",
    rotateBytes: zh ? "会话轮转阈值（MB）" : "Session rotation threshold (MB)",
    rotateBytesHint: zh ? "会话日志超过该大小（MB）时自动轮转，创建新会话继续（默认 10）" : "Rotate when the session log exceeds this size (MB); a new session continues (default 10)",
    rotateSummary: zh ? "轮转时生成对话摘要" : "Summarize conversation on rotation",
    rotateSummaryHint: zh ? "开启后用 LLM 对最近对话生成摘要注入新会话；关闭则直接转移最近消息原文" : "When on, an LLM summarizes the recent conversation into the new session; when off, recent messages are copied verbatim",
    rotateSummaryOn: zh ? "开" : "On",
    rotateSummaryOff: zh ? "关" : "Off",
    rotateFallbackMsgs: zh ? "摘要失败时保留的消息条数" : "Messages kept when summarization fails",
    rotateFallbackMsgsHint: zh ? "LLM 摘要不可用时，从倒数第 N 条用户输入起保留对话原文（默认 5）" : "When the LLM summary fails, keep conversation from the Nth-last user input (default 5)",
    saveLog: zh ? "保存" : "Save",
    workspace: zh ? "默认工作目录（未打开文件夹时）" : "Default working directory (when no folder is open)",
    workspaceHint: zh ? "Agent 生成的文件保存位置；留空使用 ~/ay-dsh-workspace" : "Where agent files are saved; empty uses ~/ay-dsh-workspace",
    cwd: zh ? "当前工作目录" : "Current working directory",
    nodePath: zh ? "Node 可执行文件路径（可选）" : "Node executable path (optional)",
    nodePathHint: zh ? "留空自动探测（系统 node ≥20，回退 VS Code 内置 Node）" : "Leave empty for auto-detect (system node ≥20, fallback VS Code's Node)",
    permission: zh ? "权限模式" : "Permission mode",
    pWorkspace: zh ? "workspace-write — 可写工作区，越界操作弹审批（推荐）" : "workspace-write — write workspace, out-of-scope ops ask approval (recommended)",
    pReadonly: zh ? "read-only — 只读，Agent 不能修改任何文件" : "read-only — agent cannot modify any file",
    pFull: zh ? "danger-full-access — 完全访问，不再审批（谨慎）" : "danger-full-access — full access, no approvals (use with care)",
    maxOutput: zh ? "最大输出字符数（UI 渲染折叠阈值）" : "Max output chars (UI render fold threshold)",
    maxSteps: zh ? "最大思考轮次（0 = 不限制）" : "Max thinking steps (0 = unlimited)",
    maxStepsHint: zh ? "单次任务达到上限自动停止（防无限循环）；临近上限时 AI 会先总结收尾" : "Task stops at the limit to prevent infinite loops; the AI summarizes before the last step",
    subagentDepth: zh ? "子代理递归深度上限" : "Subagent recursion depth limit",
    subagentDepthHint: zh ? "多级子代理嵌套的最大深度（默认 3）" : "Max nesting depth of subagents (default 3)",
    maxParallel: zh ? "并行子代理数量上限" : "Max parallel subagents",
    maxParallelHint: zh ? "多 Agent 模式下同时派发的子代理数量上限（默认 5）" : "Max concurrently dispatched subagents in multi-agent mode (default 5)",
    autoCompaction: zh ? "自动压缩上下文" : "Auto compact context",
    autoCompactionHint: zh ? "上下文占比接近上限时自动归纳为摘要，释放空间" : "When context share nears the limit, summarize older history to free space",
    groupPermission: zh ? "自动授权规则" : "Auto-approval rules",
    permissionHint: zh ? "命中的工具调用按所选动作处理——允许 = 自动放行，不再弹审批框；询问 = 仍会弹框请您确认；拒绝 = 直接拒绝。仅对命中的工具生效，其余调用照常审批。" : "A matched tool call follows the selected action — Allow = auto-approved without prompting; Ask = still prompts for your confirmation; Deny = rejected outright. Only matched tools are affected; others keep normal approval.",
    permissionCommandNote: zh ? "由于 DSH 内核暂未提供具体命令参数，这里仅支持工具级匹配（如 glob / grep / read），暂不支持带参数命令甄别（如 git status）。" : "Because the DSH kernel does not expose command arguments yet, only tool-level matches are supported here (e.g. glob / grep / read); command-level rules (e.g. git status) are not supported.",
    permissionMatch: zh ? "工具名" : "Tool",
    permissionAction: zh ? "动作" : "Action",
    permissionActionAllow: zh ? "允许" : "Allow",
    permissionActionAsk: zh ? "询问" : "Ask",
    permissionActionDeny: zh ? "拒绝" : "Deny",
    permissionAdd: zh ? "＋ 添加规则" : "+ Add rule",
    permissionRemove: zh ? "删除该规则" : "Remove rule",
    permissionEmpty: zh ? "（暂无规则；使用内置默认：glob / grep / read / find 自动允许）" : "(no rules; built-in defaults: glob / grep / read / find allowed)",
    permissionCommandRejected: zh ? "该配置不被接受：DSH 内核暂未提供具体命令参数，仅支持工具级（如 glob / grep / read），不支持带参数命令甄别" : "Rejected: command-level rules are unsupported (the DSH kernel does not expose command args). Use tool-level matches only (e.g. glob / grep / read)",
    autoCompactionOn: zh ? "自动" : "Auto",
    autoCompactionOff: zh ? "手动" : "Manual",
    compactThreshold: zh ? "自动压缩触发比例" : "Auto-compaction threshold ratio",
    compactThresholdHint: zh ? "上下文用到窗口的多少比例时触发压缩（10% ~ 100%，默认 80%）" : "Compact when context reaches this share of the window (10%–100%, default 80%)",
    compactMaxTokens: zh ? "压缩摘要 token 上限" : "Compaction summary token cap",
    compactMaxTokensHint: zh ? "一次压缩生成的摘要最大 token 数（默认 8192）" : "Max tokens in one compaction summary (default 8192)",
    browse: zh ? "浏览…" : "Browse…",
    save: zh ? "保存" : "Save",
    groupUpgrade: zh ? "版本升级" : "Upgrades",
    groupRestartApply: zh ? "重启应用" : "Restart & Apply",
    dshSection: zh ? "DSH 核心升级" : "DSH Core",
    pluginSection: zh ? "AY-DSH-VSCode 插件升级" : "AY-DSH-VSCode extension",
    dshCurrent: zh ? "当前 DSH 核心版本" : "Current DSH core version",
    pluginCurrentLabel: zh ? "当前 AY-DSH 版本" : "Current AY-DSH version",
    latestLabel: zh ? "最新版本" : "Latest version",
    reset: zh ? "重置" : "Reset",
    update: zh ? "更新" : "Update",
    refresh: zh ? "重新查询" : "Re-check",
    notesPlaceholder: zh ? "（选择版本后在此显示 Release Notes）" : "(Release notes appear here after selecting a version)",
    loading: zh ? "查询中…" : "Querying…",
    noNewer: zh ? "（没有比当前更高的版本）" : "(no newer version available)",
    dshResetConfirm: zh ? "确认要回退到插件包原始版本" : "Reset DSH core back to the bundled version",
    dshUpgradeConfirm: zh ? "将 DSH 核心升级到" : "Upgrade DSH core to",
    pluginUpgradeConfirm: zh ? "将 AY-DSH 升级到" : "Upgrade AY-DSH to",
    versionSuffix: zh ? "版本？" : " version?",
    resetHint: zh ? "回退 DSH 核心到插件包原始版本（清空升级记录）" : "Reset DSH core back to the bundled version (clears upgrade history)",
    updateDshHint: zh ? "将 DSH 核心升级到下拉框所选版本（先自检兼容性）" : "Upgrade DSH core to the selected version (compatibility self-check first)",
    refreshDshHint: zh ? "从 GitHub 重新拉取 DSH 核心可用版本（只列比内置更高的）" : "Re-fetch DSH core versions from GitHub (newer than bundled only)",
    updatePluginHint: zh ? "将 AY-DSH 插件升级到下拉框所选版本（下载 VSIX 安装，需重载窗口）" : "Upgrade the AY-DSH extension to the selected version (downloads VSIX; reload required)",
    refreshPluginHint: zh ? "从 GitHub 重新拉取插件可用版本（只列比当前更高的）" : "Re-fetch extension versions from GitHub (newer than current only)",
  };

  // CSP：与聊天视图同款写法（webview.cspSource 为标准做法）。
  // 此前误用完整资源 URL 作为 source，可能被拦截导致样式/脚本不加载（裸 HTML）。
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    "img-src data:",
    "font-src data:",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri.toString()}">
<title>${L.title}</title>
</head>
<body data-locale="${zh ? "zh" : "en"}">
<h1>◈ ${L.title}</h1>

<div class="cfg-layout">
  <nav class="cfg-sidebar" id="cfgSidebar" aria-label="${L.navLabel}">
    <button type="button" class="cfg-nav active" data-group="model">${L.groupModel}</button>
    <button type="button" class="cfg-nav" data-group="runtime">${L.groupRuntime}</button>
    <button type="button" class="cfg-nav" data-group="control">${L.groupControl}</button>
    <button type="button" class="cfg-nav" data-group="permission">${L.groupPermission}</button>
    <button type="button" class="cfg-nav" data-group="log">${L.groupLog}</button>
    <button type="button" class="cfg-nav" data-group="personal">${L.groupPersonal}</button>
    <button type="button" class="cfg-nav" data-group="upgrade">${L.groupUpgrade}</button>
    <button type="button" class="cfg-nav" data-group="restartApply">${L.groupRestartApply}</button>
  </nav>

  <section class="cfg-content">
    <div class="cfg-group active" data-group="model">
      <div class="cfg-pane active" data-pane="main">
        <div class="providers-section">
          <h3 class="sub-title">${L.providersTitle}</h3>
          <div class="providers-list" id="providersList"></div>
          <div class="providers-actions">
            <button type="button" class="secondary" id="cfgAddProvider">${L.addProvider}</button>
            <button type="button" class="secondary" id="cfgAddCustomProvider">${L.addCustomProvider}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="cfg-group" data-group="runtime">
      <div class="cfg-pane active" data-pane="main">
        <div class="field">
          <label for="cfgDefaultWorkspace">${L.workspace}</label>
          <div class="row">
            <input type="text" id="cfgDefaultWorkspace" placeholder="~/ay-dsh-workspace" spellcheck="false">
            <button type="button" class="secondary" id="cfgPickWorkspace">${L.browse}</button>
          </div>
          <span class="hint">${L.workspaceHint}</span>
        </div>
        <div class="field">
          <label for="cfgCwd">${L.cwd}</label>
          <div class="row">
            <input type="text" id="cfgCwd" readonly spellcheck="false">
          </div>
        </div>
        <div class="field">
          <label for="cfgNodePath">${L.nodePath}</label>
          <div class="row">
            <input type="text" id="cfgNodePath" placeholder="C:\\Program Files\\nodejs\\node.exe" spellcheck="false">
            <button type="button" class="secondary" id="cfgPickNode">${L.browse}</button>
          </div>
          <span class="hint">${L.nodePathHint}</span>
        </div>
        <div class="cfg-group-actions">
          <button type="button" class="primary" id="cfgSaveRuntime">${L.save}</button>
        </div>
      </div>
    </div>

    <div class="cfg-group" data-group="control">
      <div class="cfg-pane active" data-pane="main">
        <div class="field">
          <label for="cfgPermissionMode">${L.permission}</label>
          <select id="cfgPermissionMode">
            <option value="workspace-write">${L.pWorkspace}</option>
            <option value="read-only">${L.pReadonly}</option>
            <option value="danger-full-access">${L.pFull}</option>
          </select>
        </div>
        <div class="field">
          <label for="cfgMaxOutputChars">${L.maxOutput}</label>
          <input type="number" id="cfgMaxOutputChars" min="1000" step="1000" value="40000">
        </div>
        <div class="field">
          <label for="cfgMaxSteps">${L.maxSteps}</label>
          <input type="number" id="cfgMaxSteps" min="0" step="10" value="100">
          <span class="hint">${L.maxStepsHint}</span>
        </div>
        <div class="field">
          <label for="cfgSubagentDepth">${L.subagentDepth}</label>
          <input type="number" id="cfgSubagentDepth" min="1" step="1" value="3">
          <span class="hint">${L.subagentDepthHint}</span>
        </div>
        <div class="field">
          <label for="cfgMaxParallel">${L.maxParallel}</label>
          <input type="number" id="cfgMaxParallel" min="1" step="1" value="5">
          <span class="hint">${L.maxParallelHint}</span>
        </div>
        <div class="field">
          <label for="cfgAutoCompaction">${L.autoCompaction}</label>
          <div class="checkbox-row">
            <input type="checkbox" id="cfgAutoCompaction" checked>
            <span class="hint" id="cfgAutoCompactionState">${L.autoCompactionOn}</span>
          </div>
          <span class="hint">${L.autoCompactionHint}</span>
        </div>
        <div class="field">
          <label for="cfgCompactThreshold">${L.compactThreshold}</label>
          <div class="suffix-row">
            <input type="number" id="cfgCompactThreshold" min="10" max="100" step="5" value="80">
            <span class="hint">%</span>
          </div>
          <span class="hint">${L.compactThresholdHint}</span>
        </div>
        <div class="field">
          <label for="cfgCompactMaxTokens">${L.compactMaxTokens}</label>
          <input type="number" id="cfgCompactMaxTokens" min="1" step="1000" value="8192">
          <span class="hint">${L.compactMaxTokensHint}</span>
        </div>
        <div class="cfg-group-actions">
          <button type="button" class="primary" id="cfgSaveControl">${L.save}</button>
        </div>
      </div>
    </div>

    <div class="cfg-group" data-group="permission">
      <div class="cfg-pane active" data-pane="main">
        <h3 class="sub-title">${L.groupPermission}</h3>
        <p class="hint" style="margin-top:0">${L.permissionHint}</p>
        <div id="permissionRules" class="permission-rules"></div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="secondary" id="cfgAddPermission">${L.permissionAdd}</button>
        </div>
        <p class="hint permission-note">${L.permissionCommandNote}</p>
        <div class="cfg-group-actions">
          <button type="button" class="primary" id="cfgSavePermission">${L.save}</button>
        </div>
      </div>
    </div>

    <div class="cfg-group" data-group="log">
      <div class="cfg-pane active" data-pane="main">
        <div class="field">
          <label for="cfgRotateBytes">${L.rotateBytes}</label>
          <input type="number" id="cfgRotateBytes" min="1" step="1" value="10">
          <span class="hint">${L.rotateBytesHint}</span>
        </div>
        <div class="field">
          <label for="cfgRotateSummary">${L.rotateSummary}</label>
          <div class="checkbox-row">
            <input type="checkbox" id="cfgRotateSummary" checked>
            <span class="hint" id="cfgRotateSummaryState">${L.rotateSummaryOn}</span>
          </div>
          <span class="hint">${L.rotateSummaryHint}</span>
        </div>
        <div class="field">
          <label for="cfgRotateFallbackMsgs">${L.rotateFallbackMsgs}</label>
          <input type="number" id="cfgRotateFallbackMsgs" min="1" step="1" value="5">
          <span class="hint">${L.rotateFallbackMsgsHint}</span>
        </div>
        <div class="cfg-group-actions">
          <button type="button" class="primary" id="cfgSaveLog">${L.save}</button>
        </div>
      </div>
    </div>

    <div class="cfg-group" data-group="personal">
      <div class="cfg-pane active" data-pane="main">
        <div class="field">
          <div class="checkbox-row">
            <input type="checkbox" id="cfgEnableCustom" checked>
            <label for="cfgEnableCustom">${L.enableCustom}</label>
          </div>
          <span class="hint" id="cfgEnableCustomHint">…</span>
          <div class="field-label-row">
            <label for="cfgCustomPrompt">${L.customPromptTitle}</label>
            <button type="button" id="btnEditCustom" class="icon-btn small">${L.editBtn}</button>
          </div>
          <div id="cfgCustomPrompt" class="readonly-box markdown-box"></div>
          <span class="hint">${L.customPromptHint}</span>
        </div>
        <div class="field">
          <div class="checkbox-row">
            <input type="checkbox" id="cfgEnableLearning" checked>
            <label for="cfgEnableLearning">${L.enableLearning}</label>
          </div>
          <span class="hint" id="cfgEnableLearningHint">…</span>
          <div class="checkbox-row">
            <input type="checkbox" id="cfgEnableAutoLearn" checked>
            <label for="cfgEnableAutoLearn">${L.enableAutoLearn}</label>
          </div>
          <span class="hint" id="cfgEnableAutoLearnHint">…</span>
          <div class="field-label-row">
            <label for="cfgLearning">${L.learningTitle}</label>
            <button type="button" id="btnEditLearning" class="icon-btn small">${L.editBtn}</button>
          </div>
          <div id="cfgLearning" class="readonly-box markdown-box"></div>
          <span class="hint">${L.learningHint}</span>
        </div>
        <div class="cfg-group-actions">
          <button type="button" class="primary" id="cfgSavePersonal">${L.save}</button>
        </div>
      </div>
    </div>

    <div class="cfg-group" data-group="upgrade">
      <div class="cfg-pane active" data-pane="main">
        <h3 class="sub-title">${L.dshSection}</h3>
        <div class="field">
          <div class="row version-row">
            <span>${L.dshCurrent}：<b id="upgDshCurrent">—</b></span>
            <button type="button" class="primary" id="upgDshReset" title="${L.resetHint}">${L.reset}</button>
          </div>
        </div>
        <div class="field">
          <label for="upgDshSelect">${L.latestLabel}：</label>
          <div class="row">
            <select id="upgDshSelect"></select>
            <button type="button" class="primary" id="upgDshUpdate" title="${L.updateDshHint}">${L.update}</button>
            <button type="button" class="primary" id="upgDshRefresh" title="${L.refreshDshHint}">${L.refresh}</button>
          </div>
        </div>
        <div class="field">
          <div id="upgDshNotes" class="notes-box notes-rendered" aria-label="${L.notesPlaceholder}"></div>
        </div>

        <h3 class="sub-title upgrade-divider">${L.pluginSection}</h3>
        <div class="field">
          <span>${L.pluginCurrentLabel}：<b id="upgPluginCurrent">—</b></span>
        </div>
        <div class="field">
          <label for="upgPluginSelect">${L.latestLabel}：</label>
          <div class="row">
            <select id="upgPluginSelect"></select>
            <button type="button" class="primary" id="upgPluginUpdate" title="${L.updatePluginHint}">${L.update}</button>
            <button type="button" class="primary" id="upgPluginRefresh" title="${L.refreshPluginHint}">${L.refresh}</button>
          </div>
        </div>
        <div class="field">
          <div id="upgPluginNotes" class="notes-box notes-rendered" aria-label="${L.notesPlaceholder}"></div>
        </div>
      </div>
    </div>

  </section>
</div>

<script src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
