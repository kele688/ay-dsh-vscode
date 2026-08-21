/**
 * chat.js — DSH 聊天视图前端（无框架）。
 * 渲染：用户消息 / 助手流式消息（含 reasoning 折叠）/ 工具调用内联块 / 审批。
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const approvalEl = $("approval");
  const btnAllow = $("btnAllow");
  const btnDeny = $("btnDeny");
  const btnSend = $("btnSend");
  const btnNew = $("btnNew");
  const hintEl = $("hint");
  const btnExportFull = $("btnExportFull");
  const topbarEl = $("topbar");
  const sessionTitleEl = $("sessionTitle");
  const contextPctEl = $("contextPct");
  const tokensInEl = $("tokensIn");
  const stepsEl = $("steps");
  const dshVersionEl = $("dshVersion");
  const dshUpdateEl = $("dshUpdate");
  const tokensCacheEl = $("tokensCache");
  const tokensOutEl = $("tokensOut");
  const btnCompact = $("btnCompact");
  const selProvider = $("selProvider");
  const selModel = $("selModel");
  const selEffort = $("selEffort");
  const selWorkMode = $("selWorkMode");

  const state = {
    running: false,
    compacting: false, // 上下文压缩进行中（发送按钮禁用，防止与压缩冲突）
    resuming: false, // 正在恢复历史会话（history 帧渲染完成前锁定发送，防止用户消息被清空）
    exporting: false, // 正在导出完整会话记录（导出按钮禁用，防止重复导出）
    discardPending: false, // 停止后：丢弃随后到达的本轮收尾消息（未接收完的输出不再渲染）
    approvals: new Map(), // id -> {toolName, reason}
    currentAssistant: null, // 当前正在流式输出的助手消息元素
    currentReasoning: null,
    pendingApprovalId: null,
    sessionId: null, // 当前会话 id（bootstrap 时更新）
    viewSessionId: null, // 只读浏览中的会话 id（子代理会话；非 null = 浏览模式，发送禁用）
    stats: null, // 最近一次会话统计
    modelInfo: null, // （历史遗留字段，无读取方；保留以兼容旧帧结构）
    providerModels: {}, // 按提供商分组的模型（provider -> model id 列表），模型下拉过滤用
    suppressSelectorEvents: false, // 填充下拉时抑制 change 事件
    historyMore: null, // {hasMore, nextSeq} 分页状态
    historyLoadingMore: false, // 正在加载更早历史（防重入）
    streamText: "", // 当前流式气泡的累积纯文本（供节流 markdown 渲染使用）
  };

  // 代码块复制：codeId -> 代码文本（渲染时登记，点击复制按钮时读取）
  const codeTexts = new Map();
  let codeSeq = 0;
  /** 会话恢复兜底定时器（history 帧 15 秒未到达则自动解除发送锁定）。 */
  let resumeTimer = null;

  /* ---------------- 国际化（跟随 VS Code 语言） ---------------- */

  const I18N = {
    zh: {
      thinking: "思考过程",
      truncated: "\n…（已截断）",
      result: "── 结果 ──",
      done: "✓ 完成",
      failed: "✗ 失败",
      approvalAsk: (name) => `Agent 请求调用工具 <strong>${name}</strong>`,
      approvalQueue: (n) => `⏳ 队列中还有 ${n} 个待授权请求（逐个处理）`,
      approvalAgent: (id) => `🧩 子任务 …${id} 请求：`,
      emptyHistory: "暂无历史会话",
      currentSession: " · 当前会话",
      resume: "▶ 继续",
      resumeTitle: "重新加载此会话并继续对话",
      view: "查看",
      viewTitle: "只读浏览该子代理会话的历史（不成为对话宿主）",
      viewingSession: (id) => `浏览模式：正在查看子代理会话 ${id}（只读，切换真实会话后恢复）`,
      viewFailed: "浏览会话失败，已恢复原会话",
      restoring: "正在恢复会话…（长会话可能需要几秒）",
      restartingHint: "正在恢复原会话…",
      del: "🗑 删除",
      delTitle: "删除此会话（不可恢复）",
      confirmDel: "确认删除？",
      deleting: "正在删除会话…",
      deleted: "已删除会话",
      deleteFailed: (e) => `删除失败：${e}`,
      loading: "加载中…",
      loadTimeout: "加载超时：宿主未响应，请稍候点 ⟳ 刷新，或查看输出通道日志",
      loadTimeoutHint: "加载超时：宿主正在启动或未响应，请稍候点击 ⟳ 刷新",
      cwdTitle: "点击在文件管理器中打开工作目录（Agent 生成的文件都在这里）",
      keyMissing: "⚠ API Key 未配置，Agent 无法调用模型",
      keyConfigBtn: "立即配置 ⚙",
      notStarted: "尚未启动",
      starting: "宿主启动中…",
      welcomeEmpty: "◈ DSH Agent\n\n给 Agent 下达任务：描述目标、贴代码、提问都可以。\nAgent 会读文件、写代码、跑命令，并实时展示每一步。",
      ready: "就绪",
      exited: "宿主已退出",
      unknownState: "未知状态",
      session: (id) => `会话: ${id}…`,
      newSessionHint: "新会话（发送第一条消息后创建）",
      loadFailed: (e) => `加载失败：${e}`,
      resumed: (id) => `已恢复会话 ${id}…`,
      deleteFailed: (e) => `删除会话失败：${e}`,
      historyMainGroup: "主代理会话",
      historySubGroup: "子代理会话",
      rename: "重命名",
      renameTitle: "重命名会话标题",
      renameOk: "确定",
      renameCancel: "取消",
      renameFailed: (e) => `重命名失败：${e}`,
      exportTitle: "导出完整对话记录（浏览器打开，含全部思考与工具详情）",
      exportDisabledTitle: "尚无会话内容，发送第一条消息后可用",
      exporting: "正在导出完整对话记录…",
      exportingTitle: "正在导出完整对话记录，完成后恢复",
      exported: (p) => `已导出：${p}`,
      exportFailed: (e) => `导出失败：${e}`,
      noContent: "尚无对话内容：发送第一条消息后即可导出完整记录。",
      newSessionTitle: "新会话",
      compacting: "正在压缩上下文…",
      compacted: (t) => `✓ 已压缩：${t}`,
      compactFailed: (e) => `压缩失败：${e}`,
      compactTimeout: "压缩超时（宿主无响应），已恢复输入，请稍后重试",
      compactBusyTitle: "Agent 运行中，完成当前任务后才能压缩上下文",
      ctxTitle: (used, win) => `上下文占用 ${used} / ${win} tokens`,
      tokensInTitle: "累计输入 tokens（缓存未命中）",
      stepsTitle: "本会话累计AI调用次数（会话删除前始终累计）",
      copyTitle: "复制代码到剪贴板",
      copyLabel: "复制",
      tokensCacheTitle: "累计缓存读取 tokens",
      tokensOutTitle: "累计输出 tokens",
      modelSwitchFailed: "模型切换失败：",
      send: "发送",
      stop: "停止",
      stopTitle: "停止当前对话（丢弃未完成的内容，不新建会话）",
      dshNewVersionPre: "有新版 ",
      dshNewVersionPost: " 可用",
      dshUpgrade: "升级",
      dshIgnore: "忽略",
      dshDetails: "查看发布说明",
      dshUpgrading: (v) => `升级 ${v} 过程中…`,
    },
    en: {
      thinking: "Thinking",
      truncated: "\n… (truncated)",
      result: "── Result ──",
      done: "✓ Done",
      failed: "✗ Failed",
      approvalAsk: (name) => `Agent requests to call tool <strong>${name}</strong>`,
      approvalQueue: (n) => `⏳ Queue: ${n} pending approval(s) — handled one by one`,
      approvalAgent: (id) => `🧩 Subtask …${id} requests:`,
      emptyHistory: "No sessions yet",
      currentSession: " · current",
      resume: "▶ Resume",
      resumeTitle: "Reload this session and continue the conversation",
      view: "View",
      viewTitle: "Read-only: browse this subagent session history (does not become the host)",
      viewingSession: (id) => `Browsing subagent session ${id} (read-only; resume a real session to continue)`,
      viewFailed: "Failed to browse session — restored the original session",
      restoring: "Restoring session… (long sessions may take a few seconds)",
      restartingHint: "Restoring the previous session…",
      del: "🗑 Delete",
      delTitle: "Delete this session (cannot be undone)",
      confirmDel: "Confirm delete?",
      deleting: "Deleting session…",
      deleted: "Session deleted",
      deleteFailed: (e) => `Delete failed: ${e}`,
      loading: "Loading…",
      loadTimeout: "Load timed out: host did not respond. Click ⟳ to refresh or check the output channel.",
      loadTimeoutHint: "Load timed out: host is starting or not responding — click ⟳ to retry",
      cwdTitle: "Click to open the working directory in your file manager (agent files live here)",
      keyMissing: "⚠ API Key not configured — the agent cannot call the model",
      keyConfigBtn: "Configure now ⚙",
      notStarted: "Not started",
      starting: "Host starting…",
      welcomeEmpty: "◈ DSH Agent\n\nGive the agent a task: describe a goal, paste code, or ask a question.\nIt reads files, edits code, runs commands, and shows every step live.",
      ready: "Ready",
      exited: "Host exited",
      unknownState: "Unknown state",
      session: (id) => `Session: ${id}…`,
      newSessionHint: "New session (created on first message)",
      loadFailed: (e) => `Load failed: ${e}`,
      resumed: (id) => `Session resumed ${id}…`,
      deleteFailed: (e) => `Delete failed: ${e}`,
      historyMainGroup: "Main Agent Sessions",
      historySubGroup: "Subagent Sessions",
      rename: "Rename",
      renameTitle: "Rename session title",
      renameOk: "OK",
      renameCancel: "Cancel",
      renameFailed: (e) => `Rename failed: ${e}`,
      exportTitle: "Export full conversation (opens in browser, includes all reasoning & tool details)",
      exportDisabledTitle: "No session content yet — available after the first message",
      exporting: "Exporting full conversation…",
      exportingTitle: "Exporting full conversation — button re-enables when done",
      exported: (p) => `Exported: ${p}`,
      exportFailed: (e) => `Export failed: ${e}`,
      noContent: "No conversation yet: send the first message to enable export.",
      newSessionTitle: "New session",
      compacting: "Compacting context…",
      compacted: (t) => `✓ Compacted: ${t}`,
      compactFailed: (e) => `Compaction failed: ${e}`,
      compactTimeout: "Compaction timed out (host unresponsive); input restored — retry shortly",
      compactBusyTitle: "Agent is busy; compaction is available after the current task finishes",
      ctxTitle: (used, win) => `Context usage ${used} / ${win} tokens`,
      tokensInTitle: "Total input tokens (cache miss)",
      stepsTitle: "Total AI calls in this session (accumulates until the session is deleted)",
      copyTitle: "Copy code to clipboard",
      copyLabel: "Copy",
      tokensCacheTitle: "Total cache-read tokens",
      tokensOutTitle: "Total output tokens",
      modelSwitchFailed: "Model switch failed: ",
      send: "Send",
      stop: "Stop",
      stopTitle: "Stop the current conversation (discards unfinished output, keeps the session)",
      dshNewVersionPre: "New version ",
      dshNewVersionPost: " available",
      dshUpgrade: "Upgrade",
      dshIgnore: "Ignore",
      dshDetails: "View release notes",
      dshUpgrading: (v) => `Upgrading ${v}…`,
    },
  };

  let L = I18N.zh;
  function t(key, ...args) {
    const fn = L[key];
    return typeof fn === "function" ? fn(...args) : (fn ?? key);
  }

  /**
   * 设置提示信息（唯一入口）：composer 行的 ⓘ 图标（hover 显示完整信息）
   * + 同步到 VS Code 状态栏（面板行太窄，完整信息放状态栏）。
   * 传空字符串/undefined 时隐藏两处。
   */
  function setHint(text) {
    const value = text || "";
    hintEl.classList.toggle("hidden", !value);
    // 极简内联显示：ⓘ + 文本（超长自动省略号截断，hover 看完整信息）
    hintEl.textContent = value ? `ⓘ ${value}` : "";
    hintEl.title = value;
    vscode.postMessage({ t: "hint", text: value });
  }

  /* ---------------- 工具函数 ---------------- */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---- 顶栏 DSH 升级候选横幅（常驻显示，直到用户操作；不侵入右侧命令按钮区） ---- */
  const dshUpdateText = el("span", "", "");
  // 版本号即"详情"链接（点击打开新 DSH 版本特性页），替代独立的"详情"按钮
  const dshVersionLink = el("a", "dsh-update-link", "");
  const btnDshUpgrade = el("button", "btn", "");
  const btnDshIgnore = el("button", "btn", "");
  dshUpdateEl.append(dshUpdateText, btnDshUpgrade, btnDshIgnore);
  function renderDshUpdate(info) {
    const latest = info?.latest;
    const upgrading = info?.upgrading;
    if (!latest) {
      dshUpdateEl.classList.add("hidden");
      return;
    }
    dshUpdateEl.classList.remove("hidden");
    if (upgrading) {
      // 升级中：隐藏按钮，仅显示进度文案
      dshUpdateText.textContent = t("dshUpgrading", latest);
      btnDshUpgrade.classList.add("hidden");
      btnDshIgnore.classList.add("hidden");
    } else {
      dshUpdateText.textContent = "";
      dshVersionLink.textContent = latest;
      dshVersionLink.title = t("dshDetails");
      dshUpdateText.append(
        document.createTextNode(t("dshNewVersionPre")),
        dshVersionLink,
        document.createTextNode(t("dshNewVersionPost"))
      );
      btnDshUpgrade.textContent = t("dshUpgrade");
      btnDshIgnore.textContent = t("dshIgnore");
      btnDshUpgrade.classList.remove("hidden");
      btnDshIgnore.classList.remove("hidden");
    }
  }
  btnDshUpgrade.addEventListener("click", () => vscode.postMessage({ t: "dshUpgrade" }));
  btnDshIgnore.addEventListener("click", () => vscode.postMessage({ t: "dshIgnore" }));
  dshVersionLink.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ t: "dshDetails" });
  });

  /**
   * 智能滚动：滚动容器在底部时自动跟随最新输出；
   * 用户向上拉动后保持用户位置，滚回底部后恢复跟随。
   */
  function attachStickyScroll(el) {
    let stick = true;
    el.addEventListener("scroll", () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stick = near;
    });
    return () => {
      if (stick) el.scrollTop = el.scrollHeight;
    };
  }

  // 真正的滚动容器是 #messages（overflow-y: auto）；body 不滚动
  const scrollToBottom = attachStickyScroll(messagesEl);

  /** 空态占位：无消息时显示欢迎语；有消息时隐藏。 */
  function updateEmptyState() {
    const empty = $("emptyState");
    if (!empty) return;
    const hasContent = messagesEl.querySelector(".msg") !== null;
    empty.classList.toggle("hidden", hasContent);
    if (!hasContent) {
      const span = empty.querySelector("span");
      if (span) span.textContent = t("welcomeEmpty");
    }
  }

  /**
   * 向上滚动到顶部附近时加载更早的历史（分页）。
   * 防抖 + 防重入：加载期间忽略后续触发。
   */
  let historyScrollTimer = null;
  messagesEl.addEventListener("scroll", () => {
    if (state.historyMore?.hasMore && !state.historyLoadingMore && messagesEl.scrollTop < 120) {
      state.historyLoadingMore = true;
      clearTimeout(historyScrollTimer);
      historyScrollTimer = setTimeout(() => {
        // 只读浏览模式（子代理会话）分页需带 sessionId（宿主从持久化读取）
        vscode.postMessage({
          t: "loadMoreHistory",
          beforeSeq: state.historyMore.nextSeq,
          sessionId: state.viewSessionId || undefined,
        });
      }, 250);
    }
  });

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function truncate(s, max) {
    if (!s) return "";
    return s.length > max ? s.slice(0, max) + t("truncated") : s;
  }

  /* ---------------- 顶部信息栏（会话标题 / 上下文占比 / token 用量） ---------------- */

  /** 紧凑数字格式化：1234 → 1.2k，1234567 → 1.2m。 */
  function fmtNum(n) {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  /** 渲染顶部信息栏（单行）：上下文占比、token 用量（含缓存命中率）、压缩按钮。 */
  function renderStats(stats) {
    state.stats = stats;
    topbarEl.classList.remove("hidden");
    if (stats.title) {
      sessionTitleEl.textContent = stats.title;
      sessionTitleEl.title = stats.title;
    } else if (state.sessionId) {
      sessionTitleEl.textContent = t("session", state.sessionId.slice(0, 12));
      sessionTitleEl.title = "";
    } else {
      sessionTitleEl.textContent = t("newSessionTitle");
      sessionTitleEl.title = "";
    }

    // 上下文占比：最近一次请求输入（含缓存读取）占上下文窗口的百分比
    if (stats.contextWindow && stats.lastRequestInput) {
      const pct = Math.min(100, (stats.lastRequestInput / stats.contextWindow) * 100);
      contextPctEl.textContent = `🧠 ${pct.toFixed(0)}%`;
      contextPctEl.title = t("ctxTitle", fmtNum(stats.lastRequestInput), fmtNum(stats.contextWindow));
      contextPctEl.classList.toggle("warn", pct > 70);
    } else {
      contextPctEl.textContent = "🧠 —";
      contextPctEl.title = "";
      contextPctEl.classList.remove("warn");
    }

    // token 用量（与上下文同一行）：有统计才显示
    const hasTokens = stats.inputTokens > 0 || stats.cacheReadTokens > 0 || stats.outputTokens > 0 || (stats.steps ?? 0) > 0;
    topbarEl.classList.toggle("has-tokens", hasTokens);
    // API 调用次数（step，对应 dsh web）：显示在输入 token 前面
    stepsEl.textContent = `🔄 ${fmtNum(stats.steps ?? 0)}`;
    stepsEl.title = t("stepsTitle");
    tokensInEl.textContent = `↗ ${fmtNum(stats.inputTokens)}`;
    tokensInEl.title = t("tokensInTitle");
    // 缓存命中率 = 缓存读取 / (未命中输入 + 缓存读取)，括号内百分比显示
    const denominator = stats.inputTokens + stats.cacheReadTokens;
    const hitRate = denominator > 0 ? (stats.cacheReadTokens / denominator) * 100 : null;
    tokensCacheEl.textContent = hitRate === null
      ? `⇄ ${fmtNum(stats.cacheReadTokens)}`
      : `⇄ ${fmtNum(stats.cacheReadTokens)} (${hitRate.toFixed(0)}%)`;
    // hover 提示与显示数值保持一致：附上缓存命中率
    tokensCacheEl.title = hitRate === null
      ? t("tokensCacheTitle")
      : `${t("tokensCacheTitle")}（缓存命中率 ${hitRate.toFixed(0)}%）`;
    tokensOutEl.textContent = `↘ ${fmtNum(stats.outputTokens)}`;
    tokensOutEl.title = t("tokensOutTitle");
  }

  /** 思考等级选项（固定顺序：off → low → high → max；值一律小写，与内核一致）。 */
  const EFFORT_OPTIONS = ["off", "low", "high", "max"];

  /** 按提供商填充模型下拉（模型与提供商一一对应：只显示该提供商已配置的模型）。
   *  providerModels 条目为 {id, name}：下拉**显示名称**、值用 id（内部以 id 传递识别，
   *  与提供商下拉"显示名称、值用 id"的约定一致）。 */
  function fillModelDropdown(provider, currentModel) {
    selModel.innerHTML = "";
    const list = (state.providerModels && state.providerModels[provider]) || [];
    if (list.length === 0) {
      // 该提供商暂无模型目录：先放占位（与 selProvider change 的空列表行为一致），
      // 若当前模型真实存在，下方会以 "✦" 追加项保留可选
      const ph = el("option", "", "…");
      ph.value = "";
      selModel.appendChild(ph);
    } else {
      for (const m of list) {
        const opt = el("option", "", m.name || m.id);
        opt.value = m.id;
        selModel.appendChild(opt);
      }
    }
    if (currentModel && ![...selModel.options].some((o) => o.value === currentModel)) {
      const opt = el("option", "", currentModel + " ✦");
      opt.value = currentModel;
      selModel.appendChild(opt);
    }
    selModel.value = currentModel || selModel.options[0]?.value || "";
  }

  /** 填充模型/提供者下拉并同步当前选择（来自 host 的 modelInfo 帧）。 */
  function renderModelInfo(info) {
    state.providerModels = info.providerModels || {};
    if (!info) return;
    state.suppressSelectorEvents = true;
    // provider 下拉
    selProvider.innerHTML = "";
    const providers = info.providers.length > 0 ? info.providers : [{ id: "deepseek-official", name: "DeepSeek" }];
    for (const p of providers) {
      const opt = el("option", "", p.name || p.id);
      opt.value = p.id;
      selProvider.appendChild(opt);
    }
    selProvider.value = info.current.provider || providers[0].id;
    // model 下拉：按当前选中提供商过滤（只显示该提供商的模型）
    fillModelDropdown(selProvider.value, info.current.model);
    // 思考等级：按 off/low/high/max 固定顺序渲染 4 档，值/显示均小写。
    // host 返回的 supportedEfforts 为插件语义层四档（low 由宿主映射为 high，
    // 不会触发内核 UNSUPPORTED 报错），故四档均可选。
    const supported = info.current.supportedEfforts;
    selEffort.innerHTML = "";
    for (const effort of EFFORT_OPTIONS) {
      const opt = el("option", "", effort);
      opt.value = effort;
      if (supported && !supported.includes(effort)) {
        opt.disabled = true;
        opt.textContent = `${effort}（不支持）`;
      }
      selEffort.appendChild(opt);
    }
    // 默认值优先级：当前已选 effort > 内核/提供商默认（如 DeepSeek 的 high）> high。
    // 修复：下拉重建后不能停留在首个选项（off=关闭思考），否则"思考级别像没起作用"。
    const effort = info.current.reasoningEffort || info.current.defaultEffort || "high";
    selEffort.value = effort;
    if (!selEffort.value || selEffort.selectedIndex < 0) {
      selEffort.value = supported && supported.includes("high") ? "high" : (supported?.[0] ?? "high");
    }
    state.suppressSelectorEvents = false;
  }

  /** 模型切换完成后的回执（host 确认后同步下拉显示；error 时提示用户）。 */
  function renderModelChanged(info) {
    state.suppressSelectorEvents = true;
    if (info.error) {
      addErrorMessage(`${t("modelSwitchFailed", "")}${info.error}`);
      // 回退到之前的可用值
      if (info.provider) selProvider.value = info.provider;
      if (info.model) {
        let found = false;
        for (const opt of selModel.options) {
          if (opt.value === info.model) {
            found = true;
            break;
          }
        }
        if (found) selModel.value = info.model;
      }
      state.suppressSelectorEvents = false;
      return;
    }
    if (info.provider) selProvider.value = info.provider;
    if (info.model) {
      // 若新模型不在下拉中则追加（显示名称：优先从 providerModels 查，查不到用 id）
      let found = false;
      for (const opt of selModel.options) {
        if (opt.value === info.model) {
          found = true;
          break;
        }
      }
      if (!found) {
        const entry = (state.providerModels?.[info.provider] || []).find((m) => m.id === info.model);
        const opt = el("option", "", (entry && (entry.name || entry.id)) || info.model + " ✦");
        opt.value = info.model;
        selModel.appendChild(opt);
      }
      selModel.value = info.model;
    }
    if (info.reasoningEffort) selEffort.value = info.reasoningEffort;
    state.suppressSelectorEvents = false;
  }

  /** 轻量 Markdown 渲染：代码块（独立引用区+复制按钮）/ 行内代码 / 标题 / 粗体 / 列表 / 引用 / 表格 / 空行。 */
  function renderMarkdown(src) {
    if (!src) return "";
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let inCode = false;
    let codeLang = "";
    let codeBuf = [];
    // 列表渲染状态：栈记录每层列表类型（ul/ol）；按缩进嵌套
    let listStack = []; // {type, indent}
    let inQuote = false;

    const flushQuote = () => {
      if (inQuote) {
        out.push("</blockquote>");
        inQuote = false;
      }
    };

    /** 把代码块渲染为"独立引用区 + 语言标签 + 复制按钮"（需求：可一键复制执行）。 */
    const emitCodeBlock = () => {
      const lang = codeLang || "text";
      const codeId = `code-${codeSeq++}`;
      codeTexts.set(codeId, codeBuf.join("\n"));
      out.push(
        `<div class="codeblock">` +
          `<div class="codeblock-head"><span class="codeblock-lang">${escapeHtml(lang)}</span>` +
          `<button class="codeblock-copy" data-code="${codeId}" title="${t("copyTitle")}">⧉ ${t("copyLabel")}</button></div>` +
          `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>` +
          `</div>`
      );
      codeBuf = [];
    };

    while (i < lines.length) {
      const line = lines[i];
      const codeMatch = /^```(\w*)\s*$/.exec(line);
      if (codeMatch) {
        if (inCode) {
          emitCodeBlock();
          inCode = false;
        } else {
          flushListStack();
          flushQuote();
          inCode = true;
          codeLang = codeMatch[1];
        }
        i++;
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        i++;
        continue;
      }
      if (/^\s*$/.test(line)) {
        flushListStack();
        flushQuote();
        i++;
        continue;
      }
      // 表格：`| a | b |` 表头 + `|---|---|` 分隔行（支持 :--- 对齐）+ 数据行
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushListStack();
        flushQuote();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(lines[i].trim());
          i++;
        }
        if (rows.length >= 2 && /^\|[\s:|-]+\|$/.test(rows[1])) {
          out.push(renderTable(rows));
        } else {
          // 非表格（孤立管道行）：按普通段落回退
          for (const r of rows) out.push(`<p>${inlineMd(r)}</p>`);
        }
        continue;
      }
      // 列表：无序 `- ` / `* `，有序 `1. ` / `1) `；按缩进嵌套
      const listMatch = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line);
      if (listMatch) {
        flushQuote();
        const indent = listMatch[1].length;
        const isOl = /^\d/.test(listMatch[2]);
        const type = isOl ? "ol" : "ul";
        // 只弹出缩进比当前更深的层（缩进变浅时收尾）；
        // 同级层保留，由下方逻辑决定续行或切换类型。
        while (listStack.length > 0 && listStack[listStack.length - 1].indent > indent) {
          out.push(listStack.pop().type === "ol" ? "</ol>" : "</ul>");
        }
        // 同缩进但类型切换（如 ul 续行换成 ol）：弹出重开，保持正确闭合
        const top = listStack[listStack.length - 1];
        if (top && top.indent === indent && top.type !== type) {
          out.push(top.type === "ol" ? "</ol>" : "</ul>");
          listStack.pop();
        }
        // 缩进更深（或栈空）→ 开新嵌套列表
        if (listStack.length === 0 || listStack[listStack.length - 1].indent < indent) {
          out.push(isOl ? "<ol>" : "<ul>");
          listStack.push({ type, indent });
        }
        out.push(`<li>${inlineMd(listMatch[3])}</li>`);
        i++;
        continue;
      }
      flushListStack();
      const quoteMatch = /^>\s?(.*)$/.exec(line);
      if (quoteMatch) {
        if (!inQuote) {
          out.push("<blockquote>");
          inQuote = true;
        }
        out.push(`<p>${inlineMd(quoteMatch[1])}</p>`);
        i++;
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 4);
        out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
        i++;
        continue;
      }
      out.push(`<p>${inlineMd(line)}</p>`);
      i++;
    }
    flushListStack();
    flushQuote();
    if (inCode) {
      emitCodeBlock();
    }
    return out.join("\n");

    /** 渲染 markdown 表格（对齐按分隔行的冒号位置：`:---` 左、`---:` 右、`:---:` 中）。 */
    function renderTable(rows) {
      const parseRow = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const alignOf = (cell) => {
        const c = cell.replace(/\s/g, "");
        if (c.startsWith(":") && c.endsWith(":")) return "center";
        if (c.endsWith(":")) return "right";
        if (c.startsWith(":")) return "left";
        return "";
      };
      const headers = parseRow(rows[0]);
      const aligns = parseRow(rows[1]).map(alignOf);
      let html = `<div class="md-table-wrap"><table>`;
      html += `<thead><tr>${headers.map((h, idx) => `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inlineMd(h)}</th>`).join("")}</tr></thead>`;
      if (rows.length > 2) {
        html += `<tbody>`;
        for (const r of rows.slice(2)) {
          html += `<tr>${parseRow(r).map((c, idx) => `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inlineMd(c)}</td>`).join("")}</tr>`;
        }
        html += `</tbody>`;
      }
      html += `</table></div>`;
      return html;
    }

    function flushListStack() {
      while (listStack.length > 0) {
        out.push(listStack.pop().type === "ol" ? "</ol>" : "</ul>");
      }
    }
  }

  function inlineMd(s) {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return out;
  }

  /* ---------------- 消息渲染 ---------------- */

  /** 系统指令消息前缀（宿主 pre-step 注入的 [本轮指引]/[本步指引]/[达限警示]，
   *  模型在上下文中可见，但不应显示在对话界面）。 */
  const SYSTEM_DIRECTIVE_PREFIXES = [
    "[本轮指引]",
    "[本步指引]",
    "[达限警示]",
    "[Round guide]",
    "[Step guide]",
    "[Limit warning]",
  ];
  function isSystemDirective(text) {
    const t = String(text ?? "");
    return SYSTEM_DIRECTIVE_PREFIXES.some((p) => t.startsWith(p));
  }

  function addUserMessage(text) {
    // 系统指令（宿主自动注入）：模型可见、界面不渲染
    if (isSystemDirective(text)) return;
    const wrap = el("div", "msg user");
    const body = el("div", "bubble");
    body.innerHTML = renderMarkdown(text);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    updateEmptyState();
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const wrap = el("div", "msg error");
    const body = el("div", "bubble");
    body.innerHTML = renderMarkdown(text);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    updateEmptyState();
    scrollToBottom();
  }

  /**
   * 确保存在当前助手消息气泡。
   * @param {boolean} foldReasoning 历史重放时思考过程默认折叠（实时流式自动展开）
   */
  function ensureAssistant(foldReasoning) {
    if (state.currentAssistant) return state.currentAssistant;
    const wrap = el("div", "msg assistant");
    const body = el("div", "bubble");
    const reasoning = el("details", "reasoning hidden");
    const summary = el("summary", "");
    summary.textContent = t("thinking");
    const reasoningBody = el("div", "reasoning-body");
    reasoning.appendChild(summary);
    reasoning.appendChild(reasoningBody);
    if (!foldReasoning) reasoning.open = true;
    const textBody = el("div", "text-body");
    body.appendChild(reasoning);
    body.appendChild(textBody);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    const stickReasoning = attachStickyScroll(reasoningBody);
    state.currentAssistant = { wrap, body, textBody, reasoning, reasoningBody, stickReasoning };
    updateEmptyState();
    scrollToBottom();
    return state.currentAssistant;
  }

  /**
   * 流式渲染调度器（核心性能优化）。
   *
   * 旧的实现：每个 delta 都执行一次 `innerHTML = renderMarkdown(全部文本)`——
   * 模型高速输出（100+ tok/s）时每秒触发上百次 O(n) 全量 markdown 解析与 DOM
   * 重建，UI 线程被占满，事件积压，观感就是"一顿一顿分批输出"。
   *
   * 新的实现：
   * - delta 文本先以文本节点**即时廉价追加**（O(delta)，不阻塞 UI），
   *   保证"文字先出来"，链式流畅；
   * - markdown 全量格式化交给**间隔节流**（≥80ms 一次）执行，连续输出时
   *   渲染频率 ≤12.5 次/秒（Remote-SSH 下大幅减少每帧画面传输开销）。
   */
  let streamRenderRaf = null;
  let streamRenderTimer = null;
  let lastStreamRenderAt = 0;
  /** 全量 markdown 重渲染的最小间隔（ms）：模型高速输出时把渲染频率压到 ≤12.5 次/秒。 */
  const STREAM_RENDER_MIN_GAP_MS = 80;

  function scheduleStreamRender() {
    if (streamRenderTimer !== null) return; // 已调度
    const render = () => {
      streamRenderRaf = null;
      streamRenderTimer = null;
      flushStreamRender();
    };
    // 间隔节流：距上次渲染不足 80ms 时推迟到满 80ms 再执行。
    // 连续输出时文本仍以文本节点即时追加（先出字），全量 markdown 格式化
    // 低频执行——Remote-SSH 下每次全量 innerHTML 重建都会放大为可见延迟。
    const delay = Math.max(0, STREAM_RENDER_MIN_GAP_MS - (Date.now() - lastStreamRenderAt));
    streamRenderTimer = setTimeout(render, delay);
  }

  /** 立即执行一次全量 markdown 渲染（finalize / 切换气泡前调用，防丢尾部）。 */
  function flushStreamRender() {
    lastStreamRenderAt = Date.now();
    if (streamRenderRaf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(streamRenderRaf);
      streamRenderRaf = null;
    }
    if (streamRenderTimer !== null) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    const a = state.currentAssistant;
    if (!a || !state.streamText) return;
    a.textBody.innerHTML = renderMarkdown(state.streamText);
    a.streamNode = null; // 渲染后旧文本节点已销毁；后续 delta 会重建
    scrollToBottom();
  }

  function appendAssistantDelta(text, reasoning) {
    const a = ensureAssistant(false);
    if (reasoning) {
      // 思考链：纯文本追加（无 markdown 解析，本身廉价），即时显示
      a.reasoning.classList.remove("hidden");
      a.reasoning.open = true;
      a.reasoningBody.textContent += reasoning;
      a.stickReasoning();
    }
    if (text) {
      state.streamText += text;
      if (!a.streamNode) {
        a.streamNode = document.createTextNode("");
        a.textBody.appendChild(a.streamNode);
      }
      a.streamNode.textContent += text; // O(delta) 即时追加
      scheduleStreamRender(); // 节流执行全量 markdown 格式化
    }
    scrollToBottom();
  }

  function finalizeAssistant(text, reasoning, foldReasoning) {
    // 先冲刷未决的流式渲染（防止节流未触发时丢尾部），再进入最终态
    flushStreamRender();
    // 实时流中文本/思考已通过 delta 渲染；assistant/message 事件在 needFull=false
    // 时 text/reasoning 均为空，此时绝不能移除气泡。只有气泡确实无任何内容
    // （纯工具调用回合从未渲染）才移除。
    if (!text && !reasoning) {
      if (
        state.currentAssistant &&
        !state.currentAssistant.textBody.textContent.trim() &&
        !state.currentAssistant.reasoningBody.textContent.trim()
      ) {
        state.currentAssistant.wrap.remove();
      }
      state.currentAssistant = null;
      state.streamText = "";
      return;
    }
    const a = ensureAssistant(foldReasoning);
    if (reasoning) {
      a.reasoning.classList.remove("hidden");
      // 实时流式已通过 delta 累积完整思考，不覆盖；仅历史重放（无累积）时写入
      if (!a.reasoningBody.textContent) {
        a.reasoningBody.textContent = reasoning;
      }
      if (!foldReasoning) a.reasoning.open = true;
    }
    if (text) {
      a.textBody.innerHTML = renderMarkdown(text);
      // 防止历史遗留 hidden 状态（如上一轮修复前的会话渲染路径）
      a.textBody.classList.remove("hidden");
    } else if (!a.textBody.textContent.trim()) {
      // 确实没有文本内容（纯思考回合）：隐藏空的文本区，只保留思考过程。
      // 注意：实时流中文本已通过 delta 渲染进 textBody，此时 text 为空不代表无文本，
      // 只有当 textBody 本身为空时才隐藏，绝不能清空或隐藏已渲染的总结文本。
      a.textBody.classList.add("hidden");
    }
    state.currentAssistant = null;
    state.streamText = "";
    scrollToBottom();
  }

  /**
   * 工具调用：渲染为内联文本块（与普通消息同一条渲染路径，
   * 不依赖卡片折叠/交互，任何环境必定显示参数与结果）。
   */
  function addToolCall(callId, name, args) {
    const wrap = el("div", "msg tool-msg");
    const body = el("div", "bubble");
    const head = el("div", "tool-inline-head");
    head.textContent = `⚙ ${name}`;
    const pre = el("pre", "tool-inline-args");
    let pretty;
    try {
      pretty = JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      pretty = args;
    }
    pre.textContent = truncate(pretty, 2000);
    body.appendChild(head);
    body.appendChild(pre);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    wrap._dshCallId = callId;
    scrollToBottom();
    return wrap;
  }

  function resolveToolCard(callId, ok, text) {
    const wraps = messagesEl.querySelectorAll(".tool-msg");
    for (let idx = wraps.length - 1; idx >= 0; idx--) {
      const wrap = wraps[idx];
      if (wrap._dshCallId === callId) {
        const head = wrap.querySelector(".tool-inline-head");
        if (head) head.textContent = `⚙ ${head.textContent.replace(/^⚙ /, "")} ${ok ? t("done") : t("failed")}`;
        const body = wrap.querySelector(".bubble");
        const resultPre = el("pre", "tool-inline-result");
        resultPre.textContent = t("result") + "\n" + truncate(text, 4000);
        body.appendChild(resultPre);
        scrollToBottom();
        return;
      }
    }
  }

  /* ---------------- 审批（面板内 modal 弹窗：唯一授权通道） ---------------- */
  // 多 agent 并发审批队列：approvals Map 保存全部未决请求，modal 显示最新一个；
  // 关闭当前时自动展示下一个——并发请求不会互相覆盖、不会丢失。

  function showApproval(id, toolName, reason, agentId) {
    state.approvals.set(id, { toolName, reason, agentId });
    renderApprovalModal();
  }

  /** 渲染 modal：显示最新一个未决审批，并在标题行提示队列数量。 */
  function renderApprovalModal() {
    const pending = [...state.approvals.entries()];
    if (pending.length === 0) {
      approvalEl.classList.add("hidden");
      state.pendingApprovalId = null;
      return;
    }
    const [id, a] = pending[pending.length - 1];
    state.pendingApprovalId = id;
    const body = $("approvalBody");
    body.innerHTML = "";
    // 队列提示（多 agent 并发时用户知道还有几个待处理）
    if (pending.length > 1) {
      body.appendChild(el("p", "approval-queue", t("approvalQueue", pending.length)));
    }
    // agent 标识（多 agent 场景：显示哪个子任务在请求授权）
    if (a.agentId) {
      body.appendChild(el("p", "approval-agent", t("approvalAgent", a.agentId)));
    }
    const p1 = el("p", "", "");
    // 该行内含 <strong> 标签，需 innerHTML 渲染（toolName 已转义，安全）
    p1.innerHTML = t("approvalAsk", escapeHtml(a.toolName));
    body.appendChild(p1);
    if (a.reason) {
      body.appendChild(el("p", "approval-reason", a.reason));
    }
    // 面板内居中 modal（遮罩 + 卡片，像子窗口；webview 保留上下文，
    // 窗口不活动时弹窗保持，切回即可处理——与 Kilo Code / DSH Web 一致）
    approvalEl.classList.remove("hidden");
    scrollToBottom();
  }

  /** 关闭指定审批；若关闭的是当前显示的，自动展示下一个未决审批。 */
  function hideApproval(id) {
    state.approvals.delete(id);
    if (state.pendingApprovalId === id) {
      renderApprovalModal();
    }
  }

  btnAllow.addEventListener("click", () => {
    if (state.pendingApprovalId !== null) {
      vscode.postMessage({ t: "approval:resolve", id: state.pendingApprovalId, approve: true });
      hideApproval(state.pendingApprovalId);
    }
  });
  btnDeny.addEventListener("click", () => {
    if (state.pendingApprovalId !== null) {
      vscode.postMessage({ t: "approval:resolve", id: state.pendingApprovalId, approve: false });
      hideApproval(state.pendingApprovalId);
    }
  });

  /* ---------------- 会话重命名（触发行下方就近内联输入条） ---------------- */
  let renameSessionId = null;
  let renameInlineEl = null;

  /** 关闭当前重命名输入条（幂等）。 */
  function closeRenameInline() {
    if (renameInlineEl !== null) {
      renameInlineEl.remove();
      renameInlineEl = null;
    }
    renameSessionId = null;
  }

  /** 在历史会话行下方就近展开重命名输入条（预填当前标题；确定后发送 renameSession）。 */
  function openRenameInline(rowEl, sessionId, currentTitle) {
    closeRenameInline();
    renameSessionId = sessionId;
    const box = el("div", "rename-inline");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rename-inline-input";
    input.value = currentTitle || "";
    input.maxLength = 200;
    input.spellcheck = false;
    const btnOk = el("button", "hbtn", t("renameOk"));
    const btnCancel = el("button", "hbtn", t("renameCancel"));
    const submit = () => {
      const title = input.value.trim();
      if (renameSessionId === null || title === "") return;
      const id = renameSessionId;
      closeRenameInline();
      vscode.postMessage({ t: "renameSession", id, title });
    };
    btnOk.addEventListener("click", submit);
    btnCancel.addEventListener("click", closeRenameInline);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        closeRenameInline();
      }
    });
    box.append(input, btnOk, btnCancel);
    rowEl.after(box);
    renameInlineEl = box;
    input.focus();
    input.select();
  }

  /* ---------------- 状态 ---------------- */

  /** 压缩按钮的常规标题（运行中/压缩中会临时替换）。 */
  const compactTitleText = btnCompact.title;

  /**
   * 发送/停止/压缩按钮状态。发送与停止共用同一按钮（互斥两面）：
   *  - 运行中 → 变红色"停止"（可用，点击立即中断当前对话）；
   *  - 空闲 → 蓝色"发送"；
   *  - 压缩中/恢复历史中 → 禁用（发送会与压缩/历史重放冲突）。
   */
  function updateButtons() {
    const running = state.running;
    const locked = state.compacting || state.resuming || state.viewSessionId !== null;
    btnSend.classList.toggle("stop", running);
    btnSend.textContent = running ? t("stop") : t("send");
    btnSend.title = running ? t("stopTitle") : "";
    btnSend.disabled = locked; // 运行中不禁用：按钮要能随时点击"停止"
    btnCompact.disabled = running || locked;
    btnCompact.title = running ? t("compactBusyTitle") : compactTitleText;
    // 浏览模式/压缩/恢复历史中：模型参数四个下拉与"发送"同步禁用，
    // 避免只读浏览时还能改动模型（改动无意义且会被后续帧覆盖）
    selProvider.disabled = locked;
    selModel.disabled = locked;
    selEffort.disabled = locked;
    selWorkMode.disabled = locked;
  }

  function setStatus(status) {
    state.running = status === "running";
    updateButtons();
  }

  /* ---------------- 消息入口 ---------------- */

  const configBanner = $("configBanner");
  const historyPanel = $("historyPanel");
  const historyList = $("historyList");
  let confirmDeleteId = null;

  /** 渲染一个会话行（主/子代理共用；仅行内容不同，操作一致）。 */
  function renderSessionRow(s) {
    const row = el("div", "history-item");
    const main = el("div", "history-main");
    const title = el("div", "history-name", s.title || s.id.slice(0, 18) + "…");
    const meta = el("div", "history-meta");
    const when = new Date(s.updatedAt || s.createdAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const cwdShort = s.cwd ? s.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/") : "";
    // 子代理会话附模型标识（便于辨认）；主代理同前
    const modelShort = s.model ? ` · ${s.provider || ""}/${s.model}` : "";
    meta.textContent = `${when}${s.live ? t("currentSession") : ""}${modelShort}${cwdShort ? " · " + cwdShort : ""}`;
    main.appendChild(title);
    main.appendChild(meta);
    const actions = el("div", "history-actions");
    // 子代理会话：只读浏览（不创建 agent、不成为对话宿主），主代理会话：继续
    const isSub = s.kind === "sub";
    const btnResume = el("button", "hbtn resume", isSub ? t("view") : t("resume"));
    btnResume.title = isSub ? t("viewTitle") : t("resumeTitle");
    btnResume.addEventListener("click", () => {
      // 切换会话：点击瞬间立即清空旧会话消息区（不等 history 帧到达），
      // 建立明确的"切换会话"观感；history 帧到达后再渲染选定会话的历史。
      // （history 帧处理里还会幂等地再清一次，双保险）
      flushStreamRender();
      messagesEl.innerHTML = "";
      state.currentAssistant = null;
      state.streamText = "";
      state.discardPending = false;
      state.historyMore = null;
      state.historyLoadingMore = false;
      // 恢复期间锁定发送：history 帧到达（渲染完成）前，若用户发送消息，
      // 本地渲染的用户消息会被 history 帧的 messagesEl.innerHTML = "" 清空，
      // 造成"用户消息消失、应答在前"的错乱。锁定后等历史渲染完成再解锁。
      state.resuming = true;
      updateButtons();
      // 兜底：宿主异常（history 帧迟迟不到）时 15 秒后自动解锁，防止发送被永久禁用
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        if (state.resuming) {
          state.resuming = false;
          updateButtons();
        }
      }, 15000);
      if (isSub) {
        vscode.postMessage({ t: "viewSession", id: s.id });
      } else {
        vscode.postMessage({ t: "resumeSession", id: s.id });
      }
      historyPanel.classList.add("hidden");
      setHint(t("restoring"));
      updateEmptyState();
    });
    const btnRename = el("button", "hbtn rename", t("rename"));
    btnRename.title = t("renameTitle");
    btnRename.addEventListener("click", () => {
      // 在触发行下方就近展开输入条（webview 不支持 window.prompt）
      openRenameInline(row, s.id, s.title || "");
    });
    const btnDelete = el("button", "hbtn delete", t("del"));
    btnDelete.title = t("delTitle");
    btnDelete.addEventListener("click", () => {
      if (confirmDeleteId === s.id) {
        confirmDeleteId = null;
        // **乐观移除**：确认后立即清除该行（删除在后台进行，结果状态栏提示）——
        // 避免删除耗时期间列表仍显示、用户误以为没删而重复点击。
        row.remove();
        setHint(t("deleting"));
        vscode.postMessage({ t: "deleteSession", id: s.id });
      } else {
        confirmDeleteId = s.id;
        btnDelete.textContent = t("confirmDel");
        btnDelete.classList.add("confirming");
        setTimeout(() => {
          if (confirmDeleteId === s.id) {
            confirmDeleteId = null;
            btnDelete.textContent = t("del");
            btnDelete.classList.remove("confirming");
          }
        }, 3000);
      }
    });
    actions.appendChild(btnResume);
    actions.appendChild(btnRename);
    actions.appendChild(btnDelete);
    row.appendChild(main);
    row.appendChild(actions);
    return row;
  }

  /**
   * 渲染历史会话列表：分两组展示——主代理会话与子代理会话，各自按
   * 更新时间排序（新的在上），同方式管理（继续/重命名/删除）。
   */
  function renderHistory(list) {
    historyList.innerHTML = "";
    if (!list || list.length === 0) {
      historyList.appendChild(el("div", "history-empty", t("emptyHistory")));
      return;
    }
    const sortByUpdated = (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    const mainSessions = list.filter((s) => s.kind !== "sub").sort(sortByUpdated);
    const subSessions = list.filter((s) => s.kind === "sub").sort(sortByUpdated);

    const appendGroup = (titleText, sessions) => {
      if (sessions.length === 0) return;
      const head = el("div", "history-group-title", titleText);
      historyList.appendChild(head);
      for (const s of sessions) {
        historyList.appendChild(renderSessionRow(s));
      }
    };

    appendGroup(t("historyMainGroup"), mainSessions);
    appendGroup(t("historySubGroup"), subSessions);
  }

  let historyLoadTimer = null;
  let historyRetryTimer = null;

  function openHistory() {
    confirmDeleteId = null;
    closeRenameInline();
    historyPanel.classList.remove("hidden");
    historyList.innerHTML = "";
    historyList.appendChild(el("div", "history-empty", t("loading")));
    // 注意：必须发 historyRefresh（扩展侧只处理该消息；旧 history 消息已废弃
    // 无人处理，曾导致列表卡"加载中"直到 3 秒重试兜底）
    vscode.postMessage({ t: "historyRefresh" });
    // 兜底：15 秒未收到结果则提示失败，避免永远"加载中"
    clearTimeout(historyLoadTimer);
    historyLoadTimer = setTimeout(() => {
      const empty = historyList.querySelector(".history-empty");
      if (empty && empty.textContent === t("loading")) {
        empty.textContent = t("loadTimeoutHint");
      }
    }, 15000);
    // 防丢帧：3 秒仍未收到列表则自动重试一次
    clearTimeout(historyRetryTimer);
    historyRetryTimer = setTimeout(() => {
      const empty = historyList.querySelector(".history-empty");
      if (empty && empty.textContent === t("loading")) {
        vscode.postMessage({ t: "historyRefresh" });
      }
    }, 3000);
  }

  function closeHistory() {
    historyPanel.classList.add("hidden");
  }

  function renderConfig(msg) {
    // 模型已由底部下拉展示（modelInfo 帧同步），无需在顶部重复显示
    // 工作目录不再在 hint 区显示（顶部已有"打开工作目录"图标按钮）
    setHint("");
    // API Key 未配置时显示引导条
    if (!msg.keyConfigured) {
      configBanner.classList.remove("hidden");
      configBanner.innerHTML =
        '<span>⚠ API Key 未配置，Agent 无法调用模型</span><button class="btn banner-btn" id="btnBannerConfig">立即配置 ⚙</button>';
      $("btnBannerConfig").addEventListener("click", () => vscode.postMessage({ t: "configure" }));
    } else {
      configBanner.classList.add("hidden");
    }
  }

  function renderHostState(state) {
    // 过渡性状态提示作用不大，保持简洁：启动/就绪均不干扰界面
  }

  /** 处理单个视图事件（实时流与历史重放共用；历史重放时思考默认折叠）。 */
  function handleViewEvent(e, opts) {
    const foldReasoning = Boolean(opts && opts.foldReasoning);
    switch (e.kind) {
      case "user":
        addUserMessage(e.text);
        break;
      case "assistant-delta":
        // 停止后的残留增量一律丢弃（未接收完的输出不再渲染）
        if (state.discardPending) break;
        appendAssistantDelta(e.text, e.reasoning);
        break;
      case "assistant":
        // 停止后内核回发的收尾消息：丢弃（消费标志），不重建气泡
        if (state.discardPending) {
          state.discardPending = false;
          break;
        }
        finalizeAssistant(e.text, e.reasoning, foldReasoning);
        break;
      case "error":
        addErrorMessage(e.text);
        break;
      case "tool-call": {
        const wrap = addToolCall(e.callId, e.name, e.args);
        wrap._dshCallId = e.callId;
        break;
      }
      case "tool-result":
        resolveToolCard(e.callId, e.ok, e.text);
        break;
      case "turn":
        // 新一轮开始：冲刷上一轮未决的流式渲染，重置累积文本，防止串轮；
        // 同时清除"停止后丢弃"标志——新一轮（用户重新发送）正常渲染。
        if (e.status === "start") {
          flushStreamRender();
          state.streamText = "";
          state.discardPending = false;
        }
        break;
    }
  }

  function onMessage(msg) {
    switch (msg.t) {
      case "bootstrap": {
        // 语言跟随 VS Code 界面语言
        L = msg.locale === "en" ? I18N.en : I18N.zh;
        // 切换真实会话（继续/新会话）：退出子代理只读浏览模式
        if (state.viewSessionId !== null && msg.sessionId !== state.viewSessionId) {
          state.viewSessionId = null;
          updateButtons();
        }
        const isNewEmpty = !msg.sessionId && Boolean(state.sessionId);
        if (isNewEmpty) {
          // 切到"新会话"（有旧会话 -> 空会话）：清空消息区与顶部统计，
          // 重建"新会话"观感（后续新对话从空白开始追加）。
          // 注意 resume 方向（空 -> 有 id）不能清：history 帧先渲染历史，
          // ready/bootstrap 后到，此时清空会抹掉刚加载的历史。
          flushStreamRender();
          state.currentAssistant = null;
          state.streamText = "";
          state.discardPending = false;
          state.historyMore = null;
          state.historyLoadingMore = false;
          messagesEl.innerHTML = "";
          state.stats = null;
          sessionTitleEl.textContent = "";
          contextPctEl.textContent = "🧠 —";
          tokensInEl.textContent = "↗ 0";
          tokensCacheEl.textContent = "⇄ 0";
          tokensOutEl.textContent = "↘ 0";
        }
        state.sessionId = msg.sessionId || null;
        updateExportButton();
        // 顶部信息栏常显（Kilo Code 风格）：会话标题显示在顶栏（header 中）
        topbarEl.classList.remove("hidden");
        // DSH 运行时版本（logo 已含 "DSH"，此处仅版本号）
        dshVersionEl.textContent = msg.dshVersion || "";
        sessionTitleEl.textContent = msg.sessionId
          ? state.stats?.title || msg.sessionTitle || t("session", msg.sessionId.slice(0, 12))
          : t("newSessionTitle");
        sessionTitleEl.title = sessionTitleEl.textContent;
        setHint(
          msg.sessionId
            ? t("session", msg.sessionId.slice(0, 12))
            : msg.ready
              ? t("newSessionHint")
              : ""
        );
        // 空态始终欢迎语（由 updateEmptyState 维护），不做启动过渡提示
        updateEmptyState();
        break;
      }
      case "stats":
        renderStats(msg.stats);
        break;
      case "modelInfo":
        renderModelInfo(msg);
        break;
      case "dshUpdate":
        renderDshUpdate(msg);
        break;
      case "modelChanged":
        renderModelChanged(msg);
        break;
      case "workModeChanged":
        // 仅同步选择器状态，不再显示模式注释（保持界面简洁）
        state.suppressSelectorEvents = true;
        selWorkMode.value = msg.mode;
        state.suppressSelectorEvents = false;
        break;
      case "compactDone": {
        endCompacting();
        if (msg.ok) {
          // 压缩完成：宿主已推送刷新后的 stats（上下文占用 % 随之更新）
          setHint(t("compacted", msg.text ?? ""));
        } else {
          setHint("");
          addErrorMessage(t("compactFailed", msg.error ?? "unknown error"));
        }
        break;
      }
      case "config":
        renderConfig(msg);
        break;
      case "hostState":
        renderHostState(msg.state);
        break;
      case "restarting": {
        // 宿主即将重启并自动恢复原会话（配置变更 / VS Code Reload 场景）：
        // 锁定发送直到恢复完成（history 帧渲染后解锁）——防止"恢复期间发送的
        // 消息被 history 重放清空、且宿主误判无 agent 而新建会话"。
        state.resuming = true;
        updateButtons();
        setHint(t("restartingHint"));
        // 兜底：宿主迟迟未就绪/恢复失败时 15 秒后自动解锁，防止发送被永久禁用
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          if (state.resuming) {
            state.resuming = false;
            updateButtons();
          }
        }, 15000);
        break;
      }
      case "event": {
        handleViewEvent(msg.e);
        break;
      }
      case "sessions": {
        clearTimeout(historyLoadTimer);
        if (msg.error) {
          historyList.innerHTML = "";
          historyList.appendChild(el("div", "history-empty", t("loadFailed", msg.error)));
          break;
        }
        renderHistory(msg.list);
        break;
      }
      case "history": {
        // 恢复会话：清空当前消息区，重放最近一段历史（思考默认折叠）。
        // 分页：hasMore 时向上滚动加载更早消息。
        messagesEl.innerHTML = "";
        state.currentAssistant = null;
        state.streamText = "";
        state.discardPending = false; // 历史重放不继承"停止丢弃"状态
        state.historyMore = msg.hasMore ? { hasMore: true, nextSeq: msg.nextSeq } : null;
        state.historyLoadingMore = false;
        for (const e of msg.events) handleViewEvent(e, { foldReasoning: true });
        updateEmptyState();
        setHint(t("resumed", msg.sessionId.slice(0, 12)));
        // 历史渲染完成：解除恢复期间的发送锁定，此后用户消息在 AI 应答之前
        // 进入消息列表（消息渲染全部按 append 顺序，不会再被 history 清空）。
        state.resuming = false;
        clearTimeout(resumeTimer);
        updateButtons();
        scrollToBottom();
        break;
      }
      case "historyMore": {
        // 更早的历史：渲染到消息列表顶部（prepend），并保持当前滚动位置
        state.historyLoadingMore = false;
        if (!msg.events || msg.events.length === 0) {
          state.historyMore = null;
          break;
        }
        const anchor = messagesEl.firstChild;
        const prevHeight = messagesEl.scrollHeight;
        const prevScrollTop = messagesEl.scrollTop;
        // 渲染到临时容器，再整体插到列表顶部（保持事件顺序）
        const batch = document.createDocumentFragment();
        const realAppend = messagesEl.appendChild;
        messagesEl.appendChild = (node) => {
          batch.appendChild(node);
          return node;
        };
        for (const e of msg.events) handleViewEvent(e, { foldReasoning: true });
        messagesEl.appendChild = realAppend;
        messagesEl.insertBefore(batch, anchor);
        // 内容在顶部增长：滚动位置相应下移，用户看到的视口不变
        messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevHeight);
        state.historyMore = msg.hasMore ? { hasMore: true, nextSeq: msg.nextSeq } : null;
        break;
      }
      case "sessionDeleted": {
        closeRenameInline();
        // 删除结果仅状态栏提示（不弹框）；**不自动刷新列表**——行已乐观移除，
        // 刷新交给用户主动操作（避免幽灵行/多此一举）
        setHint(msg.ok ? t("deleted") : t("deleteFailed", msg.error ?? "unknown error"));
        break;
      }
      case "sessionRenamed": {
        closeRenameInline();
        if (msg.ok) {
          // 重命名成功：若当前会话就是被重命名的，同步顶部标题与 stats 缓存
          // （stats 帧可能用旧 title 覆盖回来），并刷新历史列表
          if (msg.id === state.sessionId && msg.title) {
            sessionTitleEl.textContent = msg.title;
            sessionTitleEl.title = msg.title;
            if (state.stats) state.stats = { ...state.stats, title: msg.title };
          }
          if (!historyPanel.classList.contains("hidden")) {
            vscode.postMessage({ t: "historyRefresh" });
          }
        } else {
          addErrorMessage(t("renameFailed", msg.error ?? "unknown error"));
        }
        break;
      }
      case "sessionTitleSynced": {
        // 内核自动标题同步（fallback 截断 / LLM 总结）：仅更新标题栏与列表，
        // 不打断正在进行的重命名输入（区别于 sessionRenamed 的 closeRenameInline）。
        if (msg.id === state.sessionId && msg.title) {
          sessionTitleEl.textContent = msg.title;
          sessionTitleEl.title = msg.title;
          if (state.stats) state.stats = { ...state.stats, title: msg.title };
        }
        if (!historyPanel.classList.contains("hidden")) {
          vscode.postMessage({ t: "historyRefresh" });
        }
        break;
      }
      case "sessionExported": {
        // 导出完成/失败：恢复导出按钮；结果只走提示区 + 状态栏（不弹框）
        if (state.exporting) {
          state.exporting = false;
          clearTimeout(exportTimer);
          updateExportButton();
          setHint(msg.ok ? t("exported", msg.path ?? "") : t("exportFailed", msg.error ?? "unknown error"));
        }
        break;
      }
      case "viewSession": {
        // 只读浏览模式（子代理会话）：history 帧已渲染历史，锁定发送；
        // 切换真实会话（ready 帧）时自动退出。
        state.viewSessionId = msg.id;
        state.resuming = false;
        updateButtons();
        setHint(t("viewingSession", msg.id.slice(0, 8)));
        break;
      }
      case "viewSessionFailed": {
        // 浏览会话失败（读不到该会话历史）：消息区已被清空且发送锁定，
        // 自动恢复原真实会话视图，避免空白+锁死（需手动"继续"才能回来）。
        const original = state.sessionId;
        state.viewSessionId = null;
        state.resuming = false;
        updateButtons();
        if (original) {
          vscode.postMessage({ t: "resumeSession", id: original });
          setHint(t("viewFailed"));
        } else {
          setHint("");
        }
        break;
      }
      case "approval":
        showApproval(msg.id, msg.toolName, msg.reason, msg.agentId);
        break;
      case "approvalResolved":
        // 只关闭对应 id 的审批（多 agent 并发时不会误关其他请求）
        hideApproval(msg.id);
        break;
      case "status":
        setStatus(msg.status);
        break;
      case "appendInput": {
        // Ctrl+K Ctrl+I 快捷引用：把扩展侧构造的引用文本追加到输入框（不发送）
        const text = typeof msg.text === "string" ? msg.text : "";
        if (!text) break;
        inputEl.value = inputEl.value ? inputEl.value + "\n" + text : text;
        autoResize();
        inputEl.focus();
        const len = inputEl.value.length;
        inputEl.setSelectionRange(len, len); // 光标移到末尾，等待用户编辑/回车
        break;
      }
      case "hostExit": {
        // 完全静默：宿主异常退出由扩展侧自动重启处理，不打扰用户。
        // 若重启失败，用户真正发消息/查历史时才在对应操作中看到友好提示。
        setStatus("idle");
        break;
      }
      case "setModel":
        // 模型已由底部下拉展示，顶部无需重复显示
        break;
    }
  }

  /* ---------------- 输入 ---------------- */

  function send() {
    const text = inputEl.value.trim();
    // resuming：会话历史恢复中，消息区即将被 history 帧重建，此时发送会
    // 造成"用户消息被清空/应答在前"的错乱——锁定直到历史渲染完成。
    if (!text || state.running || state.compacting || state.resuming) return;
    inputEl.value = "";
    autoResize();
    // 用户消息**先**同步渲染进消息列表（append），再通知扩展转发给宿主；
    // 之后 AI 应答事件按到达顺序追加在用户消息之后，顺序不会错乱。
    addUserMessage(text);
    vscode.postMessage({ t: "chat", text });
  }

  /**
   * 输入框自适应高度：默认 2 行，随内容增至最多 5 行，超出 5 行出现纵向滚动条。
   */
  function autoResize() {
    inputEl.style.height = "auto";
    const style = window.getComputedStyle(inputEl);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const padTop = parseFloat(style.paddingTop) || 8;
    const padBottom = parseFloat(style.paddingBottom) || 8;
    const twoLines = lineHeight * 2 + padTop + padBottom;
    const fiveLines = lineHeight * 5 + padTop + padBottom;
    const h = Math.min(Math.max(inputEl.scrollHeight, twoLines), fiveLines);
    inputEl.style.height = h + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > fiveLines ? "auto" : "hidden";
  }

  /** 导出按钮状态：有会话内容时有效，无会话内容（未加载）时灰色禁用；
   *  导出进行中禁用（防止重复点击造成多次导出）。
   *  浏览模式（viewSessionId）下导出目标即当前正在查看的子代理会话。 */
  function updateExportButton() {
    const target = state.viewSessionId || state.sessionId;
    const enabled = Boolean(target) && !state.exporting;
    btnExportFull.classList.toggle("disabled", !enabled);
    btnExportFull.title = state.exporting
      ? t("exportingTitle")
      : enabled
        ? t("exportTitle")
        : t("exportDisabledTitle");
  }

  inputEl.addEventListener("input", autoResize);
  inputEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  // 发送/停止共用同一按钮（互斥两面）：运行中点击 = 停止（立即中断、丢弃未完成
  // 输出、不新建会话），空闲点击 = 发送。
  btnSend.addEventListener("click", () => {
    if (state.running) {
      // 停止当前对话：立即丢弃未接收完的助手气泡，并丢弃随后到达的本轮收尾消息
      // （cancel 后内核可能仍回发一条 assistant/message 收尾帧，不应再渲染）
      flushStreamRender();
      if (state.currentAssistant) {
        state.currentAssistant.wrap.remove();
        state.currentAssistant = null;
        state.streamText = "";
      }
      state.discardPending = true;
      vscode.postMessage({ t: "stop" });
    } else {
      send();
    }
  });
  btnNew.addEventListener("click", () => {
    // 用户显式开新会话：解除"自动恢复原会话"的锁定
    state.resuming = false;
    updateButtons();
    vscode.postMessage({ t: "newSession" });
  });

  // 代码块复制按钮（事件委托）：点击复制对应代码文本到剪贴板
  messagesEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".codeblock-copy");
    if (!btn) return;
    const text = codeTexts.get(btn.getAttribute("data-code"));
    if (text === undefined) return;
    const done = () => {
      const old = btn.textContent;
      btn.textContent = "✓ 已复制";
      setTimeout(() => (btn.textContent = old), 1500);
    };
    const fail = () => {
      btn.textContent = "✗";
      setTimeout(() => (btn.textContent = t("copyLabel")), 1500);
    };
    // 优先 Clipboard API；webview 受限时回退 textarea + execCommand
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) ? done() : fail());
    } else {
      fallbackCopy(text) ? done() : fail();
    }
  });

  /** 剪贴板回退方案（webview 内可靠）。 */
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
  $("btnConfig").addEventListener("click", () => vscode.postMessage({ t: "configure" }));
  $("btnWorkspace").addEventListener("click", () => vscode.postMessage({ t: "openWorkspace" }));
  $("btnHistory").addEventListener("click", openHistory);
  $("btnHistoryRefresh").addEventListener("click", () => vscode.postMessage({ t: "historyRefresh" }));
  $("btnHistoryClose").addEventListener("click", closeHistory);
  // 导出当前会话完整记录（面板顶部图标；无会话内容时为灰色无效；
  // 导出进行中禁用并提示，避免重复点击造成重复导出工作）
  let exportTimer = null;
  btnExportFull.addEventListener("click", () => {
    // 导出当前会话：浏览模式下导出正在查看的子代理会话（与用户看到的对话一致）
    const target = state.viewSessionId || state.sessionId;
    if (!target || state.exporting) return;
    state.exporting = true;
    updateExportButton();
    setHint(t("exporting"));
    vscode.postMessage({ t: "exportSession", id: target });
    // 兜底：导出异常无回执时 30 秒后恢复按钮，防止永久禁用
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => {
      if (state.exporting) {
        state.exporting = false;
        updateExportButton();
        setHint("");
      }
    }, 30000);
  });

  /* ---------------- 模型选择器 / 压缩 ---------------- */

  function postSetModel(partial) {
    if (state.suppressSelectorEvents) return;
    vscode.postMessage({ t: "setModel", ...partial });
  }

  // 初始占位：宿主就绪前下拉显示"加载中…"，避免空下拉的突兀感
  if (selProvider.options.length === 0) {
    const ph = el("option", "", "…");
    ph.value = "";
    selProvider.appendChild(ph);
  }
  if (selModel.options.length === 0) {
    const ph = el("option", "", "加载中…");
    ph.value = "";
    selModel.appendChild(ph);
  }

  selProvider.addEventListener("change", () => {
    if (state.suppressSelectorEvents) return;
    // 切换提供商：模型下拉重渲染为该提供商的模型，并**强制选中该提供商模型列表
    // 第一项**（默认行为）——避免 model 停留在旧提供商的模型上造成 provider/model
    // 不匹配（如 zai-free + deepseek-v4-flash）。用户之后再明确选模型则跟随修改。
    const list = (state.providerModels && state.providerModels[selProvider.value]) || [];
    selModel.innerHTML = "";
    if (list.length === 0) {
      const opt = el("option", "", "…");
      opt.value = "";
      selModel.appendChild(opt);
    } else {
      for (const m of list) {
        const opt = el("option", "", m.name || m.id);
        opt.value = m.id;
        selModel.appendChild(opt);
      }
    }
    // 默认选中第一项（list 为空时 value 为 ""，postSetModel 发送 provider + 空 model，
    // 宿主会保留该 provider 的当前模型选择）
    selModel.value = list.length > 0 ? list[0].id : "";
    postSetModel({ provider: selProvider.value, model: selModel.value || undefined });
  });

  selModel.addEventListener("change", () => {
    if (state.suppressSelectorEvents) return;
    const provider = selProvider.value || undefined;
    postSetModel({ provider, model: selModel.value });
  });

  selEffort.addEventListener("change", () => {
    if (state.suppressSelectorEvents) return;
    postSetModel({ reasoningEffort: selEffort.value || undefined });
  });

  selWorkMode.addEventListener("change", () => {
    if (state.suppressSelectorEvents) return;
    vscode.postMessage({ t: "setWorkMode", mode: selWorkMode.value === "multi" ? "multi" : "single" });
  });

  /* 压缩（/compact）：进行中禁用发送按钮（防止与压缩冲突），完成后刷新上下文占用。 */
  let compactWatchdog = null;

  /** 结束压缩状态：恢复按钮，清理兜底定时器（幂等）。 */
  function endCompacting() {
    clearTimeout(compactWatchdog);
    if (!state.compacting) return;
    state.compacting = false;
    updateButtons();
  }

  btnCompact.addEventListener("click", () => {
    if (state.compacting || state.running) return;
    if (!state.sessionId) {
      addErrorMessage(t("noContent"));
      return;
    }
    state.compacting = true;
    updateButtons();
    setHint(t("compacting"));
    vscode.postMessage({ t: "compact" });
    // 兜底：压缩长时间无响应时恢复输入，防止发送按钮被永久禁用
    clearTimeout(compactWatchdog);
    compactWatchdog = setTimeout(() => {
      if (!state.compacting) return;
      endCompacting();
      setHint("");
      addErrorMessage(t("compactTimeout"));
    }, 60000);
  });
  updateExportButton();
  // 初始空态：bootstrap 到达前先显示欢迎语（语言随 bootstrap 校正）
  updateEmptyState();

  window.addEventListener("message", (ev) => onMessage(ev.data));

  // 视图就绪握手
  vscode.postMessage({ t: "ready" });
})();
