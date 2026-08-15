/**
 * protocol.ts — 扩展 <-> agent-host 子进程之间的 JSONL 协议类型。
 * 协议线格式：stdout/stderr 上的逐行 JSON。
 */

/** 会话事件（来自 @deepseek-ai/dsh-session 的原始形状，UI 侧按需消费）。 */
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/** 会话摘要（历史列表项）。 */
export interface SessionSummary {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  live: boolean;
}

/** 会话统计（host 侧随事件流累计，推送给 UI 渲染顶部信息栏）。 */
export interface SessionStats {
  /** 会话标题（来自 session/title 事件）。 */
  title?: string;
  /** 累计输入 token（未命中缓存）。 */
  inputTokens: number;
  /** 累计缓存读取 token。 */
  cacheReadTokens: number;
  /** 累计输出 token。 */
  outputTokens: number;
  /** 当前模型的上下文窗口大小（来自 request/context 事件）。 */
  contextWindow?: number;
  /** 最近一次请求的输入 token（含缓存读取），用于上下文占用占比。 */
  lastRequestInput?: number;
  /** 当前模型（用于价格估算）。 */
  model?: string;
}

/** Host -> Extension */
export type HostFrame =
  | { t: "ready"; sessionId: string; cwd: string; provider: string; model: string; version: string; sessionTitle?: string }
  | { t: "events"; events: SessionEvent[] }
  | { t: "status"; status: "idle" | "running" }
  | { t: "approval"; id: number; toolName: string; callId?: string; reason?: string }
  | { t: "approvalGone"; id: number }
  | { t: "chatDone"; id: number; ok: boolean; error?: string }
  | { t: "stopAck"; id: number }
  | { t: "sessions"; list: SessionSummary[]; error?: string }
  | { t: "history"; sessionId: string; events: SessionEvent[]; hasMore?: boolean; nextSeq?: number; stats?: SessionStats }
  | { t: "historyMore"; sessionId: string; events: SessionEvent[]; hasMore?: boolean; nextSeq?: number }
  | { t: "sessionResumed"; id: string; ok: boolean; error?: string }
  | { t: "sessionDeleted"; id: string; ok: boolean; error?: string }
  | { t: "sessionExported"; id: string; ok: boolean; path?: string; error?: string }
  | { t: "modelInfo"; providers: { id: string; name: string }[]; models: string[]; current: { provider: string; model: string; reasoningEffort?: string } }
  | { t: "modelChanged"; provider: string; model: string; reasoningEffort?: string }
  | { t: "workModeChanged"; mode: "single" | "multi" }
  | { t: "compactDone"; id: number; ok: boolean; text?: string; error?: string }
  | { t: "exit"; code: number; error?: string };

/** Extension -> Host */
export type ExtensionFrame =
  | { t: "chat"; id: number; text: string }
  | { t: "stop"; id: number }
  | { t: "approval:resolve"; id: number; approve: boolean }
  | { t: "newSession"; model?: string }
  | { t: "listSessions" }
  | { t: "resumeSession"; id: string; model?: string; limit?: number }
  | { t: "loadMoreHistory"; id: number; beforeSeq: number; limit?: number }
  | { t: "deleteSession"; id: string }
  | { t: "exportSession"; id: string }
  | { t: "setModel"; provider?: string; model?: string; reasoningEffort?: string }
  | { t: "getModelInfo" }
  | { t: "setWorkMode"; mode: "single" | "multi" }
  | { t: "compact"; id: number }
  | { t: "shutdown" };

/** 面向 UI 的渲染事件（webview <-> 扩展之间），由扩展把 SessionEvent 翻译成视图模型。 */
export type ViewEvent =
  | { kind: "user"; text: string; ts: number }
  | { kind: "assistant-delta"; text: string; reasoning: string; ts: number }
  | { kind: "assistant"; text: string; reasoning: string; usage?: Record<string, number>; ts: number }
  | { kind: "error"; text: string; ts: number }
  | { kind: "tool-call"; callId: string; name: string; args: string; ts: number }
  | { kind: "tool-result"; callId: string; ok: boolean; text: string; ts: number }
  | { kind: "todo"; todos: { content: string; status: "pending" | "in_progress" | "completed" }[]; ts: number }
  | { kind: "turn"; status: "start" | "end"; reason?: string; ts: number };

/** Webview -> Extension 的消息。 */
export type WebviewMessage =
  | { t: "chat"; text: string }
  | { t: "stop" }
  | { t: "approval:resolve"; id: number; approve: boolean }
  | { t: "newSession" }
  | { t: "configure" }
  | { t: "openWorkspace" }
  | { t: "history" }
  | { t: "historyClose" }
  | { t: "historyRefresh" }
  | { t: "resumeSession"; id: string }
  | { t: "loadMoreHistory"; beforeSeq: number }
  | { t: "deleteSession"; id: string }
  | { t: "exportSession"; id: string }
  | { t: "setModel"; provider?: string; model?: string; reasoningEffort?: string }
  | { t: "setWorkMode"; mode: "single" | "multi" }
  | { t: "compact" }
  | { t: "ready" }
  | { t: "openFile"; path: string };

/** Extension -> Webview 的消息。 */
export type ExtensionToWebview =
  | { t: "bootstrap"; model: string; provider: string; cwd: string; sessionId: string; sessionTitle?: string; ready: boolean; locale: string }
  | {
      t: "config";
      keyConfigured: boolean;
      model: string;
      baseUrl: string;
      permissionMode: string;
      cwd: string;
    }
  | { t: "hostState"; state: "starting" | "ready" | "exited" | "not-started"; detail?: string }
  | { t: "event"; e: ViewEvent }
  | { t: "approval"; id: number; toolName: string; reason?: string; callId?: string }
  | { t: "approvalResolved"; id: number }
  | { t: "status"; status: "idle" | "running" }
  | { t: "hostExit"; code: number; error?: string }
  | { t: "setModel"; model: string }
  | { t: "stats"; stats: SessionStats }
  | { t: "modelInfo"; providers: { id: string; name: string }[]; models: string[]; current: { provider: string; model: string; reasoningEffort?: string; supportedEfforts?: string[] } }
  | { t: "modelChanged"; provider: string; model: string; reasoningEffort?: string; error?: string }
  | { t: "workModeChanged"; mode: "single" | "multi" }
  | { t: "compactDone"; ok: boolean; text?: string; error?: string }
  | { t: "sessions"; list: SessionSummary[]; error?: string }
  | { t: "history"; sessionId: string; events: ViewEvent[]; hasMore?: boolean; nextSeq?: number }
  | { t: "historyMore"; sessionId: string; events: ViewEvent[]; hasMore?: boolean; nextSeq?: number }
  | { t: "sessionDeleted"; id: string; ok: boolean; error?: string }
  | { t: "sessionExported"; id: string; ok: boolean; path?: string; error?: string };
