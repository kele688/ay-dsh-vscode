/**
 * config-panel.js — DSH 完整配置面板前端（无框架）。
 * 与 src/configPanel.ts 配对：init 拉取当前配置 → 表单编辑 → save 保存并应用。
 * 消息协议（postMessage）：
 *   panel -> ext: {t:"init"} | {t:"save", values} | {t:"pickFolder", field} | {t:"cancel"}
 *                  | {t:"providerSave", provider, apiKey} | {t:"providerDelete", id}
 *                  | {t:"fetchModels", baseUrl, apiKey}
 *   ext -> panel: {t:"config", config, providers} | {t:"folder", field, path}
 *                  | {t:"saved", ok, message} | {t:"models", models, error?}
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // 语言由服务端渲染时写入 <body data-locale>（CSP 禁止内联脚本，不能用行内变量）
  const zh = document.body.dataset.locale === "zh";
  const L = {
    title: zh ? "DSH 配置" : "DSH Settings",
    addProvider: zh ? "＋ 添加提供商" : "+ Add provider",
    addCustomProvider: zh ? "＋ 自定义提供商" : "+ Custom provider",
    edit: zh ? "编辑" : "Edit",
    remove: zh ? "删除" : "Remove",
    noProviders: zh ? "尚未接入任何提供商" : "No providers connected yet",
    providerName: zh ? "提供商名称" : "Provider name",
    providerId: zh ? "Provider ID" : "Provider ID",
    providerIdHint: zh ? "从 DSH 模型路由目录选择；查询不到的选「自定义」" : "Pick from the DSH model routing catalog; choose Custom if absent",
    customProvider: zh ? "（自定义…）" : "(Custom…)",
    protocol: zh ? "API 协议" : "API protocol",
    protocolCompletions: zh ? "OpenAI Completions" : "OpenAI Completions",
    protocolResponses: zh ? "OpenAI Responses" : "OpenAI Responses",
    protocolAnthropic: zh ? "Anthropic Messages" : "Anthropic Messages",
    configureModels: zh ? "配置模型" : "Configure models",
    modelId: zh ? "模型 ID" : "Model ID",
    modelDisplayName: zh ? "显示名称" : "Display name",
    contextWindow: zh ? "上下文窗口" : "Context window",
    modalities: zh ? "模态能力" : "Modalities",
    modText: zh ? "纯文本（text）" : "Text only",
    modTextImage: zh ? "文本 + 图片（text, image）" : "Text + image",
    modReadonly: zh ? "知名模型模态能力由系统确定（只读）" : "Modality is provided by the vendor (read-only)",
    maxOut: zh ? "最大输出" : "Max output",
    modelEditTitle: zh ? "编辑模型" : "Edit model",
    tokenSizePlaceholder: zh ? "纯数字 或 带单位，如 200k / 256K / 1m" : "Plain number or unit suffix, e.g. 200k / 256K / 1m",
    tokenSizeInvalid: zh ? "格式无效：请输入纯数字或带单位（如 200k / 256K / 1m）" : "Invalid format: use a plain number or unit suffix (e.g. 200k / 256K / 1m)",
    tokenSizeTooSmall: zh ? "不能小于 1k（1k = 1024）：200k = 204800，1m = 1048576" : "Must be at least 1k (1k = 1024): 200k = 204800, 1m = 1048576",
    modelIdRequired: zh ? "模型 ID 不能为空" : "Model ID is required",
    modelNameRequired: zh ? "模型名称不能为空" : "Model name is required",
    modelIdDuplicate: zh ? "该模型 ID 已在本提供商中存在" : "This model ID already exists in this provider",
    modelNameDuplicate: zh ? "该模型名称已在本提供商中存在" : "This model name already exists in this provider",
    manualModelsHint: zh ? "自定义提供商：请点击「添加模型」按钮配置要调用的模型" : "Custom provider: click Add model to configure the models to use",
    optional: zh ? "可选" : "optional",
    baseUrl: zh ? "Base URL" : "Base URL",
    apiKeyFor: zh ? "API Key（可选）" : "API Key (optional)",
    apiKeyPlaceholder: zh ? "填入合法 API Key 后即可查询模型" : "Enter a valid API Key to fetch models",
    modelsList: zh ? "模型列表（勾选允许使用的模型）" : "Models (check the ones to enable)",
    chooseModels: zh ? "选择模型" : "Choose models",
    modelsEmpty: zh ? "（点击上方按钮查询该提供商的模型）" : "(click the button above to fetch models)",
    fetching: zh ? "查询中…" : "Fetching…",
    fetchFailed: zh ? "模型查询失败：" : "Failed to fetch models: ",
    loading: zh ? "加载中" : "Loading",
    defaultBtn: zh ? "默认" : "Default",
    addModel: zh ? "添加模型" : "Add model",
    saveProvider: zh ? "保存" : "Save",
    workspace: zh ? "默认工作目录（未打开文件夹时）" : "Default working directory (when no folder is open)",
    workspaceHint: zh ? "Agent 生成的文件保存位置；留空使用 ~/ay-dsh-workspace" : "Where agent files are saved; empty uses ~/ay-dsh-workspace",
    cwd: zh ? "当前工作目录" : "Current working directory",
    nodePath: zh ? "Node 可执行文件路径（可选）" : "Node executable path (optional)",
    nodePathHint: zh ? "留空自动探测（系统 node ≥20，回退 VS Code 内置 Node）" : "Leave empty for auto-detect (system node ≥20, fallback VS Code's Node)",
    browse: zh ? "浏览…" : "Browse…",
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
    autoCompactionOn: zh ? "自动" : "Auto",
    autoCompactionOff: zh ? "手动" : "Manual",
    permissionMatch: zh ? "工具名" : "Tool",
    permissionAction: zh ? "动作" : "Action",
    permissionActionAllow: zh ? "允许" : "Allow",
    permissionActionAsk: zh ? "询问" : "Ask",
    permissionActionDeny: zh ? "拒绝" : "Deny",
    permissionAdd: zh ? "＋ 添加规则" : "+ Add rule",
    permissionRemove: zh ? "删除" : "Delete",
    permissionEmpty: zh ? "（暂无规则；使用内置默认：glob / grep / read / find 自动允许）" : "(no rules; built-in defaults: glob / grep / read / find allowed)",
    permissionCommandRejected: zh ? "该配置不被接受：DSH 内核暂未提供具体命令参数，仅支持工具级（如 glob / grep / read），不支持带参数命令甄别" : "Rejected: command-level rules are unsupported (the DSH kernel does not expose command args). Use tool-level matches only (e.g. glob / grep / read)",
    permissionSave: zh ? "保存" : "Save",
    permissionCancel: zh ? "取消" : "Cancel",
    permissionApplyNow: zh ? "立即应用" : "Apply now",
    permissionTitle: zh ? "提示" : "Notice",
    permissionOk: zh ? "确定" : "OK",
    permissionEmptyName: zh ? "工具名不能为空" : "Tool name must not be empty",
    permissionInvalidName: zh ? "请输入合法命令行（不带参数）" : "Enter a valid command (without arguments)",
    compactThreshold: zh ? "自动压缩触发比例" : "Auto-compaction threshold ratio",
    compactThresholdHint: zh ? "上下文用到窗口的多少比例时触发压缩（10% ~ 100%，默认 80%）" : "Compact when context reaches this share of the window (10%–100%, default 80%)",
    compactMaxTokens: zh ? "压缩摘要 token 上限" : "Compaction summary token cap",
    compactMaxTokensHint: zh ? "一次压缩生成的摘要最大 token 数（默认 8192）" : "Max tokens in one compaction summary (default 8192)",
    save: zh ? "保存并应用" : "Save & Apply",
    cancel: zh ? "取消" : "Cancel",
    saved: zh ? "✓ 配置已保存，将在下次使用时生效" : "✓ Settings saved; they take effect on next use",
    apiKeySet: zh ? "API Key 已配置" : "API Key configured",
    apiKeySetHint: zh ? "API Key 已配置；留空保持不变" : "API Key is set; leave empty to keep it",
    confirmDelete: zh ? "确认删除" : "Confirm delete",
    confirmDeleteProvider: zh ? "将删除该提供商，此操作不可撤销" : "This provider will be removed; this cannot be undone",
    confirmDeleteModel: zh ? "将删除该模型，此操作不可撤销" : "This model will be removed; this cannot be undone",
    addProviderTitle: zh ? "添加提供商" : "Add provider",
    addCustomProviderTitle: zh ? "自定义提供商" : "Custom provider",
    customMarkTitle: zh ? "自定义提供商：可编辑名称与模型列表" : "Custom provider: name and model list are editable",
    customListNote: zh ? "* = 自定义提供商（可编辑名称与模型列表）" : "* = custom provider (editable name & model list)",
    saveFailed: zh ? "保存失败：" : "Save failed: ",
    saving: zh ? "保存中…" : "Saving…",
    refresh: zh ? "重新查询" : "Re-check",
    reset: zh ? "重置" : "Reset",
    update: zh ? "更新" : "Update",
    querying: zh ? "查询中…" : "Querying…",
    queryFailed: zh ? "查询失败：" : "Query failed: ",
    noNewer: zh ? "（没有比当前更高的版本）" : "(no newer version)",
    dshResetConfirm: zh ? "确认要回退到插件包原始版本" : "Reset DSH core back to the bundled version",
    dshUpgradeConfirm: zh ? "将 DSH 核心升级到" : "Upgrade DSH core to",
    pluginUpgradeConfirm: zh ? "将 AY-DSH 升级到" : "Upgrade AY-DSH to",
    versionQ: zh ? "版本？" : " version?",
    selectVersionFirst: zh ? "请先选择版本" : "Select a version first",
    notesPlaceholder: zh ? "（选择版本后在此显示 Release Notes）" : "(Release notes appear here after selecting a version)",
  };

  const fields = {
    permissionMode: $("cfgPermissionMode"),
    nodePath: $("cfgNodePath"),
    defaultWorkspace: $("cfgDefaultWorkspace"),
    maxOutputChars: $("cfgMaxOutputChars"),
    maxSteps: $("cfgMaxSteps"),
    subagentMaxDepth: $("cfgSubagentDepth"),
    maxParallelSubagents: $("cfgMaxParallel"),
    autoCompaction: $("cfgAutoCompaction"),
    compactionThresholdRatio: $("cfgCompactThreshold"),
    compactionMaxTokens: $("cfgCompactMaxTokens"),
  };
  // 自动压缩开关旁的"自动/手动"状态随勾选框实时切换
  const autoCompactionState = $("cfgAutoCompactionState");
  const updateAutoCompactionState = () => {
    if (autoCompactionState) {
      autoCompactionState.textContent = fields.autoCompaction.checked ? L.autoCompactionOn : L.autoCompactionOff;
    }
  };
  fields.autoCompaction.addEventListener("change", updateAutoCompactionState);

  // ---- 权限审批组：工具级自动授权规则（Kilo Code 风格）----
  const permissionRulesEl = $("permissionRules");
  const addPermissionBtn = $("cfgAddPermission");
  // 内置默认白名单（工具级只读）：无配置时作为示例展示，用户可删除
  const DEFAULT_PERMISSION_RULES = [
    { match: "glob", action: "allow" },
    { match: "grep", action: "allow" },
    { match: "read", action: "allow" },
    { match: "find", action: "allow" },
  ];
  // 工具名合法性：仅字母/数字开头，允许点/下划线/连字符（命令行 token，拒绝中文/空格/特殊字符）
  const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  function validateToolName(name) {
    const v = String(name ?? "").trim();
    // 校验不合格统一提示：请输入合法命令行（不带参数）
    if (!v) return L.permissionInvalidName;
    if (!TOOL_NAME_RE.test(v)) return L.permissionInvalidName;
    return "";
  }
  // 校验/限制提示：用配置面板 modal 弹框（webview 禁用 alert；不使用对话区红条）
  function showPermissionError(text) {
    const esc = (s) => String(s ?? "").replace(/"/g, "&quot;");
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal confirm-modal">
        <h3>${esc(L.permissionTitle)}</h3>
        <p class="confirm-text">${esc(text)}</p>
        <div class="row" style="justify-content:flex-end">
          <button type="button" class="primary" id="perrOk">${esc(L.permissionOk)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("#perrOk").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }
  let permissionRules = []; // [{ match, action, saved, dirty, baseMatch, baseAction }]
  /** 把当前全部有效规则整体写回 settings（前端为权威，避免单条保存丢失其它规则）。 */
  function persistPermissionRules() {
    const rules = permissionRules
      .filter((r) => r.match && r.match.trim() !== "" && TOOL_NAME_RE.test(r.match.trim()))
      .map((r) => ({ match: r.match.trim(), action: r.action }));
    vscode.postMessage({ t: "savePermission", rules });
  }
  function renderPermissionRules() {
    if (!permissionRulesEl) return;
    permissionRulesEl.innerHTML = "";
    if (permissionRules.length === 0) {
      permissionRulesEl.innerHTML = `<span class="hint">${L.permissionEmpty}</span>`;
      return;
    }
    permissionRules.forEach((rule, i) => {
      const row = document.createElement("div");
      row.className = "permission-rule-row";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = rule.match || "";
      inp.placeholder = "glob";
      inp.spellcheck = false;
      inp.readOnly = rule.saved; // 已配置的规则工具名只读
      inp.addEventListener("input", () => {
        rule.match = inp.value;
        rule.dirty = true;
      });
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="allow">${L.permissionActionAllow}</option><option value="ask">${L.permissionActionAsk}</option><option value="deny">${L.permissionActionDeny}</option>`;
      sel.value = ["allow", "ask", "deny"].includes(rule.action) ? rule.action : "ask";
      sel.addEventListener("change", () => {
        rule.action = sel.value;
        rule.dirty = true;
        renderPermissionRules(); // 有变化：显示"保存/取消"
      });
      // 保存：整体写回（含该条）；取消：已配置恢复原值 / 新增则放弃该行
      const save = document.createElement("button");
      save.type = "button";
      save.className = "secondary";
      save.textContent = L.permissionSave;
      save.addEventListener("click", () => {
        const err = validateToolName(rule.match);
        if (err) { showPermissionError(err); return; }
        persistPermissionRules();
        rule.saved = true;
        rule.dirty = false;
        rule.baseMatch = rule.match.trim();
        rule.baseAction = rule.action;
        renderPermissionRules();
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = L.permissionCancel;
      cancel.addEventListener("click", () => {
        if (rule.saved) {
          rule.match = rule.baseMatch;
          rule.action = rule.baseAction;
          rule.dirty = false;
        } else {
          permissionRules.splice(i, 1);
        }
        renderPermissionRules();
      });
      // 删除：移除该行并立即同步写回（明确"删除"，非取消）
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "secondary";
      rm.textContent = L.permissionRemove;
      rm.addEventListener("click", () => {
        permissionRules.splice(i, 1);
        persistPermissionRules();
        renderPermissionRules();
      });
      row.append(inp, sel, ...(rule.dirty ? [save, cancel] : []), rm);
      permissionRulesEl.appendChild(row);
    });
  }
  if (addPermissionBtn) {
    addPermissionBtn.addEventListener("click", () => {
      permissionRules.push({ match: "", action: "allow", saved: false, dirty: true, baseMatch: "", baseAction: "allow" });
      renderPermissionRules();
    });
  }

  const saveBtn = $("cfgSave");
  const cwdEl = $("cfgCwd");

  /** 知名供应商的公开 API 地址（选择供应商/「默认」按钮使用；DSH 目录不提供 baseUrl）。 */
  const PROVIDER_DEFAULT_BASEURL = {
    deepseek: "https://api.deepseek.com",
    "deepseek-official": "https://api.deepseek.com",
    ollama: "http://localhost:11434/v1",
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    groq: "https://api.groq.com/openai/v1",
    mistral: "https://api.mistral.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    xai: "https://api.x.ai/v1",
    cerebras: "https://api.cerebras.ai/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    together: "https://api.together.xyz/v1",
  };
  /** 上次自动填入的 Base URL（用于判断用户是否手改过；切换供应商只在默认值域内更新）。 */
  let lastAutoBaseUrl = "";
  /** 目录携带的公开 baseUrl（DSH 目录优先于手写表）。 */
  let catalogBaseUrlMap = {};
  /** 目录携带的提供商显示名（id -> 名称；选中 provider 后填入「提供商名称」字段）。 */
  let catalogNameMap = {};
  /** 按选中供应商填入默认 Base URL：输入框为空或仍为上次自动值时更新，手改值保留。 */
  function applyDefaultBaseUrl(pid) {
    const input = $("pfBaseUrl");
    if (!input) return;
    const v = input.value.trim();
    if (v === "" || v === lastAutoBaseUrl) {
      input.value = catalogBaseUrlMap[pid] || PROVIDER_DEFAULT_BASEURL[pid] || "";
      lastAutoBaseUrl = input.value;
    }
  }
  /** 知名模式名称：直接用目录查到的名称（查不到则用 id 全称，防止重复），
   *  随 provider 切换直接覆盖；该输入框只读（名称由目录决定）。 */
  function applyAutoName(pid) {
    const input = $("pfName");
    if (!input) return;
    input.value = catalogNameMap[pid] || pid;
  }
  /** 提供商显示名兜底：目录无名称时取 Provider ID 第一个 "-" 前部分（首字母大写）。 */
  function providerDisplayName(item) {
    if (item.name && item.name !== item.id && String(item.name).trim() !== "") return item.name;
    const base = String(item.id || "").split("-")[0];
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : item.id || "";
  }

  /** 当前提供商列表（init 时注入）。 */
  let providers = [];
  /** 正在编辑的提供商 id（新增为空）。 */
  let editingProviderId = null;
  /** 当前编辑表单的模型元数据暂存：modelId -> {displayName, contextWindow, maxOutput}。 */
  let currentModelMeta = new Map();
  /** 当前自定义供应商表单的模型 id 列表（openProviderForm 时初始化）。 */
  let customModels = [];

  // ---- 左右布局：左侧菜单切换分组、组内 tab 切换面板（多 tab 预留） ----
  const sidebar = $("cfgSidebar");
  let activeGroup = "model";
  // 底部按钮随组切换：权限审批组显示"立即应用"（规则已按条单独保存，点击重启宿主生效）；
  // 模型/升级组隐藏；运行/控制组显示"保存并应用"。
  function updateFooterForGroup() {
    const footer = saveBtn.closest(".cfg-footer");
    if (activeGroup === "permission") {
      if (footer) footer.style.display = "";
      saveBtn.textContent = L.permissionApplyNow;
    } else if (activeGroup === "upgrade" || activeGroup === "model") {
      if (footer) footer.style.display = "none";
    } else {
      if (footer) footer.style.display = "";
      saveBtn.textContent = L.save;
    }
  }
  sidebar.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".cfg-nav");
    if (!btn) return;
    activeGroup = btn.dataset.group;
    sidebar.querySelectorAll(".cfg-nav").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".cfg-group").forEach((el) => {
      el.classList.toggle("active", el.dataset.group === btn.dataset.group);
    });
    updateFooterForGroup();
  });
  updateFooterForGroup(); // 初始化：默认模型组隐藏底部按钮
  document.querySelectorAll(".cfg-tabs").forEach((tabs) => {
    tabs.addEventListener("click", (ev) => {
      const tab = ev.target.closest(".cfg-tab");
      if (!tab) return;
      const group = tabs.closest(".cfg-group");
      tabs.querySelectorAll(".cfg-tab").forEach((t) => t.classList.toggle("active", t === tab));
      group.querySelectorAll(".cfg-pane").forEach((p) => {
        p.classList.toggle("active", p.dataset.pane === tab.dataset.tab);
      });
    });
  });

  // ---- 已接入提供商：列表 + 编辑/删除 + 添加/自定义 ----

  /**
   * 容量值解析（**与宿主 agent-host.mjs parseTokens 规则完全一致**）：
   * 输入支持纯数字（= tokens）或带单位后缀（K/k ×1024、M/m ×1024²），
   * 如 "200"、"200k"、"256K"、"1m"。解析失败返回 undefined（字段将被忽略，
   * 弹框校验会据此给出红色错误提示，避免"静默丢字段"）。
   */
  function parseTokenSize(v) {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
    const m = String(v ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
    if (!m) return undefined;
    const mult = m[2].toLowerCase() === "k" ? 1024 : m[2].toLowerCase() === "m" ? 1024 * 1024 : 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  /**
   * 容量值显示格式化（与查询回填 fmtTokens 一致）：
   * ≥1M 显示 "X.XM"，≥1K 显示 "XK"，其余原数字（tokens）。
   * 输入可能本身是字符串（用户手填/回填值），字符串原样返回。
   */
  function fmtTokenSize(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return v;
    if (v >= 1048576) return (v / 1048576).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 1024) return (v / 1024).toFixed(0) + "K";
    return String(v);
  }

  /** 删除确认弹框（modal 样式；确定后执行 onOk）。 */
  function confirmModal(title, text, onOk) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const esc = (s) => String(s ?? "").replace(/"/g, "&quot;");
    overlay.innerHTML = `
      <div class="modal confirm-modal">
        <h3>${esc(title)}</h3>
        <p class="confirm-text">${esc(text)}</p>
        <div class="row">
          <button type="button" class="danger" id="cfOk">${L.confirmDelete}</button>
          <button type="button" class="secondary" id="cfCancel">${L.cancel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#cfOk").addEventListener("click", () => {
      overlay.remove();
      onOk();
    });
    overlay.querySelector("#cfCancel").addEventListener("click", () => overlay.remove());
  }

  function renderProviders() {
    const listEl = $("providersList");
    listEl.innerHTML = "";
    if (!Array.isArray(providers) || providers.length === 0) {
      listEl.innerHTML = `<div class="providers-empty">${L.noProviders}</div>`;
      return;
    }
    let hasCustom = false;
    for (const p of providers) {
      if (p.type === "custom") hasCustom = true;
      const row = document.createElement("div");
      row.className = "provider-row";
      const nameWrap = document.createElement("span");
      nameWrap.className = "provider-name";
      const name = document.createElement("span");
      name.className = "provider-name-text";
      name.textContent = p.name || p.id;
      name.title = p.baseUrl || "";
      nameWrap.append(name);
      // 自定义提供商：名称后加醒目星号（加大加粗 + hover 提示编辑方式不同）
      if (p.type === "custom") {
        const mark = document.createElement("span");
        mark.className = "custom-mark";
        mark.textContent = "*";
        mark.title = L.customMarkTitle;
        nameWrap.append(mark);
      }
      // API Key 已配置提示（只显示状态，不显示密钥本身）
      if (p.apiKeyConfigured) {
        const badge = document.createElement("span");
        badge.className = "key-badge";
        badge.textContent = "🔑";
        badge.title = L.apiKeySet;
        nameWrap.append(badge);
      }
      const actions = document.createElement("span");
      actions.className = "provider-actions";
      const btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "secondary small";
      btnEdit.textContent = L.edit;
      btnEdit.addEventListener("click", () => openProviderForm(p, p.type === "custom" ? "custom" : "known"));
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "danger small";
      btnDel.textContent = L.remove;
      btnDel.addEventListener("click", () => {
        confirmModal(`${L.remove}: ${p.name || p.id}`, L.confirmDeleteProvider, () => {
          vscode.postMessage({ t: "providerDelete", id: p.id });
        });
      });
      actions.append(btnEdit, btnDel);
      row.append(nameWrap, actions);
      listEl.appendChild(row);
    }
    // 列表下方注释：说明星号含义（有自定义提供商时显示）
    if (hasCustom) {
      const note = document.createElement("div");
      note.className = "providers-note";
      note.textContent = L.customListNote;
      listEl.appendChild(note);
    }
  }

  /** Provider ID 目录（DSH 查询）到达后的填充回调（openProviderForm 注册）。 */
  let applyCatalogRef = null;

  /**
   * 提供商编辑/新增表单（modal 弹框：必须保存或取消才能继续，防信息丢失）。
   * mode="known"（添加供应商）：DSH 支持的知名供应商——Provider ID 为下拉（DSH 目录，
   *   选后带默认值），模型走「配置模型」查询勾选；
   * mode="custom"（自定义供应商）：无法查询——Provider ID 与模型全部为编辑框手填。
   * 编辑已有提供商时 Provider ID 只读（已配置不可变更），添加时可修改。
   */
  function openProviderForm(p, mode) {
    const isCustom = mode === "custom" || (p && p.type === "custom");
    const editing = Boolean(p && p.id);
    editingProviderId = p ? p.id : null;
    const esc = (s) => String(s ?? "").replace(/"/g, "&quot;");
    const protocolOpts = [
      ["openai-completions", L.protocolCompletions],
      ["openai-responses", L.protocolResponses],
      ["anthropic-messages", L.protocolAnthropic],
    ]
      .map(([v, t]) => `<option value="${v}"${p?.protocol === v ? " selected" : ""}>${t}</option>`)
      .join("");
    // Provider ID：编辑模式只读（custom 输入框 readonly；known 下拉 disabled），添加模式可改
    const pidField = isCustom
      ? `<input type="text" id="pfProviderId" value="${esc(p?.id)}" placeholder="my-provider" spellcheck="false"${editing ? " readonly" : ""}>`
      : `<select id="pfProviderId"${editing ? " disabled" : ""}><option value="">${L.loading}…</option></select>`;
    const modelField = isCustom
      ? // 自定义模式：按钮放「模型列表」标签右侧；列表框样式与知名一致（勾选 + 空列表占位）
        `<div class="label-row"><label>${L.modelsList}</label>
           <button type="button" class="secondary small" id="pfAddModel">${L.addModel}</button>
         </div>
         <div class="models-check" id="pfCustomModels"></div>`
      : `<button type="button" class="secondary small" id="pfToggleModels">▸ ${L.configureModels}</button>
         <div class="models-check hidden" id="pfModelsCheck"></div>`;
    const baseUrlField = `<input type="text" id="pfBaseUrl" value="${esc(p?.baseUrl)}" placeholder="https://..." spellcheck="false">`;
    // 知名模式：「默认」按钮放在标签行右侧（与编辑框解耦，保证编辑框布局与其它字段一致）
    const baseUrlLabel = isCustom
      ? `<label>${L.baseUrl}</label>`
      : `<div class="label-row"><label>${L.baseUrl}</label>
           <button type="button" class="secondary small" id="pfDefaultBaseUrl">${L.defaultBtn}</button>
         </div>`;
    // API Key 已配置提示（不显示密钥值）
    const apiKeyNote = p?.apiKeyConfigured ? `<div class="key-note configured">${L.apiKeySetHint}</div>` : "";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const title = editing
      ? `${L.edit}: ${p.name || p.id}`
      : isCustom
        ? L.addCustomProviderTitle
        : L.addProviderTitle;
    overlay.innerHTML = `
      <div class="modal provider-modal">
        <h3>${esc(title)}</h3>
        <div class="field">
          <label>${L.providerId}</label>
          ${pidField}
          <span class="hint">${isCustom ? "" : L.providerIdHint}</span>
        </div>
        <div class="field">
          <label>${L.providerName}</label>
          <!-- 知名模式：名称由目录决定（只读）；自定义模式：手填 -->
          <input type="text" id="pfName" value="${esc(p?.name)}" spellcheck="false"${isCustom ? "" : " readonly"}>
        </div>
        <div class="field">
          ${baseUrlLabel}
          ${baseUrlField}
        </div>
        <div class="field">
          <label>${L.protocol}</label>
          <select id="pfProtocol">${protocolOpts}</select>
        </div>
        <div class="field">
          <label>${L.apiKeyFor}</label>
          <input type="password" id="pfApiKey" placeholder="${L.apiKeyPlaceholder}" autocomplete="off" spellcheck="false">
          ${apiKeyNote}
        </div>
        <div class="field">
          ${isCustom ? "" : `<label>${L.modelsList}</label>`}
          ${modelField}
        </div>
        <div class="row">
          <button type="button" class="primary" id="pfSave">${L.saveProvider}</button>
          <button type="button" class="secondary" id="pfCancel">${L.cancel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // 模型元数据（编辑弹框暂存）：modelId -> {displayName, contextWindow, maxOutput}
    currentModelMeta = new Map();
    for (const m of p?.models ?? []) {
      if (m && typeof m === "object" && m.id) currentModelMeta.set(m.id, m);
    }
    // 自定义供应商模型 id 列表（行渲染/保存共用）
    customModels = isCustom
      ? (p?.models ?? []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean)
      : [];

    if (!isCustom) {
      // 知名供应商：Provider ID 下拉 = DSH 目录（不含自定义项）；选中联动填显示名与默认 Base URL
      const pidSel = $("pfProviderId");
      applyCatalogRef = (list) => {
        pidSel.innerHTML = "";
        catalogBaseUrlMap = {};
        catalogNameMap = {};
        for (const item of list || []) {
          // provider id 是唯一标识：已接入的提供商不可重复添加（只能编辑）。
          // 添加模式跳过已接入 id；编辑模式靠下方"补原值选项"兜底显示当前项。
          if (providers.some((x) => x.id === item.id)) continue;
          const opt = document.createElement("option");
          opt.value = item.id;
          // 下拉显示 provider id（与选项值一致，避免"显示名称/值为 id"的混淆）；
          // 名称存入 catalogNameMap，选中后填入「提供商名称」字段。
          opt.textContent = item.id;
          if (item.baseUrl) catalogBaseUrlMap[item.id] = item.baseUrl;
          catalogNameMap[item.id] = providerDisplayName(item);
          pidSel.appendChild(opt);
        }
        if (editingProviderId) {
          // 编辑已有提供商：ID 只读。目录缺失该路由（如本地 Ollama）时补一个原值选项，
          // 绝不回退到目录第一项（否则会把 Ollama 显示成 deepseek）。
          if (pidSel.querySelector(`option[value="${CSS.escape(editingProviderId)}"]`)) {
            pidSel.value = editingProviderId;
          } else {
            const opt = document.createElement("option");
            opt.value = editingProviderId;
            opt.textContent = (providers.find((x) => x.id === editingProviderId)?.name) || editingProviderId;
            pidSel.appendChild(opt);
            pidSel.value = editingProviderId;
          }
        } else if (pidSel.options.length > 0) {
          pidSel.value = pidSel.options[0].value;
        }
        // 编辑模式：名称保留已接入的原值（readonly 展示）；添加模式：名称跟随目录
        if (!editingProviderId) applyAutoName(pidSel.value);
        applyDefaultBaseUrl(pidSel.value);
      };
      pidSel.addEventListener("change", () => {
        // 切换提供商：名称（只读跟随目录）/ Base URL 跟随
        applyAutoName(pidSel.value);
        applyDefaultBaseUrl(pidSel.value);
      });
      vscode.postMessage({ t: "queryProviders" });

      // 「默认」按钮：恢复该供应商的公开 API 地址（目录值优先，手写表兜底）
      $("pfDefaultBaseUrl").addEventListener("click", () => {
        $("pfBaseUrl").value = catalogBaseUrlMap[pidSel.value] || PROVIDER_DEFAULT_BASEURL[pidSel.value] || "";
        lastAutoBaseUrl = $("pfBaseUrl").value;
      });

      // 配置模型折叠：点击展开 → 立即查询模型列表（编辑已配置密钥的提供商时，用已存密钥查询）
      $("pfToggleModels").addEventListener("click", () => {
        const checkEl = $("pfModelsCheck");
        if (!checkEl.classList.contains("hidden")) {
          checkEl.classList.add("hidden");
          $("pfToggleModels").textContent = `▸ ${L.configureModels}`;
          return;
        }
        checkEl.classList.remove("hidden");
        checkEl.textContent = L.fetching;
        $("pfToggleModels").textContent = `▾ ${L.configureModels}`;
        vscode.postMessage({
          t: "fetchModels",
          // 编辑用已接入的 provider id；新增时用当前选中的 provider（知名模式=目录下拉 id，
          // 自定义模式=输入框 id）——否则 discoverModels 收不到 provider，走不到内置直返/目录查询
          providerId: editingProviderId || (isCustom ? $("pfProviderId").value : pidSel.value) || undefined,
          baseUrl: $("pfBaseUrl").value.trim(),
          apiKey: $("pfApiKey").value.trim(),
          protocol: $("pfProtocol").value,
        });
      });
    }

    if (isCustom) {
      // 自定义供应商模型勾选列表：每行勾选框 + ID/名称 + 编辑/删除，样式与知名一致。
      // 添加时默认勾选；取消勾选 = 该模型不生效（不出现在可用模型下拉框）。customModels 即"已勾选集合"。
      const renderCustomModels = () => {
        const listEl = $("pfCustomModels");
        if (!listEl) return;
        listEl.innerHTML = "";
        if (customModels.length === 0) {
          // 空列表也显示列表框（占位提示），保持结构均衡
          listEl.innerHTML = `<div class="providers-empty">${L.manualModelsHint}</div>`;
          return;
        }
        const syncRowState = (row, cb, btn) => {
          row.classList.toggle("model-selected", cb.checked);
          btn.disabled = !cb.checked;
        };
        for (const id of customModels) {
          const meta = currentModelMeta.get(id);
          const row = document.createElement("div");
          row.className = "model-row";
          const label = document.createElement("label");
          label.className = "model-check";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = true; // 添加时默认勾选
          cb.dataset.model = id;
          label.append(cb, document.createTextNode(` ${meta?.displayName ? `${meta.displayName} (${id})` : id}`));
          const actions = document.createElement("span");
          actions.className = "provider-actions";
          const btnEdit = document.createElement("button");
          btnEdit.type = "button";
          btnEdit.className = "secondary small";
          btnEdit.textContent = L.edit;
          btnEdit.addEventListener("click", () => {
            openModelEditor(id, currentModelMeta.get(id), (meta2) => {
              currentModelMeta.set(id, { id, displayName: meta2.displayName, contextWindow: meta2.contextWindow, maxOutput: meta2.maxOutput, inputModalities: meta2.inputModalities });
              renderCustomModels();
            }, true, true);
          });
          const btnDel = document.createElement("button");
          btnDel.type = "button";
          btnDel.className = "danger small";
          btnDel.textContent = L.remove;
          btnDel.addEventListener("click", () => {
            confirmModal(`${L.remove}: ${id}`, L.confirmDeleteModel, () => {
              customModels = customModels.filter((x) => x !== id);
              currentModelMeta.delete(id);
              renderCustomModels();
            });
          });
          // 勾选状态：取消勾选 = 从生效集合移除（保存时不提交）；重新勾选 = 重新加入
          cb.addEventListener("change", () => {
            syncRowState(row, cb, btnEdit);
            customModels = customModels.filter((x) => x !== id);
            if (cb.checked) customModels.push(id);
          });
          syncRowState(row, cb, btnEdit);
          actions.append(btnEdit, btnDel);
          row.append(label, actions);
          listEl.appendChild(row);
        }
      };
      renderCustomModels();
      // 「添加模型」→ 弹模型配置窗口（ID 可编辑），保存后加入列表（默认勾选）
      $("pfAddModel").addEventListener("click", () => {
        openModelEditor(
          "",
          null,
          (meta) => {
            if (!meta.id) return;
            currentModelMeta.set(meta.id, { id: meta.id, displayName: meta.displayName, contextWindow: meta.contextWindow, maxOutput: meta.maxOutput, inputModalities: meta.inputModalities });
            if (!customModels.includes(meta.id)) customModels.push(meta.id);
            renderCustomModels();
          },
          false,
          true
        );
      });
    }

    $("pfSave").addEventListener("click", () => {
      const name = $("pfName").value.trim();
      const baseUrl = $("pfBaseUrl").value.trim();
      if (!name || !baseUrl) {
        (name ? $("pfBaseUrl") : $("pfName")).focus();
        return;
      }
      let models;
      let providerId;
      if (isCustom) {
        models = customModels.map((id) => {
          const meta = currentModelMeta.get(id);
          return { id, displayName: meta?.displayName, contextWindow: meta?.contextWindow, maxOutput: meta?.maxOutput };
        });
        providerId = editingProviderId || $("pfProviderId").value.trim() || name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      } else {
        models = [...$("pfModelsCheck").querySelectorAll("input[type=checkbox]:checked")].map((cb) => {
          const meta = currentModelMeta.get(cb.dataset.model);
          return {
            id: cb.dataset.model,
            displayName: meta?.displayName,
            contextWindow: meta?.contextWindow,
            maxOutput: meta?.maxOutput,
            inputModalities: Array.isArray(meta?.inputModalities) ? meta.inputModalities : undefined,
          };
        });
        providerId = $("pfProviderId").value;
        // 知名模式必须显式选择提供商（目录未就绪时下拉可能为空，阻止保存）
        if (!providerId) {
          $("pfProviderId").focus();
          return;
        }
      }
      const provider = {
        id: providerId,
        name,
        baseUrl,
        protocol: $("pfProtocol").value,
        type: isCustom ? "custom" : p?.type || "known",
        models,
      };
      const apiKey = $("pfApiKey").value.trim() || undefined;
      // isEdit：区分新增/编辑——新增时若 id 已存在（重复添加）由扩展侧拒绝
      vscode.postMessage({ t: "providerSave", provider, apiKey, isEdit: Boolean(editingProviderId) });
      applyCatalogRef = null;
      overlay.remove();
    });
    $("pfCancel").addEventListener("click", () => {
      applyCatalogRef = null;
      overlay.remove();
    });
  }

  /**
   * 模型编辑/添加弹框：模型 ID（编辑时只读，添加时可编辑）/ 显示名 / 上下文窗口 /
   * 最大输出；保存/取消均关闭，保存暂存。idReadonly=false 表示添加新模型（ID 输入框可填）。
   *
   * 校验规则（isCustom 决定预填策略，校验规则统一）：
   * - 模型 ID / 模型名称：必须非空；且在本提供商范围内唯一（id 与 name 都不能与
   *   其它模型的 id 或 name 重叠）；
   * - 上下文窗口 / 最大输出：可留空（自定义模型留空 = 不传递该参数，模型用默认值）；
   *   填了就必须合法（纯数字或 K/M 单位）且 ≥ 1k（1024），最大值不限；
   * - 知名提供商：以查出的模型能力默认值预填（查不到则留空）；自定义：默认留空。
   */
  function openModelEditor(modelId, meta, onSave, idReadonly = true, isCustom = true) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const esc = (s) => String(s ?? "").replace(/"/g, "&quot;");
    // 预填策略：模型有已存/查出的能力值则回填（fmtTokenSize 数字→K/M）；
    // 无值（自定义新模型）留空 = 不传参数走模型默认。
    const ctxVal = fmtTokenSize(meta?.contextWindow) || "";
    const maxVal = fmtTokenSize(meta?.maxOutput) || "";
    overlay.innerHTML = `
      <div class="modal">
        <h3>${L.modelEditTitle}</h3>
        <div class="field"><label>${L.modelId}</label><input type="text" id="meId" value="${esc(modelId)}"${idReadonly ? " readonly" : ""} spellcheck="false">
          <span class="token-note hidden" id="meIdNote"></span></div>
        <div class="field"><label>${L.modelDisplayName}</label><input type="text" id="meName" value="${esc(meta?.displayName || "")}" spellcheck="false">
          <span class="token-note hidden" id="meNameNote"></span></div>
        <div class="field">
          <label>${L.contextWindow}${isCustom ? `（${L.optional}）` : ""}</label>
          <input type="text" id="meCtx" value="${esc(ctxVal)}" placeholder="${esc(L.tokenSizePlaceholder)}" spellcheck="false">
          <span class="token-note hidden" id="meCtxNote"></span>
        </div>
        <div class="field">
          <label>${L.maxOut}${isCustom ? `（${L.optional}）` : ""}</label>
          <input type="text" id="meMax" value="${esc(maxVal)}" placeholder="${esc(L.tokenSizePlaceholder)}" spellcheck="false">
          <span class="token-note hidden" id="meMaxNote"></span>
        </div>
        <div class="field">
          <label>${L.modalities}${isCustom ? `（${L.optional}）` : ""}</label>
          <select id="meModal"${isCustom ? "" : " disabled"}>
            <option value="text">${L.modText}</option>
            <option value="text,image">${L.modTextImage}</option>
          </select>
          ${isCustom ? "" : `<span class="hint">${L.modReadonly}</span>`}
        </div>
        <div class="row">
          <button type="button" class="primary" id="meSave">${L.saveProvider}</button>
          <button type="button" class="secondary" id="meCancel">${L.cancel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    const $me = (id) => overlay.querySelector(`#${id}`);

    // 回填模态能力：模型已存/查出的 inputModalities（含 image 则回填"文本+图片"）
    const mods = Array.isArray(meta?.inputModalities) ? meta.inputModalities : (isCustom ? ["text"] : ["text"]);
    const modalSel = $me("meModal");
    if (modalSel) modalSel.value = mods.includes("image") ? "text,image" : "text";

    // 本提供商范围内其它模型的 id / 名称集合（查重用；排除当前编辑的模型自身）
    const otherIds = new Set();
    const otherNames = new Set();
    for (const [mid, m] of currentModelMeta.entries()) {
      if (mid === modelId) continue;
      otherIds.add(mid);
      if (m && typeof m === "object" && m.displayName) otherNames.add(String(m.displayName).trim());
    }
    // custom 添加时 currentModelMeta 可能还没含未保存的 id？不——添加流程先编辑后入表，
    // 此处 currentModelMeta 已含全部已添加模型，id 唯一性据此判断即可。

    const showNote = (noteEl, text, kind) => {
      const note = $me(noteEl);
      if (!text) {
        note.classList.add("hidden");
        return;
      }
      note.textContent = text;
      note.className = `token-note ${kind}`;
    };

    /**
     * 校验 ID：非空 + （可编辑时）提供商内唯一（不与其它 id/name 重叠）。
     */
    const validateId = () => {
      const v = $me("meId").value.trim();
      if (idReadonly) return { ok: true }; // 只读：已存在模型，无需重复校验
      if (!v) {
        showNote("meIdNote", L.modelIdRequired, "error");
        $me("meId").classList.add("invalid");
        return { ok: false };
      }
      if (otherIds.has(v) || otherNames.has(v)) {
        showNote("meIdNote", L.modelIdDuplicate, "error");
        $me("meId").classList.add("invalid");
        return { ok: false };
      }
      showNote("meIdNote", "", "");
      $me("meId").classList.remove("invalid");
      return { ok: true };
    };

    /**
     * 校验名称：非空 + 提供商内唯一（不与其它 id/name 重叠；自身旧名称除外）。
     */
    const validateName = () => {
      const v = $me("meName").value.trim();
      const oldName = String(meta?.displayName || "").trim();
      if (!v) {
        showNote("meNameNote", L.modelNameRequired, "error");
        $me("meName").classList.add("invalid");
        return { ok: false };
      }
      if ((otherIds.has(v) || otherNames.has(v)) && v !== oldName) {
        showNote("meNameNote", L.modelNameDuplicate, "error");
        $me("meName").classList.add("invalid");
        return { ok: false };
      }
      showNote("meNameNote", "", "");
      $me("meName").classList.remove("invalid");
      return { ok: true };
    };

    /**
     * 校验容量输入：可留空（=不传参数）；非空必须合法（纯数字或 K/M 单位）
     * 且 ≥1k（1024）。非法格式与过小均阻止保存（信息不同）。
     * @returns {{ok: boolean}}
     */
    const validateSize = (input, noteEl) => {
      const raw = input.value.trim();
      if (raw === "") {
        showNote(noteEl, "", "");
        input.classList.remove("invalid", "warn");
        return { ok: true };
      }
      const n = parseTokenSize(raw);
      if (n === undefined) {
        showNote(noteEl, L.tokenSizeInvalid, "error");
        input.classList.add("invalid");
        return { ok: false };
      }
      if (n < 1024) {
        showNote(noteEl, L.tokenSizeTooSmall, "error");
        input.classList.add("invalid");
        return { ok: false };
      }
      showNote(noteEl, "", "");
      input.classList.remove("invalid", "warn");
      return { ok: true };
    };

    const checkCtx = () => validateSize($me("meCtx"), "meCtxNote");
    const checkMax = () => validateSize($me("meMax"), "meMaxNote");
    $me("meId").addEventListener("input", validateId);
    $me("meName").addEventListener("input", validateName);
    $me("meCtx").addEventListener("input", checkCtx);
    $me("meMax").addEventListener("input", checkMax);
    // 打开弹框立即校验一次（回填的旧值可能本来就是错的，如 contextWindow=200）
    validateId();
    validateName();
    checkCtx();
    checkMax();

    $me("meSave").addEventListener("click", () => {
      const id = idReadonly ? modelId : $me("meId").value.trim();
      // 全字段校验：任一失败 → 阻止保存并聚焦第一个出错字段
      const checks = [validateId, validateName, checkCtx, checkMax];
      const focusMap = ["meId", "meName", "meCtx", "meMax"];
      for (let i = 0; i < checks.length; i++) {
        if (!checks[i]().ok) {
          $me(focusMap[i]).focus();
          return;
        }
      }
      if (!id) {
        $me("meId").focus();
        return;
      }
      onSave({
        id,
        displayName: $me("meName").value.trim(),
        contextWindow: $me("meCtx").value.trim() || undefined,
        maxOutput: $me("meMax").value.trim() || undefined,
        inputModalities: ($me("meModal").value || "text").split(","),
      });
      overlay.remove();
    });
    $me("meCancel").addEventListener("click", () => overlay.remove());
  }

  $("cfgAddProvider").addEventListener("click", () => {
    openProviderForm(null, "known");
  });
  $("cfgAddCustomProvider").addEventListener("click", () => {
    openProviderForm({ id: "", name: "", baseUrl: "", protocol: "openai-completions", models: [], type: "custom" }, "custom");
  });

  $("cfgPickWorkspace").addEventListener("click", () => vscode.postMessage({ t: "pickFolder", field: "defaultWorkspace" }));
  $("cfgPickNode").addEventListener("click", () => vscode.postMessage({ t: "pickFolder", field: "nodePath" }));

  saveBtn.addEventListener("click", () => {
    saveBtn.disabled = true;
    // 权限审批组：规则已按条单独保存，此按钮 = "立即应用"（重启宿主使规则生效）
    if (activeGroup === "permission") {
      vscode.postMessage({ t: "applyPermission" });
      saveBtn.disabled = false;
      return;
    }
    // 保存中/结果提示统一由扩展显示在 VS Code 状态栏，面板内不再显示任何文字
    // （避免挤占/移动保存按钮位置）
    // 权限规则校验：DSH 内核暂未提供命令参数，仅支持工具级匹配——含空白=命令级，拒绝保存
    const cmdRule = permissionRules.find((r) => /\s/.test(r.match));
    if (cmdRule) {
      showPermissionError(L.permissionCommandRejected);
      saveBtn.disabled = false;
      return;
    }
    vscode.postMessage({
      t: "save",
      values: {
        permissionMode: fields.permissionMode.value,
        nodePath: fields.nodePath.value.trim(),
        defaultWorkspace: fields.defaultWorkspace.value.trim(),
        maxOutputChars: parseInt(fields.maxOutputChars.value, 10) || 40000,
        maxSteps: parseInt(fields.maxSteps.value, 10) || 0,
        subagentMaxDepth: parseInt(fields.subagentMaxDepth.value, 10) || 3,
        maxParallelSubagents: parseInt(fields.maxParallelSubagents.value, 10) || 5,
        autoCompaction: fields.autoCompaction.checked,
        compactionThresholdRatio: (parseFloat(fields.compactionThresholdRatio.value) || 80) / 100,
        compactionMaxTokens: parseInt(fields.compactionMaxTokens.value, 10) || 8192,
        autoApproveRules: permissionRules.filter((r) => r.match && r.match.trim() !== "").map((r) => ({ match: r.match.trim(), action: r.action })),
      },
    });
  });

  // 取消 = 直接关闭配置页面（无"取消"按钮；关闭面板即取消，无需消息）

  function fill(c) {
    c = c || {};
    fields.permissionMode.value = c.permissionMode || "workspace-write";
    fields.nodePath.value = c.nodePath || "";
    fields.defaultWorkspace.value = c.defaultWorkspace || "";
    fields.maxOutputChars.value = String(c.maxOutputChars || 40000);
    fields.maxSteps.value = String(c.maxSteps ?? 100);
    fields.subagentMaxDepth.value = String(c.subagentMaxDepth ?? 3);
    fields.maxParallelSubagents.value = String(c.maxParallelSubagents ?? 5);
    fields.autoCompaction.checked = c.autoCompaction !== false;
    updateAutoCompactionState();
    fields.compactionThresholdRatio.value = String(Math.round((c.compactionThresholdRatio ?? 0.8) * 100));
    fields.compactionMaxTokens.value = String(c.compactionMaxTokens ?? 8192);
    permissionRules = Array.isArray(c.autoApproveRules) && c.autoApproveRules.length > 0
      ? c.autoApproveRules.map((r) => ({ match: String(r.match ?? ""), action: ["allow", "ask", "deny"].includes(r.action) ? r.action : "ask", saved: true, dirty: false, baseMatch: String(r.match ?? ""), baseAction: ["allow", "ask", "deny"].includes(r.action) ? r.action : "ask" }))
      : DEFAULT_PERMISSION_RULES.map((r) => ({ ...r, saved: true, dirty: false, baseMatch: r.match, baseAction: r.action }));
    renderPermissionRules();
    cwdEl.value = c.cwd || "";
    saveBtn.disabled = false;
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    switch (msg.t) {
      case "config":
        fill(msg.config);
        providers = Array.isArray(msg.providers) ? msg.providers : [];
        renderProviders();
        break;
      case "providerKeys": {
        // 密钥库状态异步到达：合并后重渲染（更新 🔑 徽标，不阻塞首次列表显示）
        const states = msg.states || {};
        providers = (Array.isArray(providers) ? providers : []).map((p) => ({
          ...p,
          apiKeyConfigured: Boolean(states[p.id]),
        }));
        renderProviders();
        break;
      }
      case "folder":
        if (msg.path) {
          if (msg.field === "defaultWorkspace") fields.defaultWorkspace.value = msg.path;
          else fields.nodePath.value = msg.path;
        }
        break;
      case "saved":
        // 保存中/成功/失败提示全部由扩展显示在 VS Code 状态栏；
        // 面板内只负责恢复按钮（绝不显示文字、不挤占按钮位置）。
        saveBtn.disabled = false;
        break;
      case "providersCatalog":
        if (applyCatalogRef) {
          applyCatalogRef(msg.providers);
          applyCatalogRef = null;
        }
        break;
      case "models": {
        // 实时模型查询结果：渲染勾选列表（勾选 + 模型名/ID + 编辑按钮）。
        // 条目兼容字符串（回退网络查询，仅 id）与对象（DSH 发现，含 contextWindow/maxTokens）。
        const checkEl = $("pfModelsCheck");
        if (!checkEl) return;
        if (msg.error || !Array.isArray(msg.models) || msg.models.length === 0) {
          // 查询失败：保持展开并显示错误原因，让用户看到失败信息（不静默收起）
          checkEl.textContent = L.fetchFailed + (msg.error || "empty");
          const toggle = $("pfToggleModels");
          if (toggle) toggle.textContent = `▾ ${L.configureModels}`;
          return;
        }
        // 查询到的元数据入暂存：编辑弹框默认值优先用模型自身值（查不到才用 256K/32K 兜底）
        for (const raw of msg.models) {
          const m = typeof raw === "string" ? { id: raw } : raw || {};
          if (!m.id) continue;
          currentModelMeta.set(m.id, {
            id: m.id,
            displayName: m.name,
            contextWindow: fmtTokenSize(m.contextWindow),
            maxOutput: fmtTokenSize(m.maxTokens),
            inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : undefined,
          });
        }
        const preselect = new Set(
          (providers.find((x) => x.id === editingProviderId)?.models ?? [])
            .map((m) => (typeof m === "string" ? m : m?.id))
            .filter(Boolean)
        );
        checkEl.innerHTML = "";
        // 勾选状态联动行样式与编辑按钮：未勾选普通色且编辑不可点；勾选后高亮、可编辑
        const syncRowState = (row, cb, btn) => {
          row.classList.toggle("model-selected", cb.checked);
          btn.disabled = !cb.checked;
        };
        for (const raw of msg.models) {
          const m = typeof raw === "string" ? { id: raw } : raw || {};
          if (!m.id) continue;
          const row = document.createElement("div");
          row.className = "model-row";
          const label = document.createElement("label");
          label.className = "model-check";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.dataset.model = m.id;
          cb.checked = preselect.has(m.id);
          label.append(cb, document.createTextNode(` ${m.name || m.id}`));
          // 模态标识：知名模型携带的 inputModalities 含 image → 标注多模态
          const mods = Array.isArray(m.inputModalities) ? m.inputModalities : [];
          if (mods.includes("image")) {
            const badge = document.createElement("span");
            badge.className = "image-badge";
            badge.textContent = "📷";
            badge.title = L.modTextImage;
            label.appendChild(badge);
          }
          const btnEdit = document.createElement("button");
          btnEdit.type = "button";
          btnEdit.className = "secondary small";
          btnEdit.textContent = L.edit;
          btnEdit.addEventListener("click", () => {
            openModelEditor(m.id, currentModelMeta.get(m.id), (meta) => currentModelMeta.set(m.id, { id: m.id, ...meta }), true, false);
          });
          cb.addEventListener("change", () => syncRowState(row, cb, btnEdit));
          syncRowState(row, cb, btnEdit);
          row.append(label, btnEdit);
          checkEl.appendChild(row);
        }
        break;
      }
      case "upgradeState": {
        const d = msg.dsh || {};
        const p = msg.plugin || {};
        upgDsh.current.textContent = d.current || "—";
        upgDsh.current.dataset.bundled = d.bundled || "";
        dshVersions = d.versions || [];
        fillVersionSelect(upgDsh.select, dshVersions, d.current);
        showNotesFor(upgDsh, dshVersions);
        // 缓存为空（= DSH 刚升级/重置导致缓存被清，或首次）：自动补查一次，及时拿到新基线
        if (dshVersions.length === 0) vscode.postMessage({ t: "dshQuery" });
        upgPlugin.current.textContent = p.current || "—";
        pluginVersions = p.versions || [];
        fillVersionSelect(upgPlugin.select, pluginVersions, p.current);
        showNotesFor(upgPlugin, pluginVersions);
        if (pluginVersions.length === 0) vscode.postMessage({ t: "pluginQuery" });
        break;
      }
      case "dshQueryResult":
        applyQueryResult("dsh", msg);
        break;
      case "pluginQueryResult":
        applyQueryResult("plugin", msg);
        break;
      case "dshApplyResult":
        // 升级结果提示由扩展显示在 VS Code 状态栏；此处仅恢复按钮
        setBusy("dsh", false);
        break;
      case "pluginApplyResult":
        setBusy("plugin", false);
        break;
      case "dshResetResult":
        setBusy("dsh", false);
        break;
    }
  });

  /* ---------------- 版本升级组（DSH 核心 + AY-DSH 插件） ---------------- */

  const upgDsh = {
    current: $("upgDshCurrent"),
    select: $("upgDshSelect"),
    notes: $("upgDshNotes"),
    reset: $("upgDshReset"),
    update: $("upgDshUpdate"),
    refresh: $("upgDshRefresh"),
  };
  const upgPlugin = {
    current: $("upgPluginCurrent"),
    select: $("upgPluginSelect"),
    notes: $("upgPluginNotes"),
    update: $("upgPluginUpdate"),
    refresh: $("upgPluginRefresh"),
  };
  let dshVersions = [];
  let pluginVersions = [];
  let dshBusy = false;
  let pluginBusy = false;

  /** 填充版本下拉：无可用版本时回退显示当前版本（单一项）。 */
  function fillVersionSelect(sel, versions, current) {
    sel.innerHTML = "";
    const list = Array.isArray(versions) && versions.length > 0 ? versions : [{ version: current || "" }];
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.version || "";
      opt.textContent = v.version || "—";
      sel.appendChild(opt);
    }
    sel.value = list[0].version || "";
  }

  /** HTML 转义（release note 渲染前处理，防注入）。 */
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 轻量 markdown 渲染（release note 用）：代码块/标题/列表/粗体/行内代码/链接/换行。 */
  function renderMarkdown(text) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let inCode = false;
    let codeBuf = [];
    const inline = (s) =>
      s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    for (const line of lines) {
      if (/^```/.test(line)) {
        if (inCode) {
          out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
          codeBuf = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }
      const t = line.trim();
      if (!t) {
        out.push("");
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
        continue;
      }
      if (/^[-*]\s+/.test(t)) {
        out.push(`<li>${inline(t.replace(/^[-*]\s+/, ""))}</li>`);
        continue;
      }
      const ol = /^\d+\.\s+(.*)$/.exec(t);
      if (ol) {
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }
      out.push(`<p>${inline(t)}</p>`);
    }
    if (inCode && codeBuf.length) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
    return out.join("\n");
  }

  /** 按下拉选中项刷新 release note 只读框（markdown 渲染）。 */
  function showNotesFor(group, versions) {
    const ver = group.select.value;
    const found = (Array.isArray(versions) ? versions : []).find((v) => v.version === ver);
    group.notes.innerHTML = found && found.notes ? renderMarkdown(found.notes) : `<span class="notes-empty">${L.notesPlaceholder}</span>`;
  }

  /** 执行期间禁用/恢复按钮（防重复点击）。 */
  function setBusy(kind, busy) {
    const g = kind === "dsh" ? upgDsh : upgPlugin;
    const btns = kind === "dsh" ? [g.reset, g.update, g.refresh] : [g.update, g.refresh];
    btns.forEach((b) => (b.disabled = busy));
    if (kind === "dsh") dshBusy = busy;
    else pluginBusy = busy;
  }

  /** 查询结果落地：刷新下拉 + release note + 恢复按钮。 */
  function applyQueryResult(kind, msg) {
    const isDsh = kind === "dsh";
    const g = isDsh ? upgDsh : upgPlugin;
    g.refresh.disabled = false;
    g.refresh.textContent = L.refresh;
    if (msg.error) {
      g.notes.innerHTML = `<span class="notes-empty">${L.queryFailed}${escapeHtml(msg.error)}</span>`;
      return;
    }
    if (isDsh) dshVersions = msg.versions || [];
    else pluginVersions = msg.versions || [];
    fillVersionSelect(g.select, msg.versions || [], g.current.textContent);
    showNotesFor(g, msg.versions || []);
  }

  if (upgDsh.refresh) {
    upgDsh.refresh.addEventListener("click", () => {
      upgDsh.refresh.disabled = true;
      upgDsh.refresh.textContent = L.querying;
      vscode.postMessage({ t: "dshQuery" });
    });
    upgDsh.update.addEventListener("click", () => {
      const v = upgDsh.select.value;
      if (!v) {
        upgDsh.notes.innerHTML = `<span class="notes-empty">${L.selectVersionFirst}</span>`;
        return;
      }
      // 确认框由扩展侧弹原生对话框（webview 内 window.confirm 被禁用）
      setBusy("dsh", true);
      vscode.postMessage({ t: "dshApplyConfirm", version: v });
    });
    upgDsh.reset.addEventListener("click", () => {
      setBusy("dsh", true);
      vscode.postMessage({ t: "dshResetConfirm" });
    });
    upgDsh.select.addEventListener("change", () => showNotesFor(upgDsh, dshVersions));

    upgPlugin.refresh.addEventListener("click", () => {
      upgPlugin.refresh.disabled = true;
      upgPlugin.refresh.textContent = L.querying;
      vscode.postMessage({ t: "pluginQuery" });
    });
    upgPlugin.update.addEventListener("click", () => {
      const v = upgPlugin.select.value;
      if (!v) {
        upgPlugin.notes.innerHTML = `<span class="notes-empty">${L.selectVersionFirst}</span>`;
        return;
      }
      setBusy("plugin", true);
      vscode.postMessage({ t: "pluginApplyConfirm", version: v });
    });
    upgPlugin.select.addEventListener("change", () => showNotesFor(upgPlugin, pluginVersions));
  }

  vscode.postMessage({ t: "init" });
})();
