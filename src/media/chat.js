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
  const btnStop = $("btnStop");
  const btnNew = $("btnNew");
  const hintEl = $("hint");
  const btnExportFull = $("btnExportFull");
  const topbarEl = $("topbar");
  const sessionTitleEl = $("sessionTitle");
  const costStatsEl = $("costStats");
  const contextPctEl = $("contextPct");
  const tokensInEl = $("tokensIn");
  const tokensCacheEl = $("tokensCache");
  const tokensOutEl = $("tokensOut");
  const btnCompact = $("btnCompact");
  const selProvider = $("selProvider");
  const selModel = $("selModel");
  const selEffort = $("selEffort");
  const selWorkMode = $("selWorkMode");

  // DeepSeek 官方价格（USD / 1M tokens；仅对已知模型计价，未知模型显示"—"）
  const PRICES = {
    "deepseek-chat": { input: 0.27, cache: 0.07, output: 1.1 },
    "deepseek-reasoner": { input: 0.55, cache: 0.14, output: 2.19 },
    "deepseek-v4-flash": { input: 0.27, cache: 0.07, output: 1.1 },
    "deepseek-v4-pro": { input: 0.55, cache: 0.14, output: 2.19 },
  };

  const state = {
    running: false,
    approvals: new Map(), // id -> {toolName, reason}
    currentAssistant: null, // 当前正在流式输出的助手消息元素
    currentReasoning: null,
    pendingApprovalId: null,
    sessionId: null, // 当前会话 id（bootstrap 时更新）
    stats: null, // 最近一次会话统计
    modelInfo: null, // provider/model 目录 + 当前选择
    suppressSelectorEvents: false, // 填充下拉时抑制 change 事件
    historyMore: null, // {hasMore, nextSeq} 分页状态
    historyLoadingMore: false, // 正在加载更早历史（防重入）
  };

  /* ---------------- 国际化（跟随 VS Code 语言） ---------------- */

  const I18N = {
    zh: {
      thinking: "思考过程",
      truncated: "\n…（已截断）",
      result: "── 结果 ──",
      done: "✓ 完成",
      failed: "✗ 失败",
      approvalAsk: (name) => `Agent 请求调用工具 <strong>${name}</strong>`,
      emptyHistory: "暂无历史会话",
      currentSession: " · 当前会话",
      resume: "▶ 继续",
      resumeTitle: "重新加载此会话并继续对话",
      restoring: "正在恢复会话…",
      del: "🗑 删除",
      delTitle: "删除此会话（不可恢复）",
      confirmDel: "确认删除？",
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
      exited: "宿主已退出",      unknownState: "未知状态",
      session: (id) => `会话: ${id}…`,
      newSessionHint: "新会话（发送第一条消息后创建）",
      loadFailed: (e) => `加载失败：${e}`,
      resumed: (id) => `已恢复会话 ${id}…`,
      deleteFailed: (e) => `删除会话失败：${e}`,
      exportTitle: "导出完整对话记录（浏览器打开，含全部思考与工具详情）",
      exportDisabledTitle: "尚无会话内容，发送第一条消息后可用",
      noContent: "尚无对话内容：发送第一条消息后即可导出完整记录。",
      newSessionTitle: "新会话",
      compacting: "正在压缩上下文…",
      compacted: (t) => `✓ 已压缩：${t}`,
      compactFailed: (e) => `压缩失败：${e}`,
      costTitle: (m) => `估算费用（${m || "—"}，仅供参考）`,
      ctxTitle: (used, win) => `上下文占用 ${used} / ${win} tokens`,
      tokensInTitle: "累计输入 tokens（缓存未命中）",
      tokensCacheTitle: "累计缓存读取 tokens",
      tokensOutTitle: "累计输出 tokens",
      modelSwitchFailed: "模型切换失败：",
    },
    en: {
      thinking: "Thinking",
      truncated: "\n… (truncated)",
      result: "── Result ──",
      done: "✓ Done",
      failed: "✗ Failed",
      approvalAsk: (name) => `Agent requests to call tool <strong>${name}</strong>`,
      emptyHistory: "No sessions yet",
      currentSession: " · current",
      resume: "▶ Resume",
      resumeTitle: "Reload this session and continue the conversation",
      restoring: "Restoring session…",
      del: "🗑 Delete",
      delTitle: "Delete this session (cannot be undone)",
      confirmDel: "Confirm delete?",
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
      exportTitle: "Export full conversation (opens in browser, includes all reasoning & tool details)",
      exportDisabledTitle: "No session content yet — available after the first message",
      noContent: "No conversation yet: send the first message to enable export.",
      newSessionTitle: "New session",
      compacting: "Compacting context…",
      compacted: (t) => `✓ Compacted: ${t}`,
      compactFailed: (e) => `Compaction failed: ${e}`,
      costTitle: (m) => `Estimated cost (${m || "—"}, approximate)`,
      ctxTitle: (used, win) => `Context usage ${used} / ${win} tokens`,
      tokensInTitle: "Total input tokens (cache miss)",
      tokensCacheTitle: "Total cache-read tokens",
      tokensOutTitle: "Total output tokens",
      modelSwitchFailed: "Model switch failed: ",
    },
  };

  let L = I18N.zh;
  function t(key, ...args) {
    const fn = L[key];
    return typeof fn === "function" ? fn(...args) : (fn ?? key);
  }

  /* ---------------- 工具函数 ---------------- */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

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
        vscode.postMessage({ t: "loadMoreHistory", beforeSeq: state.historyMore.nextSeq });
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

  /* ---------------- 顶部信息栏（会话标题 / 费用 / 上下文占比 / token 用量） ---------------- */

  /** 紧凑数字格式化：1234 → 1.2k，1234567 → 1.2m。 */
  function fmtNum(n) {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function fmtCost(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
    if (usd < 0.01) return "<$0.01";
    return "$" + usd.toFixed(2);
  }

  /**
   * 根据模型名取价格表。
   * @returns 价格对象，或 null（模型不在表内 → 价格未知，不计价、不估算）。
   */
  function priceFor(model) {
    const key = (model || "").toLowerCase();
    for (const name of Object.keys(PRICES)) {
      if (key.includes(name)) return PRICES[name];
    }
    return null;
  }

  /** 渲染顶部信息栏（单行）：估算费用、上下文占比、token 用量（含缓存命中率）、压缩按钮。 */
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

    // 估算费用：仅当模型价格已知时才计算；未知模型显示"—"（不给错误数值）
    const price = priceFor(stats.model);
    if (price) {
      const cost =
        (stats.inputTokens / 1e6) * price.input +
        (stats.cacheReadTokens / 1e6) * price.cache +
        (stats.outputTokens / 1e6) * price.output;
      costStatsEl.textContent = fmtCost(cost);
      costStatsEl.title = t("costTitle", stats.model || "");
    } else {
      costStatsEl.textContent = "—";
      costStatsEl.title = stats.model ? `价格未知（${stats.model}）` : "价格未知";
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

    // token 用量（与费用/上下文同一行）：有统计才显示
    const hasTokens = stats.inputTokens > 0 || stats.cacheReadTokens > 0 || stats.outputTokens > 0;
    topbarEl.classList.toggle("has-tokens", hasTokens);
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

  /** 思考等级选项（固定顺序：off → low → high → max）。 */
  const EFFORT_OPTIONS = ["off", "low", "high", "max"];

  /** 填充模型/提供者下拉并同步当前选择（来自 host 的 modelInfo 帧）。 */
  function renderModelInfo(info) {
    state.modelInfo = info;
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
    // model 下拉
    selModel.innerHTML = "";
    const models = info.models.length > 0 ? info.models : [info.current.model || "deepseek-chat"];
    for (const m of models) {
      const opt = el("option", "", m);
      opt.value = m;
      selModel.appendChild(opt);
    }
    if (info.current.model && !models.includes(info.current.model)) {
      const opt = el("option", "", info.current.model + " ✦");
      opt.value = info.current.model;
      selModel.appendChild(opt);
    }
    selModel.value = info.current.model || "";
    // 思考等级：按 off/low/high/max 固定顺序渲染 4 档；
    // 模型不支持的档位禁用并标注（能力来自 host 的 resolveModel，真实反映模型能力）
    const supported = info.current.supportedEfforts;
    selEffort.innerHTML = "";
    for (const effort of EFFORT_OPTIONS) {
      const opt = el("option", "", effort.toUpperCase());
      opt.value = effort;
      if (supported && !supported.includes(effort)) {
        opt.disabled = true;
        opt.textContent = `${effort.toUpperCase()}（不支持）`;
      }
      selEffort.appendChild(opt);
    }
    if (info.current.reasoningEffort) selEffort.value = info.current.reasoningEffort;
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
      if (info.reasoningEffort && !info.error) selEffort.value = info.reasoningEffort;
      state.suppressSelectorEvents = false;
      return;
    }
    if (info.provider) selProvider.value = info.provider;
    if (info.model) {
      // 若新模型不在下拉中则追加
      let found = false;
      for (const opt of selModel.options) {
        if (opt.value === info.model) {
          found = true;
          break;
        }
      }
      if (!found) {
        const opt = el("option", "", info.model + " ✦");
        opt.value = info.model;
        selModel.appendChild(opt);
      }
      selModel.value = info.model;
    }
    if (info.reasoningEffort) selEffort.value = info.reasoningEffort;
    state.suppressSelectorEvents = false;
  }

  /** 轻量 Markdown 渲染：代码块 / 行内代码 / 标题 / 粗体 / 列表 / 引用 / 空行。 */
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

    while (i < lines.length) {
      const line = lines[i];
      const codeMatch = /^```(\w*)\s*$/.exec(line);
      if (codeMatch) {
        if (inCode) {
          out.push(
            `<pre><code class="lang-${escapeHtml(codeLang || "text")}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`
          );
          codeBuf = [];
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
      out.push(`<pre><code class="lang-${escapeHtml(codeLang || "text")}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
    }
    return out.join("\n");

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

  function addUserMessage(text) {
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

  function appendAssistantDelta(text, reasoning) {
    const a = ensureAssistant(false);
    if (reasoning) {
      // 思考过程：出现内容即显示并自动展开，同时智能跟随其内部滚动
      a.reasoning.classList.remove("hidden");
      a.reasoning.open = true;
      a.reasoningBody.textContent += reasoning;
      a.stickReasoning();
    }
    if (text) {
      a.textBody.innerHTML = renderMarkdown(a.textBody.textContent + text);
    }
    scrollToBottom();
  }

  function finalizeAssistant(text, reasoning, foldReasoning) {
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
        head.textContent = `⚙ ${wrap.querySelector(".tool-inline-head").textContent.replace(/^⚙ /, "")} ${ok ? t("done") : t("failed")}`;
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

  function showApproval(id, toolName, reason) {
    state.pendingApprovalId = id;
    const body = $("approvalBody");
    body.innerHTML = "";
    const p1 = el("p", "", "");
    // 该行内含 <strong> 标签，需 innerHTML 渲染（toolName 已转义，安全）
    p1.innerHTML = t("approvalAsk", escapeHtml(toolName));
    body.appendChild(p1);
    if (reason) {
      const p2 = el("p", "approval-reason", reason);
      body.appendChild(p2);
    }
    // 面板内居中 modal（遮罩 + 卡片，像子窗口；webview 保留上下文，
    // 窗口不活动时弹窗保持，切回即可处理——与 Kilo Code / DSH Web 一致）
    approvalEl.classList.remove("hidden");
    scrollToBottom();
  }

  function hideApproval() {
    approvalEl.classList.add("hidden");
    state.pendingApprovalId = null;
  }

  btnAllow.addEventListener("click", () => {
    if (state.pendingApprovalId !== null) {
      vscode.postMessage({ t: "approval:resolve", id: state.pendingApprovalId, approve: true });
    }
    hideApproval();
  });
  btnDeny.addEventListener("click", () => {
    if (state.pendingApprovalId !== null) {
      vscode.postMessage({ t: "approval:resolve", id: state.pendingApprovalId, approve: false });
    }
    hideApproval();
  });

  /* ---------------- 状态 ---------------- */

  function setStatus(status) {
    state.running = status === "running";
    // 工作状态由发送/停止按钮体现（running 时发送禁用、停止可见），无需状态圆点
    btnStop.classList.toggle("hidden", !state.running);
    btnSend.disabled = state.running;
  }

  /* ---------------- 消息入口 ---------------- */

  const configBanner = $("configBanner");
  const historyPanel = $("historyPanel");
  const historyList = $("historyList");
  let confirmDeleteId = null;

  /** 渲染历史会话列表。 */
  function renderHistory(list) {
    historyList.innerHTML = "";
    if (!list || list.length === 0) {
      historyList.appendChild(el("div", "history-empty", t("emptyHistory")));
      return;
    }
    for (const s of list) {
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
      meta.textContent = `${when}${s.live ? t("currentSession") : ""}${cwdShort ? " · " + cwdShort : ""}`;
      main.appendChild(title);
      main.appendChild(meta);
      const actions = el("div", "history-actions");
      const btnResume = el("button", "hbtn resume", t("resume"));
      btnResume.title = t("resumeTitle");
      btnResume.addEventListener("click", () => {
        vscode.postMessage({ t: "resumeSession", id: s.id });
        historyPanel.classList.add("hidden");
        hintEl.textContent = t("restoring");
      });
      const btnDelete = el("button", "hbtn delete", t("del"));
      btnDelete.title = t("delTitle");
      btnDelete.addEventListener("click", () => {
        if (confirmDeleteId === s.id) {
          confirmDeleteId = null;
          vscode.postMessage({ t: "deleteSession", id: s.id });
          btnDelete.textContent = t("del");
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
      actions.appendChild(btnDelete);
      row.appendChild(main);
      row.appendChild(actions);
      historyList.appendChild(row);
    }
  }

  let historyLoadTimer = null;
  let historyRetryTimer = null;

  function openHistory() {
    confirmDeleteId = null;
    historyPanel.classList.remove("hidden");
    historyList.innerHTML = "";
    historyList.appendChild(el("div", "history-empty", t("loading")));
    vscode.postMessage({ t: "history" });
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
    hintEl.textContent = "";
    hintEl.title = "";
    hintEl.style.cursor = "";
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
        appendAssistantDelta(e.text, e.reasoning);
        break;
      case "assistant":
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
        break;
    }
  }

  function onMessage(msg) {
    switch (msg.t) {
      case "bootstrap": {
        // 语言跟随 VS Code 界面语言
        L = msg.locale === "en" ? I18N.en : I18N.zh;
        const isNewEmpty = !msg.sessionId && Boolean(state.sessionId);
        if (isNewEmpty) {
          // 切到"新会话"（无 session）：清空顶部统计（host 已重置，这里同步 UI）
          state.stats = null;
          sessionTitleEl.textContent = "";
          costStatsEl.textContent = "—";
          contextPctEl.textContent = "🧠 —";
          tokensInEl.textContent = "↗ 0";
          tokensCacheEl.textContent = "⇄ 0";
          tokensOutEl.textContent = "↘ 0";
        }
        state.sessionId = msg.sessionId || null;
        updateExportButton();
        // 顶部信息栏常显（Kilo Code 风格）：会话标题显示在顶栏（header 中）
        topbarEl.classList.remove("hidden");
        sessionTitleEl.textContent = msg.sessionId
          ? state.stats?.title || msg.sessionTitle || t("session", msg.sessionId.slice(0, 12))
          : t("newSessionTitle");
        sessionTitleEl.title = sessionTitleEl.textContent;
        hintEl.textContent = msg.sessionId
          ? t("session", msg.sessionId.slice(0, 12))
          : msg.ready
            ? t("newSessionHint")
            : "";
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
      case "modelChanged":
        renderModelChanged(msg);
        break;
      case "workModeChanged":
        state.suppressSelectorEvents = true;
        selWorkMode.value = msg.mode;
        state.suppressSelectorEvents = false;
        hintEl.textContent =
          msg.mode === "multi"
            ? "🧩 多 Agent 并发：任务将拆解为并行子代理执行"
            : state.sessionId
              ? t("session", state.sessionId.slice(0, 12))
              : t("newSessionHint");
        break;
      case "compactDone": {
        btnCompact.disabled = false;
        if (msg.ok) {
          hintEl.textContent = t("compacted", msg.text ?? "");
          hintEl.style.color = "";
        } else {
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
        state.historyMore = msg.hasMore ? { hasMore: true, nextSeq: msg.nextSeq } : null;
        state.historyLoadingMore = false;
        for (const e of msg.events) handleViewEvent(e, { foldReasoning: true });
        updateEmptyState();
        hintEl.textContent = t("resumed", msg.sessionId.slice(0, 12));
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
        if (msg.ok) {
          // 刷新列表（若面板仍打开）
          if (!historyPanel.classList.contains("hidden")) {
            vscode.postMessage({ t: "historyRefresh" });
          }
        } else {
          addErrorMessage(t("deleteFailed", msg.error ?? "unknown error"));
        }
        break;
      }
      case "approval":
        showApproval(msg.id, msg.toolName, msg.reason);
        break;
      case "approvalResolved":
        hideApproval();
        break;
      case "status":
        setStatus(msg.status);
        break;
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
    if (!text || state.running) return;
    inputEl.value = "";
    autoResize();
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

  /** 导出按钮状态：有会话内容时有效，无会话内容（未加载）时灰色禁用。 */
  function updateExportButton() {
    const enabled = Boolean(state.sessionId);
    btnExportFull.classList.toggle("disabled", !enabled);
    btnExportFull.title = enabled
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
  btnSend.addEventListener("click", send);
  btnStop.addEventListener("click", () => vscode.postMessage({ t: "stop" }));
  btnNew.addEventListener("click", () => vscode.postMessage({ t: "newSession" }));
  $("btnConfig").addEventListener("click", () => vscode.postMessage({ t: "configure" }));
  $("btnWorkspace").addEventListener("click", () => vscode.postMessage({ t: "openWorkspace" }));
  $("btnHistory").addEventListener("click", openHistory);
  $("btnHistoryRefresh").addEventListener("click", () => vscode.postMessage({ t: "historyRefresh" }));
  $("btnHistoryClose").addEventListener("click", closeHistory);
  // 导出当前会话完整记录（面板顶部图标；无会话内容时为灰色无效）
  btnExportFull.addEventListener("click", () => {
    if (!state.sessionId) {
      addErrorMessage(t("noContent"));
      return;
    }
    vscode.postMessage({ t: "exportSession", id: state.sessionId });
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
    const model = selModel.value || undefined;
    postSetModel({ provider: selProvider.value, model });
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

  btnCompact.addEventListener("click", () => {
    if (!state.sessionId) {
      addErrorMessage(t("noContent"));
      return;
    }
    btnCompact.disabled = true;
    hintEl.textContent = t("compacting");
    hintEl.style.color = "";
    vscode.postMessage({ t: "compact" });
  });
  updateExportButton();
  // 初始空态：bootstrap 到达前先显示欢迎语（语言随 bootstrap 校正）
  updateEmptyState();

  window.addEventListener("message", (ev) => onMessage(ev.data));

  // 视图就绪握手
  vscode.postMessage({ t: "ready" });
})();
