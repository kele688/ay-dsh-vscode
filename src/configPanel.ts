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
 */
import * as vscode from "vscode";
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
    autoApproveRules: { match: string; action: string }[];
  };
  /** 当前 Agent 工作目录（展示用）。 */
  workspaceRoot: () => string;
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
        // 无变化秒回：先归一化比较运行参数 + 判断是否有 API Key 操作。
        // 都没有变化时直接返回（不写配置、不重启、不刷新），避免"点保存转半天"。
        const prevC0 = deps.readConfig();
        const prevCfg0 = vscode.workspace.getConfiguration(CONFIG_NS);
        const prev0 = {
          permissionMode: prevC0.permissionMode,
          nodePath: prevC0.nodePath,
          defaultWorkspace: prevCfg0.get<string>("defaultWorkspace") ?? "",
          maxOutputChars: prevCfg0.get<number>("maxOutputChars") ?? 40000,
          maxSteps: Number.isFinite(prevC0.maxSteps) && prevC0.maxSteps >= 0 ? prevC0.maxSteps : 100,
          subagentMaxDepth: Number.isFinite(prevC0.subagentMaxDepth) && prevC0.subagentMaxDepth > 0 ? prevC0.subagentMaxDepth : 3,
          maxParallelSubagents: Number.isFinite(prevC0.maxParallelSubagents) && prevC0.maxParallelSubagents > 0 ? prevC0.maxParallelSubagents : 5,
          autoCompaction: prevC0.autoCompaction ?? true,
          compactionThresholdRatio: Number.isFinite(prevC0.compactionThresholdRatio) && prevC0.compactionThresholdRatio > 0 ? prevC0.compactionThresholdRatio : 0.8,
          compactionMaxTokens: Number.isFinite(prevC0.compactionMaxTokens) && prevC0.compactionMaxTokens > 0 ? prevC0.compactionMaxTokens : 8192,
          rotateBytes: Number.isFinite(prevC0.rotateBytes) && prevC0.rotateBytes > 0 ? prevC0.rotateBytes : 10,
          rotateSummary: prevC0.rotateSummary ?? true,
          rotateFallbackMsgs: Number.isFinite(prevC0.rotateFallbackMsgs) && prevC0.rotateFallbackMsgs > 0 ? prevC0.rotateFallbackMsgs : 5,
        };
        const next0 = {
          permissionMode: ["workspace-write", "read-only", "danger-full-access"].includes(v.permissionMode) ? v.permissionMode : "workspace-write",
          nodePath: typeof v.nodePath === "string" ? v.nodePath.trim() : "",
          defaultWorkspace: typeof v.defaultWorkspace === "string" ? v.defaultWorkspace.trim() : "",
          maxOutputChars: Number.isFinite(v.maxOutputChars) && v.maxOutputChars > 0 ? v.maxOutputChars : 40000,
          maxSteps: Number.isFinite(v.maxSteps) && v.maxSteps >= 0 ? v.maxSteps : 100,
          subagentMaxDepth: Number.isFinite(v.subagentMaxDepth) && v.subagentMaxDepth > 0 ? v.subagentMaxDepth : 3,
          maxParallelSubagents: Number.isFinite(v.maxParallelSubagents) && v.maxParallelSubagents > 0 ? v.maxParallelSubagents : 5,
          autoCompaction: typeof v.autoCompaction === "boolean" ? v.autoCompaction : true,
          compactionThresholdRatio: Number.isFinite(v.compactionThresholdRatio) && v.compactionThresholdRatio > 0 ? Math.min(1, v.compactionThresholdRatio) : 0.8,
          compactionMaxTokens: Number.isFinite(v.compactionMaxTokens) && v.compactionMaxTokens > 0 ? v.compactionMaxTokens : 8192,
          rotateBytes: Number.isFinite(v.rotateBytes) && v.rotateBytes > 0 ? v.rotateBytes : 10,
          rotateSummary: typeof v.rotateSummary === "boolean" ? v.rotateSummary : true,
          rotateFallbackMsgs: Number.isFinite(v.rotateFallbackMsgs) && v.rotateFallbackMsgs > 0 ? v.rotateFallbackMsgs : 5,
        };
        const keyOp = v.clearKey === true || (typeof v.apiKey === "string" && v.apiKey.trim() !== "");
        if (JSON.stringify(prev0) === JSON.stringify(next0) && !keyOp) {
          vscode.window.setStatusBarMessage(zh ? "✅ 配置无变化，无需保存" : "✅ No changes to save", 3000);
          panel.webview.postMessage({ t: "saved", ok: true, message: zh ? "配置无变化" : "No changes" });
          break;
        }
        // 保存事务开始：扩展侧忽略逐项配置变更事件，等 onSaved 统一处理
        deps.onConfigSaveStart();
        // 保存中提示常显（60s 兜底），保存完成时被成功/失败/无变化提示立即覆盖——
        // 保证"保存并应用"执行全程（含宿主重启，可能数秒）状态栏都有明确反馈
        vscode.window.setStatusBarMessage(zh ? "⏳ 正在保存配置…" : "⏳ Saving settings…", 60000);
        try {
          // 记录保存前生效的宿主运行参数（判断本次保存是否真的改变了需要重启的配置）
          const prevC = deps.readConfig();
          const prevCfg = vscode.workspace.getConfiguration(CONFIG_NS);
          // 两侧都用同一套归一化逻辑，避免"读到的原始值"与"保存后的归一化值"
          // 直接比较产生误判（如 maxSteps 未设置时 prev=undefined vs next=100，
          // 会导致未改动也判定"运行参数变化"而重启宿主）。
          const prev = {
            permissionMode: prevC.permissionMode,
            nodePath: prevC.nodePath,
            defaultWorkspace: prevCfg.get<string>("defaultWorkspace") ?? "",
            maxOutputChars: prevCfg.get<number>("maxOutputChars") ?? 40000,
            maxSteps: Number.isFinite(prevC.maxSteps) && prevC.maxSteps >= 0 ? prevC.maxSteps : 100,
            subagentMaxDepth: Number.isFinite(prevC.subagentMaxDepth) && prevC.subagentMaxDepth > 0 ? prevC.subagentMaxDepth : 3,
            maxParallelSubagents: Number.isFinite(prevC.maxParallelSubagents) && prevC.maxParallelSubagents > 0 ? prevC.maxParallelSubagents : 5,
            autoCompaction: prevC.autoCompaction ?? true,
            compactionThresholdRatio: Number.isFinite(prevC.compactionThresholdRatio) && prevC.compactionThresholdRatio > 0 ? prevC.compactionThresholdRatio : 0.8,
            compactionMaxTokens: Number.isFinite(prevC.compactionMaxTokens) && prevC.compactionMaxTokens > 0 ? prevC.compactionMaxTokens : 8192,
            rotateBytes: Number.isFinite(prevC.rotateBytes) && prevC.rotateBytes > 0 ? prevC.rotateBytes : 10,
            rotateSummary: prevC.rotateSummary ?? true,
            rotateFallbackMsgs: Number.isFinite(prevC.rotateFallbackMsgs) && prevC.rotateFallbackMsgs > 0 ? prevC.rotateFallbackMsgs : 5,
          };
          // 1. API Key：清除 / 写入密钥库（写入时清空设置项，保持"密钥库优先"策略）
          if (v.clearKey) {
            await context.secrets.delete(SECRET_KEY);
          } else if (typeof v.apiKey === "string" && v.apiKey !== "") {
            await context.secrets.store(SECRET_KEY, v.apiKey);
            await vscode.workspace
              .getConfiguration(CONFIG_NS)
              .update("apiKey", "", vscode.ConfigurationTarget.Global);
          }
          // 2. 普通配置项（Global）。model/baseUrl 已归入提供商管理（面板不再发送）——
          // 仅当面板显式提供时才更新，避免"保存运行环境配置"把当前模型重置为默认。
          const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
          if (typeof v.model === "string" && v.model.trim() !== "") {
            await cfg.update("model", v.model.trim(), vscode.ConfigurationTarget.Global);
          }
          if (typeof v.baseUrl === "string") {
            await cfg.update("baseUrl", v.baseUrl.trim(), vscode.ConfigurationTarget.Global);
          }
          await cfg.update(
            "permissionMode",
            ["workspace-write", "read-only", "danger-full-access"].includes(v.permissionMode) ? v.permissionMode : "workspace-write",
            vscode.ConfigurationTarget.Global
          );
          // 运行环境相关参数（nodePath/defaultWorkspace/maxOutputChars）存入**工作区设置**：
          // 跟随项目目录、按环境天然隔离（本地 / Remote 各自读写本机的 .vscode/settings.json），
          // 不受 VS Code 设置同步（Settings Sync）的跨环境污染；无工作区时回退用户设置。
          const runtimeTarget = vscode.workspace.workspaceFolders?.[0]
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
          await cfg.update("nodePath", typeof v.nodePath === "string" ? v.nodePath.trim() : "", runtimeTarget);
          await cfg.update("defaultWorkspace", typeof v.defaultWorkspace === "string" ? v.defaultWorkspace.trim() : "", runtimeTarget);
          await cfg.update(
            "maxOutputChars",
            Number.isFinite(v.maxOutputChars) && v.maxOutputChars > 0 ? v.maxOutputChars : 40000,
            runtimeTarget
          );
          await cfg.update(
            "maxSteps",
            Number.isFinite(v.maxSteps) && v.maxSteps >= 0 ? v.maxSteps : 100,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "subagentMaxDepth",
            Number.isFinite(v.subagentMaxDepth) && v.subagentMaxDepth > 0 ? v.subagentMaxDepth : 3,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "maxParallelSubagents",
            Number.isFinite(v.maxParallelSubagents) && v.maxParallelSubagents > 0 ? v.maxParallelSubagents : 5,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "autoCompaction",
            typeof v.autoCompaction === "boolean" ? v.autoCompaction : true,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "compactionThresholdRatio",
            Number.isFinite(v.compactionThresholdRatio) && v.compactionThresholdRatio > 0 ? Math.min(1, v.compactionThresholdRatio) : 0.8,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "compactionMaxTokens",
            Number.isFinite(v.compactionMaxTokens) && v.compactionMaxTokens > 0 ? v.compactionMaxTokens : 8192,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "rotateBytes",
            Number.isFinite(v.rotateBytes) && v.rotateBytes > 0 ? v.rotateBytes : 10,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "rotateSummary",
            typeof v.rotateSummary === "boolean" ? v.rotateSummary : true,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "rotateFallbackMsgs",
            Number.isFinite(v.rotateFallbackMsgs) && v.rotateFallbackMsgs > 0 ? v.rotateFallbackMsgs : 5,
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "autoApproveRules",
            Array.isArray(v.autoApproveRules)
              ? (v.autoApproveRules as { match?: string; action?: string }[])
                  .filter((r) => r && String(r.match ?? "").trim() !== "")
                  .map((r) => ({ match: String(r.match ?? "").trim(), action: ["allow", "ask", "deny"].includes(String(r.action)) ? String(r.action) : "ask" }))
              : [],
            vscode.ConfigurationTarget.Global
          );
          // 3. 应用：对比保存前后的宿主运行参数——只有确实变化才重启宿主；
          //    提供商配置（经 llm-pi-ai settings 热生效）与无变化的保存都不重启。
          const next = {
            permissionMode: ["workspace-write", "read-only", "danger-full-access"].includes(v.permissionMode) ? v.permissionMode : "workspace-write",
            nodePath: typeof v.nodePath === "string" ? v.nodePath.trim() : "",
            defaultWorkspace: typeof v.defaultWorkspace === "string" ? v.defaultWorkspace.trim() : "",
            maxOutputChars: Number.isFinite(v.maxOutputChars) && v.maxOutputChars > 0 ? v.maxOutputChars : 40000,
            maxSteps: Number.isFinite(v.maxSteps) && v.maxSteps >= 0 ? v.maxSteps : 100,
            subagentMaxDepth: Number.isFinite(v.subagentMaxDepth) && v.subagentMaxDepth > 0 ? v.subagentMaxDepth : 3,
            maxParallelSubagents: Number.isFinite(v.maxParallelSubagents) && v.maxParallelSubagents > 0 ? v.maxParallelSubagents : 5,
            autoCompaction: typeof v.autoCompaction === "boolean" ? v.autoCompaction : true,
            compactionThresholdRatio: Number.isFinite(v.compactionThresholdRatio) && v.compactionThresholdRatio > 0 ? Math.min(1, v.compactionThresholdRatio) : 0.8,
            compactionMaxTokens: Number.isFinite(v.compactionMaxTokens) && v.compactionMaxTokens > 0 ? v.compactionMaxTokens : 8192,
            rotateBytes: Number.isFinite(v.rotateBytes) && v.rotateBytes > 0 ? v.rotateBytes : 10,
            rotateSummary: typeof v.rotateSummary === "boolean" ? v.rotateSummary : true,
            rotateFallbackMsgs: Number.isFinite(v.rotateFallbackMsgs) && v.rotateFallbackMsgs > 0 ? v.rotateFallbackMsgs : 5,
          };
          const hostChanged = JSON.stringify(prev) !== JSON.stringify(next);
          deps.onSaved(hostChanged);
          // 保存结果提示显示在 VS Code 状态栏（非阻塞，几秒后自动消失）
          vscode.window.setStatusBarMessage(
            zh ? "✅ 配置已保存，将在下次使用时生效" : "✅ Settings saved; effective on next use",
            5000
          );
          panel.webview.postMessage({
            t: "saved",
            ok: true,
            message: zh ? "配置已保存，将在下次使用时生效" : "Settings saved; effective on next use",
          });
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
        // 权限审批：前端为权威，整体写回工具级规则列表 {match, action}
        const raw = (msg as { rules?: unknown }).rules;
        const rules = Array.isArray(raw)
          ? raw
              .filter((r): r is { match?: string; action?: string } => Boolean(r) && typeof r === "object")
              .map((r) => ({ match: String(r.match ?? "").trim(), action: ["allow", "ask", "deny"].includes(String(r.action)) ? String(r.action) : "ask" }))
              .filter((r) => r.match && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.match))
          : [];
        await vscode.workspace.getConfiguration(CONFIG_NS).update("autoApproveRules", rules, vscode.ConfigurationTarget.Global);
        await sendConfig();
        break;
      }
      case "applyPermission": {
        // 权限审批"立即应用"：重启宿主使最新规则生效（规则本身已按条单独保存，不在此重复保存）
        deps.onSaved(true);
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
    rotateBytes: zh ? "会话轮转阈值（MB）" : "Session rotation threshold (MB)",
    rotateBytesHint: zh ? "会话日志超过该大小（MB）时自动轮转，创建新会话继续（默认 10）" : "Rotate when the session log exceeds this size (MB); a new session continues (default 10)",
    rotateSummary: zh ? "轮转时生成对话摘要" : "Summarize conversation on rotation",
    rotateSummaryHint: zh ? "开启后用 LLM 对最近对话生成摘要注入新会话；关闭则直接转移最近消息原文" : "When on, an LLM summarizes the recent conversation into the new session; when off, recent messages are copied verbatim",
    rotateSummaryOn: zh ? "开" : "On",
    rotateSummaryOff: zh ? "关" : "Off",
    rotateFallbackMsgs: zh ? "摘要失败时保留的消息条数" : "Messages kept when summarization fails",
    rotateFallbackMsgsHint: zh ? "LLM 摘要不可用时，从倒数第 N 条用户输入起保留对话原文（默认 5）" : "When the LLM summary fails, keep conversation from the Nth-last user input (default 5)",
    saveLog: zh ? "保存并应用" : "Save & Apply",
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
    groupPermission: zh ? "权限审批" : "Approval",
    permissionHint: zh ? "自动授权规则：命中的工具调用按所选动作处理——允许 = 自动放行，不再弹审批框；询问 = 仍会弹框请您确认；拒绝 = 直接拒绝。仅对命中的工具生效，其余调用照常审批。" : "Auto-approval rules: a matched tool call follows the selected action — Allow = auto-approved without prompting; Ask = still prompts for your confirmation; Deny = rejected outright. Only matched tools are affected; others keep normal approval.",
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
    save: zh ? "保存并应用" : "Save & Apply",
    groupUpgrade: zh ? "版本升级" : "Upgrades",
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
    <button type="button" class="cfg-nav" data-group="upgrade">${L.groupUpgrade}</button>
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

<div class="cfg-footer">
  <div class="actions">
    <button type="button" class="primary" id="cfgSave">${L.save}</button>
  </div>
</div>

<script src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
