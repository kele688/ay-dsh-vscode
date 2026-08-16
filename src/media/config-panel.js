/**
 * config-panel.js — DSH 完整配置面板前端（无框架）。
 * 与 src/configPanel.ts 配对：init 拉取当前配置 → 表单编辑 → save 保存并应用。
 * 消息协议（postMessage）：
 *   panel -> ext: {t:"init"} | {t:"save", values} | {t:"pickFolder", field} | {t:"cancel"}
 *   ext -> panel: {t:"config", config} | {t:"folder", field, path} | {t:"saved", ok, message}
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // 语言由服务端渲染时写入 <body data-locale>（CSP 禁止内联脚本，不能用行内变量）
  const zh = document.body.dataset.locale === "zh";
  const L = {
    title: zh ? "DSH 配置" : "DSH Settings",
    apiKey: zh ? "API Key（DeepSeek）" : "API Key (DeepSeek)",
    apiKeyPlaceholder: zh ? "粘贴 API Key；留空表示保持不变" : "Paste API Key; leave empty to keep current",
    keyConfigured: zh ? "✓ 已配置（存储于 VS Code 密钥库）" : "✓ Configured (stored in VS Code secret store)",
    keyNotConfigured: zh ? "✗ 未配置" : "✗ Not configured",
    clearKey: zh ? "清除已保存的 API Key" : "Clear saved API Key",
    model: zh ? "模型" : "Model",
    modelHint: zh ? "可输入任意模型 id（如 deepseek-v4-pro）" : "Any model id works (e.g. deepseek-v4-pro)",
    baseUrl: zh ? "Base URL（可选）" : "Base URL (optional)",
    baseUrlPlaceholder: zh ? "留空使用 DeepSeek 官方 API" : "Leave empty for the official DeepSeek API",
    permission: zh ? "权限模式" : "Permission mode",
    pWorkspace: zh ? "workspace-write — 可写工作区，越界操作弹审批（推荐）" : "workspace-write — write workspace, out-of-scope ops ask approval (recommended)",
    pReadonly: zh ? "read-only — 只读，Agent 不能修改任何文件" : "read-only — agent cannot modify any file",
    pFull: zh ? "danger-full-access — 完全访问，不再审批（谨慎）" : "danger-full-access — full access, no approvals (use with care)",
    nodePath: zh ? "Node 可执行文件路径（可选）" : "Node executable path (optional)",
    nodePathHint: zh ? "留空自动探测（系统 node ≥20，回退 VS Code 内置 Node）" : "Leave empty for auto-detect (system node ≥20, fallback VS Code's Node)",
    browse: zh ? "浏览…" : "Browse…",
    workspace: zh ? "默认工作目录（未打开文件夹时）" : "Default working directory (when no folder is open)",
    workspaceHint: zh ? "Agent 生成的文件保存位置；留空使用 ~/ay-dsh-workspace" : "Where agent files are saved; empty uses ~/ay-dsh-workspace",
    maxOutput: zh ? "最大输出字符数（UI 渲染折叠阈值）" : "Max output chars (UI render fold threshold)",
    maxSteps: zh ? "最大思考轮次（0 = 不限制）" : "Max thinking steps (0 = unlimited)",
    subagentDepth: zh ? "子代理递归深度上限" : "Subagent recursion depth limit",
    maxParallel: zh ? "并行子代理数量上限" : "Max parallel subagents",
    cwd: zh ? "当前工作目录" : "Current working directory",
    save: zh ? "保存并应用" : "Save & Apply",
    cancel: zh ? "取消" : "Cancel",
    saved: zh ? "✓ 配置已保存，将在下次使用时生效" : "✓ Settings saved; they take effect on next use",
    saveFailed: zh ? "保存失败：" : "Save failed: ",
    saving: zh ? "保存中…" : "Saving…",
    statusError: zh ? "状态" : "Status",
  };

  const fields = {
    apiKey: $("cfgApiKey"),
    clearKey: $("cfgClearKey"),
    provider: $("cfgProvider"),
    model: $("cfgModel"),
    modelPresets: $("modelPresets"),
    baseUrl: $("cfgBaseUrl"),
    permissionMode: $("cfgPermissionMode"),
    nodePath: $("cfgNodePath"),
    defaultWorkspace: $("cfgDefaultWorkspace"),
    maxOutputChars: $("cfgMaxOutputChars"),
    maxSteps: $("cfgMaxSteps"),
    subagentMaxDepth: $("cfgSubagentDepth"),
    maxParallelSubagents: $("cfgMaxParallel"),
  };
  const statusEl = $("cfgStatus");
  const saveBtn = $("cfgSave");
  const cwdEl = $("cfgCwd");
  const keyNoteEl = $("cfgKeyNote");

  /** 当前 Base URL 是否仍是提供商默认值（自动填充的标志，避免覆盖用户手改）。 */
  let baseUrlIsDefault = true;
  /** 当前提供商预设列表（init 时注入）。 */
  let providers = [];

  function fillProviders(list) {
    providers = Array.isArray(list) ? list : [];
    const fallback = [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", models: [] }];
    const merged = providers.length > 0 ? providers : fallback;
    fields.provider.innerHTML = "";
    for (const p of merged) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      fields.provider.appendChild(opt);
    }
    // 按已保存的 Base URL 反推提供商（匹配默认地址则选中之），否则默认第一项
    const b = (fields.baseUrl.value || "").trim().toLowerCase().replace(/\/+$/, "");
    const matched = merged.find((p) => p.baseUrl && b.startsWith(p.baseUrl.toLowerCase().replace(/\/+$/, "")));
    fields.provider.value = matched ? matched.id : (merged[0]?.id || "deepseek");
    applyProviderPreset(true);
  }

  /** 提供商切换联动：自动填充默认 Base URL（未手改时）、更新模型候选。 */
  function applyProviderPreset(initial) {
    const p = providers.find((x) => x.id === fields.provider.value);
    if (!p) return;
    if (initial || !fields.baseUrl.value.trim() || baseUrlIsDefault) {
      fields.baseUrl.value = p.baseUrl || "";
      baseUrlIsDefault = true;
    }
    const models = Array.isArray(p.models) ? p.models : [];
    fields.modelPresets.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      fields.modelPresets.appendChild(opt);
    }
  }

  fields.provider.addEventListener("change", () => applyProviderPreset(false));
  // 用户手改 Base URL 后，不再自动覆盖（除非再次切换提供商）
  fields.baseUrl.addEventListener("input", () => {
    const p = providers.find((x) => x.id === fields.provider.value);
    baseUrlIsDefault = Boolean(p && fields.baseUrl.value.trim() === (p.baseUrl || ""));
  });

  $("cfgPickWorkspace").addEventListener("click", () => vscode.postMessage({ t: "pickFolder", field: "defaultWorkspace" }));
  $("cfgPickNode").addEventListener("click", () => vscode.postMessage({ t: "pickFolder", field: "nodePath" }));

  saveBtn.addEventListener("click", () => {
    const model = fields.model.value.trim();
    if (!model) {
      setStatus(L.saveFailed + (zh ? "模型不能为空" : "model must not be empty"), true);
      return;
    }
    saveBtn.disabled = true;
    setStatus(L.saving, false);
    vscode.postMessage({
      t: "save",
      values: {
        clearKey: fields.clearKey.checked,
        apiKey: fields.apiKey.value.trim() || undefined,
        model,
        baseUrl: fields.baseUrl.value.trim(),
        permissionMode: fields.permissionMode.value,
        nodePath: fields.nodePath.value.trim(),
        defaultWorkspace: fields.defaultWorkspace.value.trim(),
        maxOutputChars: parseInt(fields.maxOutputChars.value, 10) || 40000,
        maxSteps: parseInt(fields.maxSteps.value, 10) || 0,
        subagentMaxDepth: parseInt(fields.subagentMaxDepth.value, 10) || 3,
        maxParallelSubagents: parseInt(fields.maxParallelSubagents.value, 10) || 5,
      },
    });
  });

  $("cfgCancel").addEventListener("click", () => vscode.postMessage({ t: "cancel" }));

  // 清空 API Key 时禁用输入框（避免歧义）
  fields.clearKey.addEventListener("change", () => {
    fields.apiKey.disabled = fields.clearKey.checked;
    if (fields.clearKey.checked) fields.apiKey.value = "";
  });

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
    statusEl.classList.toggle("ok", !isError);
  }

  function fill(c) {
    fields.apiKey.placeholder = c.keyConfigured ? L.keyConfigured : L.keyNotConfigured;
    keyNoteEl.textContent = c.keyConfigured ? L.keyConfigured : L.keyNotConfigured;
    keyNoteEl.classList.toggle("configured", c.keyConfigured);
    fields.baseUrl.value = c.baseUrl || "";
    fields.model.value = c.model || "";
    fields.permissionMode.value = c.permissionMode || "workspace-write";
    fields.nodePath.value = c.nodePath || "";
    fields.defaultWorkspace.value = c.defaultWorkspace || "";
    fields.maxOutputChars.value = String(c.maxOutputChars || 40000);
    fields.maxSteps.value = String(c.maxSteps ?? 100);
    fields.subagentMaxDepth.value = String(c.subagentMaxDepth ?? 3);
    fields.maxParallelSubagents.value = String(c.maxParallelSubagents ?? 5);
    cwdEl.value = c.cwd || "";
    saveBtn.disabled = false;
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    switch (msg.t) {
      case "config":
        fill(msg.config);
        fillProviders(msg.providers); // 依赖 baseUrl 已填充（反推选中项）
        break;
      case "folder":
        if (msg.path) {
          if (msg.field === "defaultWorkspace") fields.defaultWorkspace.value = msg.path;
          else fields.nodePath.value = msg.path;
        }
        break;
      case "saved":
        saveBtn.disabled = false;
        // 保存结果提示由扩展显示在 VS Code 状态栏（setStatusBarMessage，见
        // configPanel.ts）；面板内仅显示表单状态文字，**不自动关闭**——
        // 由用户自行点击"取消"或关闭面板（保存成功后也可继续调整再保存）。
        if (msg.ok) {
          setStatus(L.saved, false);
        } else {
          setStatus(L.saveFailed + (msg.message || "unknown error"), true);
        }
        break;
    }
  });

  vscode.postMessage({ t: "init" });
})();
