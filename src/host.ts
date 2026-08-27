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
  ProviderApplyItem,
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
  /** 单次任务最大思考轮次（0 = 不限制；宿主在 step/start 计数超限时自动取消）。 */
  maxSteps?: number;
  /** 子代理递归深度上限（tool-subagent maxDepth）。 */
  subagentMaxDepth?: number;
  /** 多 agent 模式并行子代理数量上限（prompt 级约束）。 */
  maxParallelSubagents?: number;
  /** 自动授权规则（工具级 {match, action}；Kilo Code 风格）。 */
  autoApproveRules?: { match: string; action: string }[];
  /** 上下文自动压缩：是否启用。 */
  autoCompaction?: boolean;
  /** 上下文自动压缩触发比例（contextWindow 占比，0~1）。 */
  compactionThresholdRatio?: number;
  /** 上下文自动压缩摘要的 token 上限。 */
  compactionMaxTokens?: number;
  /** 插件专属的 DSH home 目录（会话/配置均存于此，与官方 dsh 完全隔离）。 */
  dshHome: string;
  /** 旧 DSH home（用于一次性迁移历史会话）。 */
  legacyDshHome?: string;
  /** 用户采纳的 DSH 运行时闭包 node_modules 目录（未设置 = 用 VSIX 内置）。 */
  runtimeNodeModulesPath?: string;
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
  | { type: "viewSession"; id: string }
  | { type: "viewSessionFailed"; id: string; error?: string }
  | { type: "sessionRenamed"; id: string; ok: boolean; title?: string; error?: string }
  | { type: "sessionTitleSynced"; id: string; title: string }
  | { type: "sessionDeleted"; id: string; ok: boolean; error?: string }
  | { type: "sessionExported"; id: string; ok: boolean; path?: string; error?: string }
  | { type: "stats"; stats: SessionStats }
  | {
      type: "modelInfo";
      providers: { id: string; name: string }[];
      models: string[];
      providerModels?: Record<string, { id: string; name: string }[]>;
      current: { provider: string; model: string; reasoningEffort?: string; supportedEfforts?: string[]; defaultEffort?: string };
    }
  | { type: "modelChanged"; provider: string; model: string; reasoningEffort?: string; error?: string }
  | { type: "workModeChanged"; mode: "single" | "multi" }
  | { type: "compactDone"; ok: boolean; text?: string; error?: string }
  | { type: "stepLimit"; maxSteps: number; steps: number }
  | { type: "modelAdapted"; provider: string; model: string; from: string; to: string }
  | { type: "exit"; code: number; error?: string }
  | { type: "log"; level: string; message: string };

/** 探测一个可用的 Node 可执行文件（结果缓存：扩展生命周期内只探测一次）。
 *  导出供 DSH 运行时自检复用同一解析逻辑（含 ELECTRON_RUN_AS_NODE 分支）。 */
let cachedNode: string | null | undefined;
let cachedNodeVersion: string | null | undefined;
export async function resolveNode(nodePath: string | undefined): Promise<string | null> {
  if (cachedNode !== undefined) return cachedNode;
  const candidates: string[] = [];
  if (nodePath && nodePath.trim() !== "") candidates.push(nodePath.trim());
  candidates.push("node"); // PATH 中的 node（spawn 会解析）
  for (const candidate of candidates) {
    try {
      const result = await new Promise<{ path: string; version: string } | null>((resolve) => {
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
          const match = /v(\d+)\.(\d+)/.exec(out || err);
          const major = match ? Number(match[1]) : 0;
          resolve(code === 0 && major >= 20 ? { path: candidate, version: match?.[0] ?? "" } : null);
        });
      });
      if (result) {
        cachedNode = result.path;
        cachedNodeVersion = result.version;
        return result.path;
      }
    } catch {
      // 继续探测下一个
    }
  }
  cachedNode = null;
  return null;
}

/** 探测到的宿主 Node 是否支持 module.registerHooks（≥22.12）。 */
export function nodeSupportsRegisterHooks(): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(cachedNodeVersion ?? "");
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 22 || (major === 22 && minor >= 12);
}

/** 宿主 ESM 重定向器的统一加载参数（跨平台；唯一决策点，各处复用）。
 *  Node ≥22.12 用 `-r` CJS preload（registerHooks，规避 Node 24 Windows 的 main 加载回归）；
 *  旧 Node 回退 --experimental-loader（mjs 薄壳 re-export cjs 的 resolve）。 */
export function hostLoaderArgs(extensionPath: string): string[] {
  return nodeSupportsRegisterHooks()
    ? ["-r", path.join(extensionPath, "host", "runtime-redirector.cjs")]
    : ["--experimental-loader", path.join(extensionPath, "host", "runtime-redirector.mjs")];
}

/**
 * 共享输出通道：所有 AgentHost 实例**复用同一个** channel（模块级单例）。
 *
 * 为什么单例：宿主会因配置变更/工作区切换/自动重启而频繁重建。若每次构造都
 * `createOutputChannel("ay-dsh-vscode Host")`，会生成多个同名 channel——输出面板
 * 仍停留在旧 channel 视图，新宿主的日志写进新 channel，表现为"重启后输出界面
 * 不再输出"。单例化后：重启日志继续追加到同一面板、历史保留、无同名堆积。
 * 刻意不 dispose：保留跨重启日志历史，有助于问题定位（扩展停用时由 VS Code
 * 自行回收）。
 */
let sharedOutputChannel: vscode.OutputChannel | undefined;
export function getOutputChannel(): vscode.OutputChannel {
  if (!sharedOutputChannel) {
    sharedOutputChannel = vscode.window.createOutputChannel("ay-dsh-vscode Host");
  }
  return sharedOutputChannel;
}

export class AgentHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private output: vscode.OutputChannel;
  private eventListeners = new Set<(e: HostEvent) => void>();
  private chatSeq = 0;
  private pendingChat = new Map<number, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  /** 历史图片附件读取（attachment ref → base64）：一次性请求-响应。 */
  private pendingAttachment = new Map<number, { resolve: (data: string | undefined) => void; timer: NodeJS.Timeout }>();
  /** 提供商目录查询（配置面板用）：一次性请求-响应。 */
  private llmSeq = 0;
  private pendingLlmProviders = new Map<number, { resolve: (p: { id: string; name: string }[]) => void }>();
  /** 提供商配置同步（providersApply → providersApplied）。 */
  private pendingProviderApply = new Map<number, { resolve: (err: string | undefined) => void }>();
  /** 模型发现（discoverModels → discoveredModels）。 */
  private pendingDiscoverModels = new Map<number, { resolve: (r: { models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]; error?: string }) => void }>();
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
  private stats: SessionStats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
  /** Agent 是否正在运行（status 帧维护；供 DSH 更新检测器做"空闲门控"）。 */
  private running = false;

  /** Agent 是否正在运行（status 帧维护；供 DSH 更新检测器做"空闲门控"）。 */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 构造时解析的运行时闭包 node_modules 路径（undefined = 用 VSIX 内置）。
   * 注意这是**创建时刻的快照**：崩溃回退/reset 等状态变更后不会自动更新，
   * 调用方须销毁本实例并重建（见 extension.ts ensureHost 的一致性检查）。
   */
  get runtimeNodeModulesPath(): string | undefined {
    return this.options.runtimeNodeModulesPath;
  }

  constructor(private readonly options: AgentHostOptions, private readonly ctx: vscode.ExtensionContext) {
    // 复用共享单例 channel：宿主重启后日志继续输出到同一面板（不新建同名 channel）
    this.output = getOutputChannel();
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
    // 首次启动选脚本：优先 bundle（单文件冷启动快）；不存在时用源文件。
    // bundle 启动失败回退源文件后（close 里已改 hostScript），此处不再重选，
    // 避免 fallback 死循环：start 重选 bundle → 崩 → fallback → 再重选 bundle → …
    if (!this.hostScript) {
      const bundlePath = path.join(this.options.extensionPath, "host", "agent-host.bundle.mjs");
      const sourcePath = path.join(this.options.extensionPath, "host", "agent-host.mjs");
      this.hostScript = fs.existsSync(bundlePath) ? bundlePath : sourcePath;
      this.fallbackHostScript = fs.existsSync(bundlePath) && fs.existsSync(sourcePath) ? sourcePath : undefined;
    }
    const hostScript = this.hostScript;
    const nodeExe = (await resolveNode(this.options.nodePath)) ?? process.execPath;
    const useElectronNode = nodeExe === process.execPath;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.options.dshHome,
      DSH_VSCODE_MODEL: this.options.model,
      DSH_PERMISSION_MODE: this.options.permissionMode,
      DSH_MAX_STEPS: String(this.options.maxSteps ?? 100),
      DSH_LOCALE: vscode.env.language.startsWith("zh") ? "zh" : "en",
      DSH_SUBAGENT_MAX_DEPTH: String(this.options.subagentMaxDepth ?? 3),
      DSH_MAX_PARALLEL_SUBAGENTS: String(this.options.maxParallelSubagents ?? 5),
      DSH_AUTO_APPROVE: JSON.stringify(this.options.autoApproveRules ?? []),
      DSH_COMPACTION_AUTO: String(this.options.autoCompaction ?? true),
      DSH_COMPACTION_THRESHOLD_RATIO: String(this.options.compactionThresholdRatio ?? 0.8),
      DSH_COMPACTION_MAX_TOKENS: String(this.options.compactionMaxTokens ?? 8192),
      DSH_TELEMETRY_DISABLED: "1",
      // 统一子进程文本编码为 UTF-8：Windows PowerShell 5.1 / Python 默认按
      // 系统代码页（GBK）输出中文，Node 侧按 UTF-8 读取会乱码。
      // 这些环境变量让工具子进程（pwsh/python）直接输出 UTF-8。
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      POWERSHELL_TELEMETRY_OPTOUT: "1",
    };
    if (this.options.legacyDshHome) env.DSH_LEGACY_HOME = this.options.legacyDshHome;
    if (this.options.runtimeNodeModulesPath) env.DSH_RUNTIME_NODE_MODULES = this.options.runtimeNodeModulesPath;
    if (useElectronNode) env.ELECTRON_RUN_AS_NODE = "1";
    if (this.options.apiKey) env.DEEPSEEK_API_KEY = this.options.apiKey;
    if (this.options.baseUrl) env.DEEPSEEK_BASE_URL = this.options.baseUrl;

    // 运行时升级（机制 A，见决策文档 1.4.3）：把 DSH 依赖集解析到用户采纳的闭包目录。
    // 加载参数统一由 hostLoaderArgs 决策（Node ≥22.12 用 -r CJS preload 规避 Node 24
    // Windows 的 main 加载回归；旧 Node 回退 --experimental-loader）。
    const runtime = this.options.runtimeNodeModulesPath;
    const spawnArgs = runtime ? [...hostLoaderArgs(this.options.extensionPath), hostScript] : [hostScript];
    const child = spawn(nodeExe, spawnArgs, {
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
      this.readySessionId = undefined; // 宿主已退出：会话 id 失效（重启后由 webviewPanel 以 storedSessionId 恢复）
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
          this.stats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
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
        this.running = frame.status === "running";
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
      case "attachmentResult": {
        const pending = this.pendingAttachment.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAttachment.delete(frame.id);
          pending.resolve(frame.ok ? frame.data : undefined);
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
      case "viewSession": {
        this.emit({ type: "viewSession", id: frame.id });
        break;
      }
      case "viewSessionFailed": {
        this.emit({ type: "viewSessionFailed", id: frame.id, error: frame.error });
        break;
      }
      case "sessionRenamed": {
        this.emit({ type: "sessionRenamed", id: frame.id, ok: frame.ok, title: frame.title, error: frame.error });
        break;
      }
      case "sessionTitleSynced": {
        this.emit({ type: "sessionTitleSynced", id: frame.id, title: frame.title });
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
          providerModels: frame.providerModels,
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
      case "stats": {
        // 宿主主动推送的统计快照（如压缩完成后立即刷新上下文占用）
        this.stats = { ...this.stats, ...frame.stats };
        this.emitStats();
        break;
      }
      case "compactDone": {
        this.emit({ type: "compactDone", ok: frame.ok, text: frame.text, error: frame.error });
        break;
      }
      case "llmProviders": {
        const pending = this.pendingLlmProviders.get(frame.id);
        if (pending) {
          this.pendingLlmProviders.delete(frame.id);
          pending.resolve(frame.providers ?? []);
        }
        break;
      }
      case "discoveredModels": {
        const pending = this.pendingDiscoverModels.get(frame.id);
        if (pending) {
          this.pendingDiscoverModels.delete(frame.id);
          pending.resolve({ models: frame.models ?? [], error: frame.error });
        }
        break;
      }
      case "providersApplied": {
        const pending = this.pendingProviderApply.get(frame.id);
        if (pending) {
          this.pendingProviderApply.delete(frame.id);
          pending.resolve(frame.ok ? undefined : frame.error ?? "apply failed");
        }
        break;
      }
      case "stepLimit": {
        this.emit({ type: "stepLimit", maxSteps: frame.maxSteps, steps: frame.steps });
        break;
      }
      case "modelAdapted": {
        this.emit({ type: "modelAdapted", provider: frame.provider, model: frame.model, from: frame.from, to: frame.to });
        break;
      }
      case "exit": {
        this.emit({ type: "exit", code: frame.code, error: frame.error });
        break;
      }
    }
  }

  /** 从会话事件中累计统计（标题 / token 用量 / 上下文窗口 / API 调用次数）。 */
  private trackStats(event: SessionEvent): void {
    const d = event.data as Record<string, any>;
    switch (event.type) {
      case "step/start": {
        this.stats.steps = (this.stats.steps ?? 0) + 1;
        this.emitStats();
        break;
      }
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
        const images = extractImageRefs(d.content);
        if (!text && images.length === 0) return null;
        return { kind: "user", text, images, ts: event.time };
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
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end": {
        // 上下文自动/手动压缩：桥接成 view event，供扩展在状态栏即时提示
        // （用户不必盯着顶部提示区，压缩在后台进行也能感知到）。
        // summary 事件携带被压缩掉的 token 数（shadowedTokenCount），用于完成提示的具体指标。
        const d = event.data as { error?: string; shadowedTokenCount?: number } | undefined;
        return {
          kind: "compaction",
          phase: event.type === "compaction/start" ? "start" : event.type === "compaction/summary" ? "summary" : "end",
          ok: d?.error === undefined,
          error: typeof d?.error === "string" ? d.error : undefined,
          tokens: typeof d?.shadowedTokenCount === "number" ? d.shadowedTokenCount : undefined,
          ts: event.time,
        };
      }
      default:
        return null;
    }
  }

  /** 发送聊天消息（可带图片附件：base64+mediaType+name）；resolve 于该轮完成。 */
  async chat(text: string, images?: { data: string; mediaType: string; name?: string }[]): Promise<boolean> {
    if (!this.child) throw new Error("agent host is not running");
    const id = ++this.chatSeq;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingChat.delete(id);
        resolve(false);
      }, 30 * 60 * 1000); // 30 分钟兜底
      this.pendingChat.set(id, { resolve, timer });
      this.send({ t: "chat", id, text, images });
    });
  }

  stop(): void {
    this.send({ t: "stop", id: ++this.chatSeq });
  }

  /** 读取历史图片附件（attachment ref → base64）。 */
  readAttachment(ref: { attachmentId: string; mediaType: string; bytes?: number; width?: number; height?: number }): Promise<string | undefined> {
    return new Promise((resolve) => {
      const id = ++this.chatSeq;
      this.pendingAttachment.set(id, { resolve, timer: setTimeout(() => {
        if (this.pendingAttachment.delete(id)) resolve(undefined);
      }, 8000) });
      this.send({ t: "readAttachment", id, ref });
    });
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

  /** 只读浏览一个会话（子代理会话）：不创建 agent、不改全局宿主状态。 */
  viewSession(id: string): void {
    this.send({ t: "viewSession", id });
  }

  /** 恢复预览（Reload 自动恢复）：只读分页秒显历史，agent 懒 resume（发消息时）。 */
  restorePreview(id: string): void {
    this.send({ t: "restorePreview", id });
  }

  /** 请求加载更早的历史事件（向上滚动时分页；只读浏览子代理会话时带 sessionId）。 */
  loadMoreHistory(beforeSeq: number, sessionId?: string): void {
    this.send({ t: "loadMoreHistory", id: ++this.chatSeq, beforeSeq, sessionId });
  }

  deleteSession(id: string): void {
    this.send({ t: "deleteSession", id });
  }

  renameSession(id: string, title: string): void {
    this.send({ t: "renameSession", id, title });
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

  /** 查询 DSH 提供商目录（已注册路由 + 可配置目录合并；配置面板 Provider ID 下拉用）。 */
  llmProviders(): Promise<{ id: string; name: string }[]> {
    return new Promise((resolve) => {
      const id = ++this.llmSeq;
      this.pendingLlmProviders.set(id, { resolve });
      this.send({ t: "llmProviders", id });
      setTimeout(() => {
        if (this.pendingLlmProviders.delete(id)) resolve([]);
      }, 8000);
    });
  }

  /**
   * 把整套提供商配置同步进 DSH（写入 llm-pi-ai settings + credentials，热生效）。
   * 返回 undefined 表示成功，否则为错误信息；宿主未就绪时 8s 超时视为失败。
   */
  applyProviders(providers: ProviderApplyItem[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const id = ++this.llmSeq;
      this.pendingProviderApply.set(id, { resolve });
      this.send({ t: "providersApply", id, providers });
      setTimeout(() => {
        if (this.pendingProviderApply.delete(id)) resolve("timeout");
      }, 8000);
    });
  }

  /** 模型发现（catalog 提供商免网络返回模型+元数据；未知提供商探活端点）。 */
  discoverModels(opts: { provider?: string; baseURL?: string; api?: string; apiKey?: string }): Promise<{ models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]; error?: string }> {
    return new Promise((resolve) => {
      const id = ++this.llmSeq;
      this.pendingDiscoverModels.set(id, { resolve });
      this.send({ t: "discoverModels", id, ...opts });
      setTimeout(() => {
        if (this.pendingDiscoverModels.delete(id)) resolve({ models: [], error: "timeout" });
      }, 8000);
    });
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

/** 从内容块中提取图片附件引用（image 块的 attachment：{attachmentId, mediaType}）。 */
function extractImageRefs(content: unknown[] | undefined): { attachmentId: string; mediaType: string; bytes?: number; width?: number; height?: number }[] {
  if (!Array.isArray(content)) return [];
  const refs: { attachmentId: string; mediaType: string; bytes?: number; width?: number; height?: number }[] = [];
  const walk = (blocks: unknown[]): void => {
    for (const b of blocks) {
      const blk = b as { type?: string; attachment?: { attachmentId?: string; mediaType?: string; bytes?: number; width?: number; height?: number }; content?: unknown[] };
      if (blk?.type === "image" && blk.attachment?.attachmentId) {
        refs.push({
          attachmentId: blk.attachment.attachmentId,
          mediaType: blk.attachment.mediaType || "image/png",
          bytes: blk.attachment.bytes,
          width: blk.attachment.width,
          height: blk.attachment.height,
        });
      } else if (Array.isArray(blk?.content)) {
        walk(blk.content as unknown[]);
      }
    }
  };
  walk(content);
  return refs;
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
