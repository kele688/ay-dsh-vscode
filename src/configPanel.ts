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

/** 配置命名空间（与 extension.ts 的 CONFIG_NS 一致）。 */
const CONFIG_NS = "dshVscode";
const SECRET_KEY = "dshVscode.apiKey";

/**
 * 提供商预设列表（现状：由项目事先配置）。
 * 将来支持动态添加 provider 配置时，由此常量扩展/替换（或从宿主 modelInfo 拉取）。
 * 选择提供商会联动：自动填充其默认 Base URL、更新模型候选列表。
 */
const PROVIDER_PRESETS: { id: string; name: string; baseUrl: string; models: string[] }[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "ollama",
    name: "Ollama（本地）",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.1", "qwen2.5"],
  },
];

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
  /** 保存成功后回调：锁定 UI + 按新配置重启宿主 + 刷新聊天视图。 */
  onSaved: () => void;
}

let activePanel: vscode.WebviewPanel | undefined;

export function openConfigPanel(context: vscode.ExtensionContext, deps: ConfigPanelDeps): void {
  if (activePanel) {
    activePanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "dshVscode.configPanel",
    "DSH — 配置",
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
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "config-panel.js"));
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "config-panel.css"));
  panel.webview.html = renderHtml(panel.webview, scriptUri, styleUri, zh);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.t) {
      case "init": {
        const c = deps.readConfig();
        const secretKey = await context.secrets.get(SECRET_KEY);
        const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
        panel.webview.postMessage({
          t: "config",
          config: {
            keyConfigured: Boolean(c.apiKey ?? secretKey),
            model: c.model,
            baseUrl: c.baseUrl ?? "",
            permissionMode: c.permissionMode,
            nodePath: c.nodePath,
            defaultWorkspace: cfg.get<string>("defaultWorkspace") ?? "",
            maxOutputChars: cfg.get<number>("maxOutputChars") ?? 40000,
            maxSteps: cfg.get<number>("maxSteps") ?? 100,
            subagentMaxDepth: cfg.get<number>("subagentMaxDepth") ?? 3,
            maxParallelSubagents: cfg.get<number>("maxParallelSubagents") ?? 5,
            cwd: deps.workspaceRoot(),
          },
          providers: PROVIDER_PRESETS,
        });
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
      case "save": {
        const v = msg.values ?? {};
        // 保存事务开始：扩展侧忽略逐项配置变更事件，等 onSaved 统一处理
        deps.onConfigSaveStart();
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
          // 2. 普通配置项（Global）
          const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
          const model = typeof v.model === "string" && v.model.trim() !== "" ? v.model.trim() : "deepseek-v4-flash";
          await cfg.update("model", model, vscode.ConfigurationTarget.Global);
          await cfg.update("baseUrl", typeof v.baseUrl === "string" ? v.baseUrl.trim() : "", vscode.ConfigurationTarget.Global);
          await cfg.update(
            "permissionMode",
            ["workspace-write", "read-only", "danger-full-access"].includes(v.permissionMode) ? v.permissionMode : "workspace-write",
            vscode.ConfigurationTarget.Global
          );
          await cfg.update("nodePath", typeof v.nodePath === "string" ? v.nodePath.trim() : "", vscode.ConfigurationTarget.Global);
          await cfg.update("defaultWorkspace", typeof v.defaultWorkspace === "string" ? v.defaultWorkspace.trim() : "", vscode.ConfigurationTarget.Global);
          await cfg.update(
            "maxOutputChars",
            Number.isFinite(v.maxOutputChars) && v.maxOutputChars > 0 ? v.maxOutputChars : 40000,
            vscode.ConfigurationTarget.Global
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
          // 3. 应用：所有配置项已写入完成（事务结束点）——由扩展统一按新配置重启宿主
          deps.onSaved();
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
      case "cancel":
        panel.dispose();
        break;
    }
  });
}

function renderHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri, zh: boolean): string {
  const L = {
    title: zh ? "DSH 配置" : "DSH Settings",
    groupModel: zh ? "模型配置" : "Model",
    groupRuntime: zh ? "运行环境" : "Runtime",
    groupControl: zh ? "控制参数" : "Control",
    provider: zh ? "提供商（Provider）" : "Provider",
    providerHint: zh ? "选择提供商后自动填充其默认 API 地址与模型候选" : "Picking a provider fills its default API endpoint and model list",
    baseUrl: zh ? "Base URL" : "Base URL",
    baseUrlHint: zh ? "留空时使用提供商默认 API 地址" : "Leave empty to use the provider's default API endpoint",
    model: zh ? "模型" : "Model",
    modelHint: zh ? "模型提供商的候选列表；也可输入任意模型 id" : "Models from the provider; any model id can be typed",
    apiKey: zh ? "API Key" : "API Key",
    apiKeyPlaceholder: zh ? "粘贴 API Key；留空表示保持不变" : "Paste API Key; leave empty to keep current",
    clearKey: zh ? "清除已保存的 API Key" : "Clear saved API Key",
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
    browse: zh ? "浏览…" : "Browse…",
    save: zh ? "保存并应用" : "Save & Apply",
    cancel: zh ? "取消" : "Cancel",
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

<h2 class="section-title">${L.groupModel}</h2>

<div class="field">
  <label for="cfgProvider">${L.provider}</label>
  <select id="cfgProvider"></select>
  <span class="hint">${L.providerHint}</span>
</div>

<div class="field">
  <label for="cfgBaseUrl">${L.baseUrl}</label>
  <input type="text" id="cfgBaseUrl" placeholder="https://api.deepseek.com" spellcheck="false">
  <span class="hint">${L.baseUrlHint}</span>
</div>

<div class="field">
  <label for="cfgModel">${L.model}</label>
  <input type="text" id="cfgModel" list="modelPresets" placeholder="deepseek-v4-flash" spellcheck="false">
  <datalist id="modelPresets"></datalist>
  <span class="hint">${L.modelHint}</span>
</div>

<div class="field">
  <label for="cfgApiKey">${L.apiKey}</label>
  <div class="row">
    <input type="password" id="cfgApiKey" placeholder="${L.apiKeyPlaceholder}" autocomplete="off" spellcheck="false">
  </div>
  <div class="key-note" id="cfgKeyNote"></div>
  <label class="checkbox-row">
    <input type="checkbox" id="cfgClearKey">
    <span>${L.clearKey}</span>
  </label>
</div>

<h2 class="section-title">${L.groupRuntime}</h2>

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
  <input type="text" id="cfgCwd" readonly spellcheck="false">
</div>

<div class="field">
  <label for="cfgNodePath">${L.nodePath}</label>
  <div class="row">
    <input type="text" id="cfgNodePath" placeholder="C:\\Program Files\\nodejs\\node.exe" spellcheck="false">
    <button type="button" class="secondary" id="cfgPickNode">${L.browse}</button>
  </div>
  <span class="hint">${L.nodePathHint}</span>
</div>

<h2 class="section-title">${L.groupControl}</h2>

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

<div class="actions">
  <button type="button" class="primary" id="cfgSave">${L.save}</button>
  <button type="button" class="secondary" id="cfgCancel">${L.cancel}</button>
</div>
<div id="cfgStatus"></div>

<script src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
