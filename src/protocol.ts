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
  /** 会话类型：主代理（dsh-vscode- 前缀）或子代理（subagent 工具，裸 UUID）。 */
  kind: "main" | "sub";
  /** 会话记录的模型参数（恢复历史时还原；来自宿主会话 meta）。 */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  workMode?: "single" | "multi";
}

/** 会话统计（host 侧随事件流累计，推送给 UI 渲染顶部信息栏）。 */export interface SessionStats {
  /** 会话标题（来自 session/title 事件）。 */
  title?: string;
  /** 累计输入 token（未命中缓存）。 */
  inputTokens: number;
  /** 累计缓存读取 token。 */
  cacheReadTokens: number;
  /** 累计输出 token。 */
  outputTokens: number;
  /** 累计 API 调用次数（step/start 事件计数；对应 dsh web 的 step 参数）。 */
  steps: number;
  /** 当前模型的上下文窗口大小（来自 request/context 事件）。 */
  contextWindow?: number;
  /** 最近一次请求的输入 token（含缓存读取），用于上下文占用占比。 */
  lastRequestInput?: number;
  /** 当前模型（展示用）。 */
  model?: string;
}

/** Host -> Extension */
export type HostFrame =
  | { t: "ready"; sessionId: string; cwd: string; provider: string; model: string; version: string; sessionTitle?: string; sessionBytes?: number }
  | { t: "events"; events: SessionEvent[]; sessionBytes?: number }
  | { t: "status"; status: "idle" | "running" }
  | { t: "approval"; id: number; toolName: string; callId?: string; reason?: string; agentId?: string }
  | { t: "approvalGone"; id: number }
  | { t: "chatDone"; id: number; ok: boolean; error?: string }
  | { t: "attachmentResult"; id: number; ok: boolean; mediaType?: string; data?: string }
  | { t: "stopAck"; id: number }
  | { t: "sessions"; list: SessionSummary[]; error?: string }
  | { t: "history"; sessionId: string; events: SessionEvent[]; hasMore?: boolean; nextSeq?: number; stats?: SessionStats; sessionBytes?: number }
  | { t: "historyMore"; sessionId: string; events: SessionEvent[]; hasMore?: boolean; nextSeq?: number; sessionBytes?: number }
  | { t: "sessionResumed"; id: string; ok: boolean; error?: string }
  | { t: "viewSession"; id: string }
  | { t: "viewSessionFailed"; id: string; error?: string }
  | { t: "sessionRenamed"; id: string; ok: boolean; title?: string; error?: string }
  | { t: "sessionTitleSynced"; id: string; title: string }
  | { t: "sessionDeleted"; id: string; ok: boolean; error?: string }
  | { t: "sessionExported"; id: string; ok: boolean; path?: string; error?: string }
  | { t: "modelInfo"; providers: { id: string; name: string }[]; models: string[]; providerModels?: Record<string, { id: string; name: string }[]>; current: { provider: string; model: string; reasoningEffort?: string } }
  | { t: "modelChanged"; provider: string; model: string; reasoningEffort?: string }
  | { t: "workModeChanged"; mode: "single" | "multi" }
  | { t: "compactDone"; id: number; ok: boolean; text?: string; error?: string }
  | { t: "llmProviders"; id: number; providers: { id: string; name: string; baseUrl?: string }[] }
  | { t: "discoveredModels"; id: number; models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]; error?: string }
  | { t: "providersApplied"; id: number; ok: boolean; error?: string }
  | { t: "stepLimit"; maxSteps: number; steps: number }
  | { t: "modelAdapted"; provider: string; model: string; from: string; to: string }
  | { t: "stats"; stats: SessionStats }
  | { t: "sessionRotated"; oldTitle?: string; newTitle?: string; sessionBytes?: number }
  | { t: "exit"; code: number; error?: string };

/** Extension -> Host */
export type ExtensionFrame =
  | { t: "chat"; id: number; text: string; images?: { data: string; mediaType: string; name?: string }[] }
  | { t: "readAttachment"; id: number; ref: { attachmentId: string; mediaType: string; bytes?: number; width?: number; height?: number } }
  | { t: "stop"; id: number }
  | { t: "approval:resolve"; id: number; approve: boolean }
  | { t: "newSession"; model?: string }
  | { t: "listSessions" }
  | { t: "resumeSession"; id: string; model?: string; limit?: number }
  | { t: "restorePreview"; id: string; limit?: number }
  | { t: "viewSession"; id: string; limit?: number }
  | { t: "renameSession"; id: string; title: string }
  | { t: "loadMoreHistory"; id: number; beforeSeq: number; limit?: number; sessionId?: string }
  | { t: "deleteSession"; id: string }
  | { t: "exportSession"; id: string }
  | { t: "setModel"; provider?: string; model?: string; reasoningEffort?: string }
  | { t: "getModelInfo" }
  | { t: "setWorkMode"; mode: "single" | "multi" }
  | { t: "compact"; id: number }
  | { t: "llmProviders"; id: number }
  | { t: "discoverModels"; id: number; provider?: string; baseURL?: string; api?: string; apiKey?: string }
  | {
      t: "providersApply";
      id: number;
      providers: { id: string; name?: string; baseUrl?: string; protocol?: string; models?: { id: string; displayName?: string; contextWindow?: number | string; maxOutput?: number | string }[]; apiKey?: string }[];
    }
  | { t: "shutdown" };

/** 提供商配置同步项（配置面板 → 宿主 llm-pi-ai settings，热生效）。 */
export interface ProviderApplyItem {
  id: string;
  name?: string;
  baseUrl?: string;
  protocol?: string;
  models?: { id: string; displayName?: string; contextWindow?: number | string; maxOutput?: number | string }[];
  apiKey?: string;
}

/** 面向 UI 的渲染事件（webview <-> 扩展之间），由扩展把 SessionEvent 翻译成视图模型。 */
export type ViewEvent =
  | { kind: "user"; text: string; ts: number; images?: { attachmentId: string; mediaType: string }[] }
  | { kind: "assistant-delta"; text: string; reasoning: string; ts: number }
  | { kind: "assistant"; text: string; reasoning: string; usage?: Record<string, number>; ts: number }
  | { kind: "error"; text: string; ts: number }
  | { kind: "tool-call"; callId: string; name: string; args: string; ts: number }
  | { kind: "tool-result"; callId: string; ok: boolean; text: string; ts: number }
  | { kind: "todo"; todos: { content: string; status: "pending" | "in_progress" | "completed" }[]; ts: number }
  | { kind: "turn"; status: "start" | "end"; reason?: string; ts: number }
  | { kind: "compaction"; phase: "start" | "summary" | "end"; ok?: boolean; error?: string; tokens?: number; ts: number };

/** Webview -> Extension 的消息。 */
export type WebviewMessage =
  | { t: "chat"; text: string; images?: { data: string; mediaType: string; name?: string }[] }
  | { t: "readAttachment"; id: number; ref: { attachmentId: string; mediaType: string; bytes?: number; width?: number; height?: number } }
  | { t: "stop" }
  | { t: "approval:resolve"; id: number; approve: boolean }
  | { t: "newSession" }
  | { t: "configure" }
  | { t: "openWorkspace" }
  | { t: "historyClose" }
  | { t: "historyRefresh" }
  | { t: "resumeSession"; id: string }
  | { t: "restorePreview"; id: string }
  | { t: "viewSession"; id: string }
  | { t: "renameSession"; id: string; title: string }
  | { t: "loadMoreHistory"; beforeSeq: number; sessionId?: string }
  | { t: "deleteSession"; id: string }
  | { t: "exportSession"; id: string }
  | { t: "setModel"; provider?: string; model?: string; reasoningEffort?: string }
  | { t: "setWorkMode"; mode: "single" | "multi" }
  | { t: "compact" }
  | { t: "ready" }
  | { t: "openFile"; path: string }
  | { t: "hint"; text: string }
  | { t: "dshUpgrade" }
  | { t: "dshIgnore" }
  | { t: "dshDetails" };

/** Extension -> Webview 的消息。 */
export type ExtensionToWebview =
  | { t: "bootstrap"; model: string; provider: string; cwd: string; sessionId: string; sessionTitle?: string; ready: boolean; locale: string; dshVersion?: string; sessionBytes?: number }
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
  | { t: "approval"; id: number; toolName: string; reason?: string; callId?: string; agentId?: string }
  | { t: "approvalResolved"; id: number }
  | { t: "status"; status: "idle" | "running" }
  | { t: "hostExit"; code: number; error?: string }
  | { t: "setModel"; model: string }
  | { t: "stats"; stats: SessionStats }
  | { t: "appendInput"; text: string }
  | { t: "modelInfo"; providers: { id: string; name: string }[]; models: string[]; providerModels?: Record<string, { id: string; name: string }[]>; current: { provider: string; model: string; reasoningEffort?: string; supportedEfforts?: string[]; defaultEffort?: string } }
  | { t: "modelChanged"; provider: string; model: string; reasoningEffort?: string; error?: string }
  | { t: "workModeChanged"; mode: "single" | "multi" }
  | { t: "compactDone"; ok: boolean; text?: string; error?: string }
  | { t: "sessions"; list: SessionSummary[]; error?: string }
  | { t: "attachmentResult"; id: number; ok: boolean; mediaType?: string; data?: string }
  | { t: "restarting" }
  | { t: "dshUpdate"; latest?: string; upgrading?: boolean }
  | { t: "history"; sessionId: string; events: ViewEvent[]; hasMore?: boolean; nextSeq?: number; sessionBytes?: number }
  | { t: "historyMore"; sessionId: string; events: ViewEvent[]; hasMore?: boolean; nextSeq?: number; sessionBytes?: number }
  | { t: "viewSession"; id: string }
  | { t: "sessionDeleted"; id: string; ok: boolean; error?: string }
  | { t: "sessionRenamed"; id: string; ok: boolean; title?: string; error?: string }
  | { t: "sessionTitleSynced"; id: string; title: string }
  | { t: "sessionExported"; ok: boolean; path?: string; error?: string }
  | { t: "sessionRotated"; oldTitle?: string; newTitle?: string; sessionBytes?: number }
  | { t: "sessionSize"; bytes: number };
