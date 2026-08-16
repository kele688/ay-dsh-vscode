/**
 * webviewPanel.ts — DSH 聊天侧边栏（WebviewView）管理：加载 UI、双向消息路由。
 *
 * 宿主是惰性创建的（见 extension.ts 的 ensureHost），因此 provider 通过
 * setHost() 绑定宿主；任何需要宿主的动作（发消息/开视图）都会先调用
 * ensureHost 回调，保证"打开面板即可用"，绝不静默丢弃用户输入。
 */
import * as vscode from "vscode";
import type { AgentHost, HostEvent } from "./host";
import type { ExtensionToWebview, WebviewMessage } from "./protocol";

export interface ChatViewDeps {
  extensionUri: vscode.Uri;
  getModel: () => string;
  getConfigSummary: () => Promise<{
    keyConfigured: boolean;
    model: string;
    baseUrl: string;
    permissionMode: string;
    cwd: string;
  }>;
  ensureHost: () => Promise<AgentHost>;
}

/** 扩展侧错误消息的国际化（zh/en 双语，跟随 VS Code 界面语言）。 */
function loc(zh: string, en: string): string {
  return vscode.env.language.startsWith("zh") ? zh : en;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dshVscode.chatView";

  private view: vscode.WebviewView | undefined;
  private host: AgentHost | undefined;
  private hostDisposable: vscode.Disposable | undefined;
  private pendingTasks: string[] = [];
  /** 未决的"追加到输入框"文本（webview 未就绪时缓存，就绪后补发，避免快捷键引用丢失）。 */
  private pendingInputs: string[] = [];
  /** webview 是否已完成 ready 握手（决定消息是直发还是缓存）。 */
  private webviewReady = false;
  private lastStatus: "idle" | "running" = "idle";
  private hostReady = false;
  private lastBootstrap: (ExtensionToWebview & { t: "bootstrap" }) | undefined;
  private hostState: "starting" | "ready" | "exited" | "not-started" = "not-started";
  /** 未决的审批请求（webview 未就绪/重建时缓存，就绪后补发，避免工具调用永久挂起）。 */
  private pendingApprovals = new Map<number, { toolName: string; reason?: string; callId?: string; agentId?: string }>();
  /** 待审批时显示的状态栏项（点击聚焦面板）。 */
  private approvalStatusItem: vscode.StatusBarItem | undefined;
  /** 最近一次会话统计（webview ready 时补发，避免就绪前的事件丢失）。 */
  private lastStats: (ExtensionToWebview & { t: "stats" }) | undefined;
  /** webview 创建时间戳（性能诊断）。 */
  private viewCreatedAt: number | undefined;
  /** 诊断日志（输出通道 "ay-dsh-vscode Host" 可见）。 */
  private outputLog(msg: string): void {
    try {
      // 复用宿主输出通道不易；直接打印到控制台（VS Code 开发者工具）并静默失败兜底
      console.log(msg);
    } catch {
      // 忽略
    }
  }
  /** 宿主自动重启计数（连续失败多次后放弃，避免死循环）。 */
  private hostRestartAttempts = 0;
  private hostRestartTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ChatViewDeps) {
    this.approvalStatusItem = undefined;
  }

  /** 绑定（或解绑）宿主实例。 */
  setHost(host: AgentHost | undefined): void {
    this.hostDisposable?.dispose();
    this.hostDisposable = undefined;
    this.host = host;
    this.hostReady = false;
    if (this.hostRestartTimer) {
      clearTimeout(this.hostRestartTimer);
      this.hostRestartTimer = undefined;
    }
    if (!host) {
      // 宿主销毁：清空审批缓存与状态栏
      this.pendingApprovals.clear();
      this.refreshApprovalStatusBar();
    }
    if (host) this.hostDisposable = host.onEvent((e) => this.handleHostEvent(e));
  }

  /** 入队一条任务文本；视图与宿主就绪后立即发送。 */
  queueTask(text: string): void {
    this.pendingTasks.push(text);
    void this.drainTasks();
  }

  /**
   * 把一段文本追加到聊天输入框（如 Ctrl+K Ctrl+I 快捷引用）。
   * webview 未就绪/未打开时缓存，ready 握手后补发——快捷键操作永不静默丢失。
   */
  appendInput(text: string): void {
    if (this.view && this.webviewReady) {
      this.push({ t: "appendInput", text });
    } else {
      this.pendingInputs.push(text);
    }
  }

  /** 向视图推送最新配置摘要（配置向导保存后调用）。 */
  pushConfigToView(): void {
    void this.pushConfig();
  }

  private async drainTasks(): Promise<void> {
    if (this.pendingTasks.length === 0) return;
    if (!this.view) return; // 视图未打开：任务保留在队列，视图 ready 后消费
    try {
      await this.deps.ensureHost();
    } catch {
      return; // ensureHost 内部已向 UI 报错
    }
    if (!this.host) return;
    const queued = this.pendingTasks.splice(0);
    for (const task of queued) await this.sendChat(task);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.viewCreatedAt = Date.now();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, "media")],
    };
    // 先渲染 HTML（webview 立即可用，不阻塞 UI）
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    this.outputLog(`[perf] resolveWebviewView → html set (${Date.now() - this.viewCreatedAt}ms)`);

    // 视图打开即保证宿主可用（用户可能直接从这里发起会话）。
    // 立即后台启动：spawn 是异步的，不占用扩展宿主 UI 线程；
    // webview 已先行渲染（含未就绪 bootstrap 骨架），宿主就绪后自动补数据。
    void this.ensureHostAndReport();
    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      switch (msg.t) {
        case "chat":
          void this.sendChat(msg.text);
          break;
        case "stop":
          this.host?.stop();
          break;
        case "approval:resolve":
          this.host?.approve(msg.id, msg.approve);
          this.pendingApprovals.delete(msg.id);
          this.refreshApprovalStatusBar();
          break;
        case "newSession":
          this.host?.newSession();
          break;
        case "openWorkspace":
          void vscode.commands.executeCommand("dshVscode.openWorkspace");
          break;
        case "configure":
          void vscode.commands.executeCommand("dshVscode.configure");
          break;
        case "history":
        case "historyRefresh": {
          // 宿主可能尚未就绪（首次打开面板即点历史）：先确保宿主可用再请求列表
          void (async () => {
            try {
              await this.deps.ensureHost();
              this.host?.listSessions();
            } catch {
              this.push({
                t: "event",
                e: {
                  kind: "error",
                  text: loc(
                    "会话历史暂时无法加载：DSH 宿主正在恢复中，请稍候再试。",
                    "Session history is temporarily unavailable: the DSH host is recovering. Please try again shortly."
                  ),
                  ts: Date.now(),
                },
              });
            }
          })();
          break;
        }
        case "historyClose":
          break;
        case "resumeSession":
          this.host?.resumeSession(msg.id);
          break;
        case "loadMoreHistory":
          this.host?.loadMoreHistory(msg.beforeSeq);
          break;
        case "deleteSession":
          this.host?.deleteSession(msg.id);
          break;
        case "exportSession":
          this.host?.exportSession(msg.id);
          break;
        case "setModel":
          this.host?.setModel({ provider: msg.provider, model: msg.model, reasoningEffort: msg.reasoningEffort });
          break;
        case "setWorkMode":
          this.host?.setWorkMode(msg.mode);
          break;
        case "compact":
          this.host?.compact();
          break;
        case "ready": {
          // 视图就绪：立即补发状态/配置/未就绪 bootstrap（宿主未 ready 时
          // 也给出完整 UI 骨架：标题"新会话"、下拉"加载中…"、提示"正在启动"），
          // 避免 webview 空白等待宿主（转圈感知的来源）。
          this.webviewReady = true;
          this.outputLog(`[perf] webview ready 握手 (${Date.now() - (this.viewCreatedAt ?? Date.now())}ms)`);
          this.push({ t: "status", status: this.lastStatus });
          void this.pushConfig();
          this.pushHostState();
          const boot =
            this.lastBootstrap ?? {
              t: "bootstrap",
              model: "",
              provider: "",
              cwd: "",
              sessionId: "",
              ready: false,
              locale: vscode.env.language.startsWith("zh") ? "zh" : "en",
            };
          this.push(boot);
          // 补发最近统计（webview 就绪前产生的会话统计不丢失）
          if (this.lastStats) this.push(this.lastStats);
          // 补发未决的审批请求（webview 未就绪/重建期间产生的）
          for (const [id, a] of this.pendingApprovals) {
            this.push({ t: "approval", id, toolName: a.toolName, reason: a.reason, callId: a.callId, agentId: a.agentId });
          }
          this.refreshApprovalStatusBar();
          const queued = this.pendingTasks.splice(0);
          for (const task of queued) void this.sendChat(task);
          // 补发未决的输入框追加（Ctrl+K Ctrl+I 引用在视图就绪前触发也不丢失）
          const inputs = this.pendingInputs.splice(0);
          for (const text of inputs) this.push({ t: "appendInput", text });
          break;
        }
        case "openFile": {
          const uri = vscode.Uri.file(msg.path);
          void vscode.window.showTextDocument(uri, { preview: true });
          break;
        }
      }
    });
  }

  /** 确保宿主已启动，并把状态上报给 UI；失败时静默（日志在输出通道），不打扰用户。 */
  private async ensureHostAndReport(): Promise<void> {
    this.hostState = "starting";
    this.pushHostState();
    try {
      await this.deps.ensureHost();
    } catch {
      // 宿主启动失败：保持静默，自动重启由 host exit 事件触发；
      // 用户实际发起会话/查看历史时才在对应操作中给出友好提示。
      this.hostState = "exited";
      this.pushHostState();
    }
  }

  private async sendChat(text: string): Promise<void> {
    if (this.view) {
      try {
        await this.deps.ensureHost();
      } catch {
        this.push({
          t: "event",
          e: {
            kind: "error",
            text: loc(
              "DSH 宿主启动失败，暂时无法发送消息。请重载窗口后重试；若问题持续，查看输出通道 “ay-dsh-vscode Host” 了解详情。",
              "The DSH host failed to start, so the message cannot be sent. Reload the window and retry; if the problem persists, check the output channel “ay-dsh-vscode Host”."
            ),
            ts: Date.now(),
          },
        });
        return;
      }
    }
    const host = this.host;
    if (!host) {
      this.push({
        t: "event",
        e: {
          kind: "error",
          text: loc("DSH 宿主尚未就绪，请稍候片刻再发送。", "The DSH host is not ready yet. Please wait a moment and try again."),
          ts: Date.now(),
        },
      });
      return;
    }
    this.setStatus("running");
    try {
      const ok = await host.chat(text);
      if (!ok) {
        this.push({
          t: "event",
          e: {
            kind: "error",
            text: loc(
              "本轮没有收到回复，宿主可能已退出。已自动尝试恢复，请稍后再试；详情见输出通道 “ay-dsh-vscode Host”。",
              "No reply was received this turn; the host may have exited. Automatic recovery has been attempted — please try again shortly; details in the output channel “ay-dsh-vscode Host”."
            ),
            ts: Date.now(),
          },
        });
      }
    } catch {
      this.push({
        t: "event",
        e: {
          kind: "error",
          text: loc(
            "发送失败：DSH 宿主无响应。请稍候重试，详情见输出通道 “ay-dsh-vscode Host”。",
            "Send failed: the DSH host is not responding. Retry shortly; details in the output channel “ay-dsh-vscode Host”."
          ),
          ts: Date.now(),
        },
      });
    } finally {
      this.setStatus("idle");
    }
  }

  private setStatus(status: "idle" | "running"): void {
    this.lastStatus = status;
    this.push({ t: "status", status });
  }

  private async pushConfig(): Promise<void> {
    const c = await this.deps.getConfigSummary();
    this.push({ t: "config", ...c });
  }

  private pushHostState(): void {
    this.push({ t: "hostState", state: this.hostState });
  }

  private handleHostEvent(e: HostEvent): void {
    switch (e.type) {
      case "ready": {
        this.hostReady = true;
        this.hostState = "ready";
        this.hostRestartAttempts = 0;
        this.lastBootstrap = {
          t: "bootstrap",
          model: e.model,
          provider: e.provider,
          cwd: e.cwd,
          sessionId: e.sessionId,
          sessionTitle: e.sessionTitle,
          ready: true,
          locale: vscode.env.language.startsWith("zh") ? "zh" : "en",
        };
        this.pushHostState();
        this.push(this.lastBootstrap);
        void this.pushConfig();
        // 拉取 provider/model 目录，填充输入框下方的模型选择器
        this.host?.getModelInfo();
        break;
      }
      case "view":
        this.push({ t: "event", e: e.event });
        break;
      case "status":
        this.lastStatus = e.status;
        this.push({ t: "status", status: e.status });
        break;
      case "approval":
        // 缓存未决审批（webview 重建/未就绪时补发），并推送到界面。
        // 授权唯一通道 = webview 内 modal 弹窗（面板居中，Kilo Code / DSH Web
        // 同款交互）：webview 保留上下文，弹窗一直保持，窗口不活动时切回即可处理。
        // 状态栏仅作"有待授权"指示（点击聚焦面板），不是第二个弹窗。
        this.pendingApprovals.set(e.id, { toolName: e.toolName, reason: e.reason, callId: e.callId, agentId: e.agentId });
        this.push({ t: "approval", id: e.id, toolName: e.toolName, reason: e.reason, callId: e.callId, agentId: e.agentId });
        this.refreshApprovalStatusBar();
        // 必然可见：无论用户当前在看编辑器还是其他面板，收到审批请求即自动
        // 聚焦聊天面板——授权弹窗一定会出现在用户视野中（不会因未打开面板而错过）。
        void vscode.commands.executeCommand("dshVscode.chatView.focus");
        break;
      case "approvalGone":
        // 审批已被宿主取消/超时：清理缓存与状态栏，并通知 webview 关闭弹窗
        this.pendingApprovals.delete(e.id);
        this.refreshApprovalStatusBar();
        this.push({ t: "approvalResolved", id: e.id });
        break;
      case "sessions":
        this.push({ t: "sessions", list: e.list, error: e.error });
        break;
      case "history": {
        this.push({ t: "history", sessionId: e.sessionId, events: e.events, hasMore: e.hasMore, nextSeq: e.nextSeq });
        break;
      }
      case "historyMore": {
        this.push({
          t: "historyMore",
          sessionId: e.sessionId,
          events: e.events,
          hasMore: e.hasMore,
          nextSeq: e.nextSeq,
        });
        break;
      }
      case "stats":
        this.lastStats = { t: "stats", stats: e.stats };
        this.push(this.lastStats);
        break;
      case "modelInfo":
        this.push({ t: "modelInfo", providers: e.providers, models: e.models, current: e.current });
        break;
      case "modelChanged":
        this.push({
          t: "modelChanged",
          provider: e.provider,
          model: e.model,
          reasoningEffort: e.reasoningEffort,
          error: e.error,
        });
        break;
      case "workModeChanged":
        this.push({ t: "workModeChanged", mode: e.mode });
        break;
      case "compactDone":
        this.push({ t: "compactDone", ok: e.ok, text: e.text, error: e.error });
        break;
      case "sessionResumed":
        // 恢复结果通过 history + ready 帧呈现；失败时提示
        if (!e.ok) {
          this.push({
            t: "event",
            e: {
              kind: "error",
              text: loc(`恢复会话失败：${e.error ?? "未知错误"}`, `Failed to resume session: ${e.error ?? "unknown error"}`),
              ts: Date.now(),
            },
          });
        }
        break;
      case "sessionDeleted":
        this.push({ t: "sessionDeleted", id: e.id, ok: e.ok, error: e.error });
        break;
      case "sessionExported": {
        if (e.ok && e.path) {
          // 在系统浏览器中打开完整历史网页
          void vscode.env.openExternal(vscode.Uri.file(e.path));
          vscode.window.showInformationMessage(loc(`已导出完整会话记录：${e.path}`, `Full conversation exported: ${e.path}`));
        } else {
          vscode.window.showErrorMessage(loc(`导出会话失败：${e.error ?? "未知错误"}`, `Export failed: ${e.error ?? "unknown error"}`));
        }
        break;
      }
      case "exit":
        this.hostReady = false;
        this.hostState = "exited";
        this.push({ t: "hostExit", code: e.code, error: e.error });
        this.pushHostState();
        // 宿主异常退出后自动重启一次（koffi 依赖缺失、瞬时失败等场景下
        // 无需用户手动操作即可恢复；重启仍失败才需要用户介入）。
        this.scheduleHostRestart();
        break;
      case "log":
        break;
    }
  }

  /** 宿主异常退出后自动重启（最多 2 次，间隔 1.5s；成功后重置计数）。静默处理：不打扰用户。 */
  private scheduleHostRestart(): void {
    if (this.hostRestartAttempts >= 2) {
      this.hostRestartAttempts = 0;
      return; // 连续失败过多次：停止自动重启，等用户操作时再提示
    }
    this.hostRestartAttempts++;
    this.hostState = "starting";
    this.pushHostState();
    if (this.hostRestartTimer) clearTimeout(this.hostRestartTimer);
    this.hostRestartTimer = setTimeout(() => {
      void this.deps.ensureHost().then(() => {
        this.hostRestartAttempts = 0; // 成功就绪后重置
      });
    }, 1500);
  }

  private push(msg: ExtensionToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /**
   * 授权通道说明：唯一授权交互在 webview 内 modal 弹窗（面板居中，Kilo Code /
   * DSH Web 同款）。webview 保留上下文，弹窗一直保持；窗口不活动时仅暂时不可见，
   * 切回即可处理。状态栏只作"有待授权"指示（点击聚焦面板），不是第二个弹窗。
   */

  /** 状态栏常驻警告：有待审批时显示，全部解决后隐藏（点击聚焦面板）。 */
  private refreshApprovalStatusBar(): void {
    if (this.pendingApprovals.size > 0) {
      if (!this.approvalStatusItem) {
        this.approvalStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.approvalStatusItem.command = "dshVscode.chatView.focus";
        this.approvalStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      }
      const zh = vscode.env.language.startsWith("zh");
      this.approvalStatusItem.text = `$(warning) DSH ${zh ? "待授权" : "approval"}`;
      this.approvalStatusItem.tooltip = zh
        ? `DSH Agent 有 ${this.pendingApprovals.size} 个待授权请求（点击打开面板处理）`
        : `${this.pendingApprovals.size} pending approval request(s) — click to open the panel`;
      this.approvalStatusItem.show();
    } else {
      this.approvalStatusItem?.hide();
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "chat.css"));
    const zh = vscode.env.language.startsWith("zh");
    const L = {
      exportTitle: zh ? "导出完整对话记录（浏览器打开，含全部思考与工具详情）" : "Export full conversation (opens in browser, includes all reasoning & tool details)",
      historyTitle: zh ? "历史会话" : "Session History",
      historyBtn: zh ? "历史会话" : "History",
      refresh: zh ? "刷新" : "Refresh",
      close: zh ? "关闭" : "Close",
      workspaceBtn: zh ? "打开工作目录" : "Open working directory",
      configBtn: zh ? "配置（模型 / API Key / 权限）" : "Settings (Model / API Key / Permissions)",
      newSession: zh ? "新会话" : "New Session",
      approvalTitle: zh ? "需要授权" : "Authorization Required",
      deny: zh ? "拒绝" : "Deny",
      allow: zh ? "允许" : "Allow",
      placeholder: zh ? "给 DSH Agent 下达任务…（Enter 发送，Shift+Enter 换行）" : "Ask the DSH Agent… (Enter to send, Shift+Enter for newline)",
      send: zh ? "发送" : "Send",
      stop: zh ? "停止" : "Stop",
      compactTitle: zh ? "压缩上下文：把较早的对话历史归纳为摘要，释放上下文空间" : "Compact context: summarize older history to free context space",
      compactBusy: zh ? "正在压缩上下文…" : "Compacting context…",
      providerTitle: zh ? "模型提供者" : "Model provider",
      modelTitle: zh ? "模型" : "Model",
      effortTitle: zh ? "思考等级" : "Reasoning effort",
      workModeTitle: zh ? "工作模式：单 Agent 串行 / 多 Agent 并发" : "Work mode: single agent serial / multi-agent parallel",
      workModeSingle: zh ? "单 Agent 串行" : "Single Agent",
      workModeMulti: zh ? "多 Agent 并发" : "Multi-Agent",
    };
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      "font-src data:",
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>DSH Agent</title>
</head>
<body>
<div id="app">
  <header id="header">
    <span class="logo">◈ DSH</span>
    <span id="sessionTitle" class="session-title" title="">…</span>
    <span class="spacer"></span>
    <button id="btnExportFull" class="icon-btn disabled" title="${L.exportTitle}">📄</button>
    <button id="btnHistory" class="icon-btn" title="${L.historyBtn}">🕘</button>
    <button id="btnWorkspace" class="icon-btn" title="${L.workspaceBtn}">📂</button>
    <button id="btnConfig" class="icon-btn" title="${L.configBtn}">⚙</button>
    <button id="btnNew" class="icon-btn" title="${L.newSession}">＋</button>
  </header>
  <div id="topbar" class="hidden">
    <div class="topbar-row">
      <span id="costStats" class="topbar-stat" title="">—</span>
      <span id="contextPct" class="topbar-stat" title="">—</span>
      <span class="spacer"></span>
      <span id="tokensIn" class="token-stat">↗ 0</span>
      <span id="tokensCache" class="token-stat">⇄ 0</span>
      <span id="tokensOut" class="token-stat">↘ 0</span>
      <button id="btnCompact" class="icon-btn small" title="${L.compactTitle}">🗜️</button>
    </div>
  </div>
  <section id="historyPanel" class="history hidden">
    <div class="history-header">
      <span class="history-title">${L.historyTitle}</span>
      <span class="spacer"></span>
      <button id="btnHistoryRefresh" class="icon-btn small" title="${L.refresh}">⟳</button>
      <button id="btnHistoryClose" class="icon-btn small" title="${L.close}">✕</button>
    </div>
    <div id="historyList" class="history-list"></div>
  </section>
  <section id="configBanner" class="config-banner hidden"></section>
  <main id="messages">
    <div id="emptyState" class="empty-state"><span></span></div>
  </main>
  <!-- 授权 modal：面板内居中弹窗（Kilo Code / DSH Web 同款交互）。
       唯一授权通道；webview 保留上下文，窗口不活动时弹窗一直保持，切回即可处理。 -->
  <div id="approval" class="approval-modal hidden">
    <div class="approval-backdrop"></div>
    <div class="approval-card">
      <div class="approval-title">${L.approvalTitle}</div>
      <div id="approvalBody" class="approval-body"></div>
      <div class="approval-actions">
        <button id="btnDeny" class="btn deny">${L.deny}</button>
        <button id="btnAllow" class="btn allow">${L.allow}</button>
      </div>
    </div>
  </div>
  <footer id="composer">
    <textarea id="input" rows="2" placeholder="${L.placeholder}"></textarea>
    <div id="composerTools" class="composer-tools">
      <select id="selProvider" title="${L.providerTitle}" class="tool-select provider"></select>
      <select id="selModel" title="${L.modelTitle}" class="tool-select model"></select>
      <select id="selEffort" title="${L.effortTitle}" class="tool-select effort">
        <option value="high">HIGH</option>
        <option value="off">OFF</option>
        <option value="low">LOW</option>
        <option value="max">MAX</option>
      </select>
      <select id="selWorkMode" title="${L.workModeTitle}" class="tool-select workmode">
        <option value="single">${L.workModeSingle}</option>
        <option value="multi">${L.workModeMulti}</option>
      </select>
      <span id="hint" class="hint"></span>
      <button id="btnSend" class="btn send">${L.send}</button>
      <button id="btnStop" class="btn stop hidden">${L.stop}</button>
    </div>
  </footer>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
