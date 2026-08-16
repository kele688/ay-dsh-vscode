/**
 * host.ts — AgentHost：管理 agent-host.mjs 子进程的生命周期与 JSONL 通信。
 *
 * - 自动探测 Node 运行时：优先系统 node（>=20），回退 VS Code 内置 Node（ELECTRON_RUN_AS_NODE）。
 * - 把 DSH 会话事件翻译为面向 UI 的 ViewEvent（chunk 流式合并、工具卡片、todo、turn 状态）。
 * - 暴露 send/stop/approve/restart/dispose 等命令式接口。
 */
import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import type {
  ExtensionFrame,
  HostFrame,
  SessionEvent,
  SessionStats,
  SessionSummary,
  ViewEvent,
} from "./protocol";

/** 一次工具调用在 UI 上的聚合状态。 */
interface ToolCallState {
  callId: string;
  name: string;
  args: string;
  argsPretty?: string;
  ts: number;
  resultText?: string;
  resultOk?: boolean;
}

/** 一轮 turn 在 UI 上的聚合状态。 */
interface TurnState {
  turn: number;
  text: string;
  reasoning: string;
  tools: Map<string, ToolCallState>;
  chunkSeq: number;
  ts: number;
}

export interface AgentHostOptions {
  extensionPath: string;
  workspaceRoot: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  permissionMode: string;
  nodePath?: string;
  /** 插件专属的 DSH home 目录（会话/配置均存于此，与官方 dsh 完全隔离）。 */
  dshHome: string;
  /** 旧 DSH home（用于一次性迁移历史会话）。 */
  legacyDshHome?: string;
}

export type HostEvent =
  | { type: "ready"; sessionId: string; model: string; provider: string; cwd: string; sessionTitle?: string }
  | { type: "view"; event: ViewEvent }
  | { type: "status"; status: "idle" | "running" }
  | { type: "approval"; id: number; toolName: string; reason?: string; callId?: string; agentId?: string }
  | { type: "approvalGone"; id: number }
  | { type: "sessions"; list: SessionSummary[]; error?: string }
  | { type: "history"; sessionId: string; events: ViewEvent[]; hasMore?: boolean; nextSeq?: number }
  | { type: "historyMore"; sessionId: string; events: ViewEvent[]; hasMore?: boolean; nextSeq?: number }
  | { type: "sessionResumed"; id: string; ok: boolean; error?: string }
  | { type: "sessionDeleted"; id: string; ok: boolean; error?: string }
  | { type: "sessionExported"; id: string; ok: boolean; path?: string; error?: string }
  | { type: "stats"; stats: SessionStats }
  | {
      type: "modelInfo";
      providers: { id: string; name: string }[];
      models: string[];
      current: { provider: string; model: string; reasoningEffort?: string; supportedEfforts?: string[] };
    }
  | { type: "modelChanged"; provider: string; model: string; reasoningEffort?: string; error?: string }
  | { type: "workModeChanged"; mode: "single" | "multi" }
  | { type: "compactDone"; ok: boolean; text?: string; error?: string }
  | { type: "exit"; code: number; error?: string }
  | { type: "log"; level: string; message: string };

/** 探测一个可用的 Node 可执行文件（结果缓存：扩展生命周期内只探测一次）。 */
let cachedNode: string | null | undefined;
async function resolveNode(nodePath: string | undefined): Promise<string | null> {
  if (cachedNode !== undefined) return cachedNode;
  const candidates: string[] = [];
  if (nodePath && nodePath.trim() !== "") candidates.push(nodePath.trim());
  candidates.push("node"); // PATH 中的 node（spawn 会解析）
  for (const candidate of candidates) {
    try {
      const result = await new Promise<string | null>((resolve) => {
        const child = spawn(candidate, ["--version"], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
          const match = /v(\d+)\./.exec(out || err);
          const major = match ? Number(match[1]) : 0;
          resolve(code === 0 && major >= 20 ? candidate : null);
        });
      });
      if (result) {
        cachedNode = result;
        return result;
      }
    } catch {
      // 继续探测下一个
    }
  }
  cachedNode = null;
  return null;
}

export class AgentHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private output: vscode.OutputChannel;
  private eventListeners = new Set<(e: HostEvent) => void>();
  private chatSeq = 0;
  private pendingChat = new Map<number, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  /** 按 turn 聚合的渲染状态（chunk → 增量 ViewEvent）。 */
  private turns = new Map<number, TurnState>();
  private disposed = false;
  private readySessionId: string | undefined;
  /** 最近一次 history 重放的会话 id（ready 帧跳过重置统计的依据）。 */
  private lastHistorySessionId: string | undefined;
  /** 当前使用的宿主脚本（bundle 或源文件），以及失败时的回退脚本。 */
  private hostScript: string | undefined;
  private fallbackHostScript: string | undefined;
  /** 当前会话的 token/标题统计（随事件流累计，推送给 UI 顶部信息栏）。 */
  private stats: SessionStats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

  constructor(private readonly options: AgentHostOptions, private readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("ay-dsh-vscode Host");
  }

  get sessionId(): string | undefined {
    return this.readySessionId;
  }

  /** 宿主启动时的工作区根路径（Agent 的工作目录）。 */
  get workspaceRoot(): string {
    return this.options.workspaceRoot;
  }

  onEvent(listener: (e: HostEvent) => void): vscode.Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => this.eventListeners.delete(listener) };
  }

  private emit(e: HostEvent) {
    for (const listener of this.eventListeners) {
      try {
        listener(e);
      } catch (err) {
        this.output.appendLine(`[listener error] ${String(err)}`);
      }
    }
  }

  /** 启动子进程并等待 ready。 */
  async start(): Promise<void> {
    if (this.child) return;
    // 优先使用 esbuild bundle 版宿主（单文件，冷启动快——不需要解析
    // node_modules 中数百个 ESM 文件）；bundle 不存在时回退源文件
    // （如开发环境中只改了 agent-host.mjs 尚未构建）。
    const bundlePath = path.join(this.options.extensionPath, "host", "agent-host.bundle.mjs");
    const sourcePath = path.join(this.options.extensionPath, "host", "agent-host.mjs");
    // bundle 启动失败时允许回退到源文件（记录在 this.hostScript）
    this.hostScript = fs.existsSync(bundlePath) ? bundlePath : sourcePath;
    this.fallbackHostScript = fs.existsSync(bundlePath) && fs.existsSync(sourcePath) ? sourcePath : undefined;
    const hostScript = this.hostScript;
    const nodeExe = (await resolveNode(this.options.nodePath)) ?? process.execPath;
    const useElectronNode = nodeExe === process.execPath;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.options.dshHome,
      DSH_VSCODE_MODEL: this.options.model,
      DSH_PERMISSION_MODE: this.options.permissionMode,
      DSH_TELEMETRY_DISABLED: "1",
      // 统一子进程文本编码为 UTF-8：Windows PowerShell 5.1 / Python 默认按
      // 系统代码页（GBK）输出中文，Node 侧按 UTF-8 读取会乱码。
      // 这些环境变量让工具子进程（pwsh/python）直接输出 UTF-8。
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      POWERSHELL_TELEMETRY_OPTOUT: "1",
    };
    if (this.options.legacyDshHome) env.DSH_LEGACY_HOME = this.options.legacyDshHome;
    if (useElectronNode) env.ELECTRON_RUN_AS_NODE = "1";
    if (this.options.apiKey) env.DEEPSEEK_API_KEY = this.options.apiKey;
    if (this.options.baseUrl) env.DEEPSEEK_BASE_URL = this.options.baseUrl;

    const child = spawn(nodeExe, [hostScript], {
      cwd: this.options.workspaceRoot,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.output.appendLine(`[host] spawned: ${nodeExe} ${hostScript} (cwd=${this.options.workspaceRoot})`);

    child.stderr.on("data", (d) => {
      this.output.appendLine(String(d).replace(/\n$/, ""));
      this.emit({ type: "log", level: "stderr", message: String(d) });
    });
    child.on("error", (err) => {
      this.output.appendLine(`[host] spawn error: ${err.message}`);
      this.emit({ type: "exit", code: 1, error: err.message });
    });
    child.on("close", (code) => {
      this.output.appendLine(`[host] exited with code ${code}`);
      this.child = null;
      this.rl?.close();
      this.rl = null;
      this.turns.clear();
      // bundle 版启动失败（非零退出）时静默回退到源文件重启一次：
      // bundle 与源文件行为等价，仅在打包/构建不一致时可能失败，回退可自愈。
      if (
        code !== 0 &&
        this.fallbackHostScript &&
        this.hostScript !== this.fallbackHostScript
      ) {
        this.output.appendLine("[host] bundle failed, falling back to source host…");
        this.hostScript = this.fallbackHostScript;
        void this.start();
        return;
      }
      this.fallbackHostScript = undefined;
      this.emit({ type: "exit", code: code ?? 1 });
    });

    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: HostFrame;
      try {
        frame = JSON.parse(line) as HostFrame;
      } catch {
        this.output.appendLine(`[host] unparseable: ${line.slice(0, 200)}`);
        return;
      }
      this.handleFrame(frame);
    });
  }

  private handleFrame(frame: HostFrame) {
    switch (frame.t) {
      case "ready": {
        // 会话切换（新会话/恢复其他会话）时重置统计。
        // 例外：若刚重放过该会话的历史（resume 时序：history 帧先到、ready 帧后到），
        // 统计已由 history 重放累计，这里不能重置，否则 UI 的 token 统计会消失。
        if (frame.sessionId !== this.readySessionId && frame.sessionId !== this.lastHistorySessionId) {
          this.stats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
        }
        this.lastHistorySessionId = undefined;
        this.readySessionId = frame.sessionId;
        this.emit({
          type: "ready",
          sessionId: frame.sessionId,
          model: frame.model,
          provider: frame.provider,
          cwd: frame.cwd,
          sessionTitle: frame.sessionTitle,
        });
        break;
      }
      case "status": {
        this.emit({ type: "status", status: frame.status });
        break;
      }
      case "events": {
        for (const event of frame.events) {
          this.trackStats(event);
          const view = this.translateEvent(event);
          if (view) this.emit({ type: "view", event: view });
        }
        break;
      }
      case "approval": {
        this.emit({
          type: "approval",
          id: frame.id,
          toolName: frame.toolName,
          reason: frame.reason,
          callId: frame.callId,
          agentId: frame.agentId,
        });
        break;
      }
      case "approvalGone": {
        this.emit({ type: "approvalGone", id: frame.id });
        break;
      }
      case "chatDone": {
        const pending = this.pendingChat.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingChat.delete(frame.id);
          pending.resolve(frame.ok);
        }
        break;
      }
      case "stopAck": {
        break;
      }
      case "sessions": {
        this.emit({ type: "sessions", list: frame.list, error: frame.error });
        break;
      }
      case "history": {
        const viewEvents: ViewEvent[] = [];
        this.lastHistorySessionId = frame.sessionId;
        for (const event of frame.events) {
          this.trackStats(event);
          const view = this.translateEvent(event, { includeUser: true, history: true });
          if (view) viewEvents.push(view);
        }
        // 分页模式下宿主已提供完整统计快照（host 侧只有部分事件无法累计），
        // 有快照时直接采用；否则用重放事件的累计值。
        if (frame.stats) {
          this.stats = { ...frame.stats };
        }
        this.emit({
          type: "history",
          sessionId: frame.sessionId,
          events: viewEvents,
          hasMore: frame.hasMore,
          nextSeq: frame.nextSeq,
        });
        // 重放历史后推送累计统计（标题/token/上下文窗口）
        this.emitStats();
        break;
      }
      case "historyMore": {
        const viewEvents: ViewEvent[] = [];
        for (const event of frame.events) {
          const view = this.translateEvent(event, { includeUser: true, history: true });
          if (view) viewEvents.push(view);
        }
        this.emit({
          type: "historyMore",
          sessionId: frame.sessionId,
          events: viewEvents,
          hasMore: frame.hasMore,
          nextSeq: frame.nextSeq,
        });
        break;
      }
      case "sessionResumed": {
        this.emit({ type: "sessionResumed", id: frame.id, ok: frame.ok, error: frame.error });
        break;
      }
      case "sessionDeleted": {
        this.emit({ type: "sessionDeleted", id: frame.id, ok: frame.ok, error: frame.error });
        break;
      }
      case "sessionExported": {
        this.emit({ type: "sessionExported", id: frame.id, ok: frame.ok, path: frame.path, error: frame.error });
        break;
      }
      case "modelInfo": {
        this.emit({
          type: "modelInfo",
          providers: frame.providers,
          models: frame.models,
          current: frame.current,
        });
        break;
      }
      case "modelChanged": {
        this.emit({
          type: "modelChanged",
          provider: frame.provider,
          model: frame.model,
          reasoningEffort: frame.reasoningEffort,
        });
        break;
      }
      case "workModeChanged": {
        this.emit({ type: "workModeChanged", mode: frame.mode });
        break;
      }
      case "compactDone": {
        this.emit({ type: "compactDone", ok: frame.ok, text: frame.text, error: frame.error });
        break;
      }
      case "exit": {
        this.emit({ type: "exit", code: frame.code, error: frame.error });
        break;
      }
    }
  }

  /** 从会话事件中累计统计（标题 / token 用量 / 上下文窗口）。 */
  private trackStats(event: SessionEvent): void {
    const d = event.data as Record<string, any>;
    switch (event.type) {
      case "session/title": {
        const title = typeof d.title === "string" ? d.title : "";
        if (title && title !== this.stats.title) {
          this.stats.title = title;
          this.emitStats();
        }
        break;
      }
      case "assistant/message": {
        const usage = d.usage as
          | { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number }
          | undefined;
        if (!usage) break;
        const input = Number(usage.inputTokens) || 0;
        const cache = Number(usage.cacheReadTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        if (input || cache || output) {
          this.stats.inputTokens += input;
          this.stats.cacheReadTokens += cache;
          this.stats.outputTokens += output;
          // 上下文占用 ≈ 最近一次请求的输入（含缓存读取）
          this.stats.lastRequestInput = input + cache;
          this.emitStats();
        }
        break;
      }
      case "request/context": {
        const ctx = d as { contextWindow?: number; model?: string };
        if (typeof ctx.contextWindow === "number" && ctx.contextWindow > 0) {
          if (ctx.contextWindow !== this.stats.contextWindow) {
            this.stats.contextWindow = ctx.contextWindow;
            this.emitStats();
          }
        }
        if (typeof ctx.model === "string" && ctx.model) {
          this.stats.model = ctx.model;
        }
        break;
      }
    }
  }

  private emitStats(): void {
    this.emit({ type: "stats", stats: { ...this.stats } });
  }

  /** 把 DSH 会话事件翻译为 UI 视图事件（含流式增量聚合）。 */
  private translateEvent(
    event: SessionEvent,
    opts?: { includeUser?: boolean; history?: boolean }
  ): ViewEvent | null {
    const d = event.data as Record<string, any>;
    switch (event.type) {
      case "user/message": {
        // 实时会话中用户消息由 UI 在发送时本地渲染；历史重放时则需要渲染
        if (!opts?.includeUser) return null;
        const text = blocksToText(d.content);
        if (!text) return null;
        return { kind: "user", text, ts: event.time };
      }
      case "turn/start": {
        const turn = d.turn as number;
        if (opts?.history) return null; // 历史重放不需要 turn 状态机
        this.turns.set(turn, { turn, text: "", reasoning: "", tools: new Map(), chunkSeq: 0, ts: event.time });
        return { kind: "turn", status: "start", ts: event.time };
      }
      case "turn/end": {
        const turn = d.turn as number;
        this.turns.delete(turn);
        const reason = d.reason as { kind?: string; error?: { message?: string; code?: string } } | undefined;
        const kind = reason?.kind ?? "unknown";
        if (kind === "error") {
          const message = reason?.error?.message ?? "unknown error";
          const code = reason?.error?.code ?? "UNKNOWN";
          const hint = code === "MISSING_CREDENTIAL" || /api[ _-]?key/i.test(message)
            ? "\n\n> 💡 No usable API key was found. Open Settings (gear icon, top-right) and enter your DeepSeek API key, then retry."
            : "";
          return { kind: "error", text: `Model call failed (${code}): ${message}${hint}`, ts: event.time };
        }
        return { kind: "turn", status: "end", reason: kind, ts: event.time };
      }
      case "assistant/chunk": {
        const turn = d.turn as number;
        const state = this.turns.get(turn);
        if (!state) return null;
        const chunk = d.chunk as { type: string; text?: string; argumentsDelta?: string; index?: number };
        if (chunk.type === "text-delta" && chunk.text) {
          state.text += chunk.text;
          return { kind: "assistant-delta", text: chunk.text, reasoning: "", ts: event.time };
        }
        if (chunk.type === "reasoning-delta" && chunk.text) {
          state.reasoning += chunk.text;
          return { kind: "assistant-delta", text: "", reasoning: chunk.text, ts: event.time };
        }
        return null;
      }
      case "assistant/message": {
        const turn = d.turn as number;
        const message = d.message as { content?: unknown[] } | undefined;
        const text = blocksToText(message?.content);
        let reasoning = blocksToText(message?.content, "reasoning");
        const usage = d.usage as Record<string, number> | undefined;
        // 纯工具调用回合：既无文本也无思考，UI 无需创建消息气泡
        if (!text && !reasoning) return null;
        // 思考过程：历史重放完整显示（分页后单批不大），仅防御极端超长单条
        const reasoningMax = opts?.history ? 20000 : 3000;
        if (reasoning.length > reasoningMax) {
          reasoning = reasoning.slice(0, reasoningMax) + "\n… (truncated)";
        }
        if (opts?.history) {
          // 历史重放没有 chunk 流，每条 assistant/message 都是完整消息，
          // 必须全部返回完整文本（不能用 turn 累积状态判断，否则只显示第一条）。
          return { kind: "assistant", text, reasoning, usage, ts: event.time };
        }
        const state = this.turns.get(turn);
        if (state) {
          // 流式模式下 UI 已按 delta 渲染；仅当全程没有 chunk 时补发完整文本
          const needFull = !state.text && text !== "";
          if (needFull) state.text = text;
          return { kind: "assistant", text: needFull ? text : "", reasoning, usage, ts: event.time };
        }
        return { kind: "assistant", text, reasoning, usage, ts: event.time };
      }
      case "tool/call": {
        const callId = d.callId as string;
        const name = d.name as string;
        let args = d.arguments as string;
        const turn = d.turn as number;
        const state = this.turns.get(turn);
        if (state) {
          state.tools.set(callId, { callId, name, args, ts: event.time });
        }
        if (opts?.history && args.length > 10000) {
          args = args.slice(0, 10000) + "\n… (truncated)";
        }
        return { kind: "tool-call", callId, name, args, ts: event.time };
      }
      case "tool/result": {
        // tool/result 的 message 结构：callId 在 message.source.callId，
        // 结果文本嵌套在 content[].content 里（tool-result 块包裹）
        const message = d.message as {
          source?: { callId?: string };
          content?: unknown[];
          isError?: boolean;
        } | undefined;
        const callId =
          message?.source?.callId ?? (message?.content?.[0] as { toolCallId?: string } | undefined)?.toolCallId ?? "";
        const ok = !(message?.isError || d.error);
        let text = toolResultText(message?.content);
        const turn = d.turn as number;
        const state = this.turns.get(turn);
        if (state) {
          const tool = state.tools.get(callId);
          if (tool) {
            tool.resultText = text;
            tool.resultOk = ok;
          }
        }
        // 工具结果过大时截断传输（分页后单批不大，仅防御极端超长单条）
        const resultMax = opts?.history ? 20000 : 8000;
        if (text.length > resultMax) {
          text = text.slice(0, resultMax) + "\n… (truncated)";
        }
        return { kind: "tool-result", callId, ok, text, ts: event.time };
      }
      case "todo/write": {
        const todos = (d.todos as { content: string; status: string }[]).map((t) => ({
          content: t.content,
          status: t.status as "pending" | "in_progress" | "completed",
        }));
        return { kind: "todo", todos, ts: event.time };
      }
      default:
        return null;
    }
  }

  /** 发送聊天消息；resolve 于该轮完成。 */
  async chat(text: string): Promise<boolean> {
    if (!this.child) throw new Error("agent host is not running");
    const id = ++this.chatSeq;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingChat.delete(id);
        resolve(false);
      }, 30 * 60 * 1000); // 30 分钟兜底
      this.pendingChat.set(id, { resolve, timer });
      this.send({ t: "chat", id, text });
    });
  }

  stop(): void {
    this.send({ t: "stop", id: ++this.chatSeq });
  }

  approve(id: number, approve: boolean): void {
    this.send({ t: "approval:resolve", id, approve });
  }

  newSession(model?: string): void {
    this.send({ t: "newSession", model });
  }

  listSessions(): void {
    this.send({ t: "listSessions" });
  }

  resumeSession(id: string, model?: string): void {
    this.send({ t: "resumeSession", id, model });
  }

  /** 请求加载更早的历史事件（向上滚动时分页）。 */
  loadMoreHistory(beforeSeq: number): void {
    this.send({ t: "loadMoreHistory", id: ++this.chatSeq, beforeSeq });
  }

  deleteSession(id: string): void {
    this.send({ t: "deleteSession", id });
  }

  exportSession(id: string): void {
    this.send({ t: "exportSession", id });
  }

  /** 请求宿主上报可用的 provider / model 列表与当前选择（下拉选择器数据源）。 */
  getModelInfo(): void {
    this.send({ t: "getModelInfo" });
  }

  /** 切换模型选择（provider / model / 思考等级；对下一次请求生效）。 */
  setModel(opts: { provider?: string; model?: string; reasoningEffort?: string }): void {
    this.send({ t: "setModel", ...opts });
  }

  /** 切换工作模式（single / multi-agent 编排）。 */
  setWorkMode(mode: "single" | "multi"): void {
    this.send({ t: "setWorkMode", mode });
  }

  /** 触发一次手动上下文压缩（/compact）。 */
  compact(): void {
    this.send({ t: "compact", id: ++this.chatSeq });
  }

  private send(frame: ExtensionFrame): void {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  /** 关闭子进程（发 shutdown，等待退出，超时强杀）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    this.send({ t: "shutdown" });
    const exited = new Promise<void>((resolve) => {
      const onClose = () => {
        resolve();
      };
      child.once("close", onClose);
      setTimeout(() => {
        child.removeListener("close", onClose);
        resolve();
      }, 5000);
    });
    await exited;
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // 已退出
      }
    }
    this.child = null;
  }
}

/** 从内容块中提取文本。 */
function blocksToText(content: unknown[] | undefined, type: string = "text"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === type)
    .map((b) => (b as { text?: string }).text ?? "")
    .join("");
}

/** 提取工具结果文本：文本可能直接是 text 块，也可能嵌套在 tool-result 块的 content 里。 */
function toolResultText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; content?: unknown[] };
    if (b.type === "text" && b.text) out.push(b.text);
    else if (b.type === "tool-result" && Array.isArray(b.content)) {
      out.push(toolResultText(b.content));
    }
  }
  return out.join("");
}
