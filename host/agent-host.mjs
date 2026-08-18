#!/usr/bin/env node
/**
 * agent-host.mjs — DeepSeek Harness 运行时宿主（VS Code 扩展子进程）。
 *
 * 在独立 Node 进程中启动一条 DSH Cordis 树（dsh-base + 裁剪后的 dsh-headless
 * 补丁层），创建并驱动一个 Agent，通过 stdin/stdout 的 JSONL 协议与扩展通信：
 *
 *   Host -> Extension  {t:'ready'|'event'|'status'|'approval'|'chatDone'|'log'|'exit'}
 *   Extension -> Host  {t:'chat'|'stop'|'approval:resolve'|'newSession'|'shutdown'}
 *
 * stdout 只承载协议帧；一切日志走 stderr，避免污染协议流。
 * 本文件不参与打包（esbuild），作为普通 ESM 由扩展用 Node 直接运行。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { boot, loadLayeredEnv, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome, dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

const NAME = "dsh-vscode-host";
const CORE_VERSION = "0.2.1";
/** 插件会话 id 前缀（也是会话隔离的标识）。 */
const SESSION_PREFIX = "dsh-vscode-";

/** 当前工作模式（模块级：createAgent 的 attachAgent 需要读取；setWorkMode 更新）。 */
let workMode = "single";
const getWorkMode = () => workMode;

/* ------------------------------------------------------------------ */
/* 协议输出                                                            */
/* ------------------------------------------------------------------ */

/** 发送一帧 JSONL 到 stdout。 */
function post(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** 宿主日志 → stderr（扩展侧转发到输出通道）。 */
function log(level, message, extra) {
  const line = extra === undefined ? message : `${message} ${JSON.stringify(extra)}`;
  process.stderr.write(`[${level}] ${line}\n`);
}

/* ------------------------------------------------------------------ */
/* Patch 组装                                                          */
/* ------------------------------------------------------------------ */

/** 通过包 exports 解析 bundle patch 文件（dsh-base / dsh-headless 均导出 ./cordis.patch.yml）。 */
function bundlePatchFile(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

/**
 * 组装 Cordis patch 层：
 * 1. dsh-base 的共享核心（agent、工具、沙箱、审批、goal/subagent/workflow…）；
 * 2. dsh-headless 的补丁，剔除一次性 runner/startup，保留 code-runtime 与 tools 行；
 * 3. 本扩展的 overlay：IDE persona、禁用 HMR。
 */
function composePatches(env) {
  const base = loadOverlayPatches(NAME, bundlePatchFile("@deepseek-ai/dsh-base/cordis.patch.yml"));
  const headless = loadOverlayPatches(NAME, bundlePatchFile("@deepseek-ai/dsh-headless/cordis.patch.yml"));

  const filteredHeadless = [];
  for (const entry of headless) {
    if (entry.id === "system-prompt" || entry.id === "tools" || entry.id === "hmr") {
      filteredHeadless.push(entry);
      continue;
    }
    if (entry.insert !== undefined) {
      const kept = entry.insert.filter(
        (row) => row.id !== "headless-startup" && row.id !== "headless-runner"
      );
      if (kept.length > 0) filteredHeadless.push({ insert: kept });
      continue;
    }
    // 其余行（无 id 的行不存在于该 patch；保守丢弃）
  }

  // 当前真实工作目录（进程 cwd）：显式写入 persona，不依赖 {{cwd}} 变量——
  // 恢复历史会话时 {{cwd}} 会取会话创建时的旧记录（如曾把文件写到系统目录），
  // 导致 Agent 把旧目录当作工作目录。显式注入保证任何会话都指向当前真实目录。
  const currentCwd = process.cwd();

  const overlay = [
    {
      id: "system-prompt",
      config: {
        persona:
          "You are a coding agent powered by the {{model}} model, running inside the DeepSeek Harness VS Code extension. " +
          `Your working directory is ${currentCwd} — the user's current workspace. Use this directory for all file operations and command workdirs. ` +
          "Help with coding tasks: read and edit files, run commands, search the web, and orchestrate subagents and workflows. " +
          "File edits you make appear live in the editor. Plan before large changes; prefer the plan-mode workflow for ambiguous or big tasks. " +
          "For long-running objectives, use the goal tools so progress persists across continuation rounds. " +
          "Tool calls, approvals, and todos are shown to the user in real time; keep them informed and concise. " +
          "Permissions: operations outside the workspace are denied by the sandbox by default. " +
          "When a task genuinely needs wider access (e.g. reading or writing files outside the workspace, or system-level commands), " +
          "you may request a one-time escalation by passing `sandbox_permissions` (the narrowest wider mode that suffices, e.g. \"danger-full-access\") " +
          "together with a clear `justification` to the file/command tools — the user is then prompted to approve or deny in the UI. " +
          "Do not request escalation casually; prefer working inside the workspace. " +
          "Encoding: on Windows, command output (PowerShell 5.1 / Python) defaults to the system code page, " +
          "which garbles non-ASCII text (any language) when captured. When running a command whose output " +
          "may contain non-ASCII characters, force UTF-8 output: prefix PowerShell commands with " +
          "`[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8;` " +
          "or run `chcp 65001 >nul` first, and for Python set `$env:PYTHONIOENCODING='utf-8'` — " +
          "otherwise the captured output will be garbled.",
      },
    },
    { id: "hmr", disabled: true },
    {
      id: "sandbox-policy",
      config: {
        mode: env.DSH_PERMISSION_MODE ?? "workspace-write",
        workspaceRoot: process.cwd(),
      },
    },
    // 子代理工具配置（借鉴 dsh web）：整行替换语义，必须携带完整 config。
    // maxDepth = 子代理递归深度上限（内核默认 3）；插件可配置。
    {
      id: "tool-subagent",
      config: {
        provider: "spawn",
        toolName: "subagent",
        backgroundMode: "continuable",
        maxDepth: Number(env.DSH_SUBAGENT_MAX_DEPTH) || 3,
      },
    },
    // 独立会话存储：插件会话与 dsh CLI / dsh web 等官方应用的会话完全隔离，
    // 插件的历史列表只包含插件自己的会话。
    {
      id: "session-persistence-jsonl",
      config: {
        root: dshHomePath("sessions-ay-dsh"),
      },
    },
    // 禁用的插件（对应依赖已从 VSIX 剔除，不加载即不 import）：
    // - llm-pi-ai：多提供商网关，插件固定使用 deepseek-official 路由，永不激活
    // - session-telemetry-otel：遥测，插件默认关闭
    // - typert-gateway（dsh-api-gateway / host-apiproxy）：web API 网关。它会先于
    //   本插件的监听器拦截 approval/request 并等待 web 客户端响应（插件无 web 客户端），
    //   导致审批请求永久挂起、授权弹框不出现。headless 场景无需该网关。
    { id: "llm-pi-ai", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
    { id: "typert-gateway", disabled: true },
  ];

  return [...base, ...filteredHeadless, ...overlay];
}

/* ------------------------------------------------------------------ */
/* 会话 / Agent 驱动                                                   */
/* ------------------------------------------------------------------ */

/** 读取 agent 当前会话的标题（无则返回 undefined）。 */
async function currentSessionTitle(ctx, agent) {
  try {
    if (agent === undefined) return undefined;
    const query = ctx.get("sessionQuery");
    if (query === undefined || typeof query.readTitle !== "function") return undefined;
    const title = await query.readTitle(SessionId(agent.session.id));
    return title?.title ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 创建一条 DSH 树：boot() 装载 loader，挂载 base+headless 插件栈。
 * 返回根上下文；调用方负责 ctx.fiber.dispose()。
 */
async function bootTree() {
  const home = resolveDshHome();
  // 平台感知路径拼接：此前硬编码 "\\" 在非 Windows 上会生成
  // 字面反斜杠目录名，导致 path.dirname 解析错误 → cordis include 条目加载失败
  // （CI smoke test 在 ubuntu 上 "loader entries failed to apply"）。
  const profileDir = join(home, "profiles", "dsh-vscode");
  mkdirSync(profileDir, { recursive: true });
  const rootConfig = join(profileDir, "cordis.yml");
  writeFileSync(rootConfig, "# dsh-vscode root — empty entry list; composed from bundle patches\n[]\n");

  const environment = loadLayeredEnv(NAME);
  const patches = composePatches(environment);

  const ctx = await boot(NAME, rootConfig, patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
  });
  return ctx;
}

/** 可发送的事件队列：高频 chunk 攒批，降低 stdio 压力。
 *  16ms（< 1 帧）足够合并高频事件，同时端到端感知延迟不可察觉；
 *  配合 UI 侧节流渲染，输出呈现链式流畅。 */
class EventPump {
  constructor() {
    this.queue = [];
    this.timer = undefined;
  }
  push(event) {
    this.queue.push(event);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), 16);
    }
  }
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    post({ t: "events", events: batch });
  }
}

/**
 * 创建 Agent 并挂接所有监听器。
 * @returns {Promise<{handle: import('@deepseek-ai/dsh-agent').AgentHandle, agent: import('@deepseek-ai/dsh-agent').Agent, selection: object, resetStepBudget: () => void}>}
 */
async function createAgent(ctx, options, pump, approvals) {
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === undefined || defaultModel === undefined) {
    throw new Error("dsh-vscode-host: core services unavailable (agents/agentDefaultModel)");
  }

  const base = defaultModel.currentSelection();
  const provider = options.provider ?? base.provider;
  const model = options.model ?? base.model;
  const selection = { provider, model, reasoningEffort: base.reasoningEffort };

  const handle = await agents.create({
    sessionId: SessionId(`dsh-vscode-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
  });

  const attached = attachAgent(ctx, handle, pump);
  await handle.agent.whenIdle();
  return { handle, agent: handle.agent, selection, resetStepBudget: attached.resetStepBudget };
}

/** 恢复一个持久化会话（继续历史对话）。 */
async function resumeAgent(ctx, resumeSessionId, options, pump, approvals) {
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === undefined || defaultModel === undefined) {
    throw new Error("dsh-vscode-host: core services unavailable (agents/agentDefaultModel)");
  }
  const base = defaultModel.currentSelection();
  const provider = options.provider ?? base.provider;
  const model = options.model ?? base.model;
  const selection = { provider, model, reasoningEffort: base.reasoningEffort };

  const handle = await agents.resume({
    resumeSessionId: SessionId(resumeSessionId),
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
  });

  // 工作目录纠正：会话创建时固化了当时的 cwd（DSH 不提供覆盖 API）。
  // 若会话 cwd 与当前工作区不一致（如历史会话是在别的目录创建的），
  // 通过 system-prompt/assemble 注入提示（不进历史、不触发额外回复），
  // 让 agent 明确以当前工作区为准，避免继续往旧目录写文件。
  const sessionCwd = handle.agent.session.header?.cwd;
  const currentCwd = process.cwd();
  if (typeof sessionCwd === "string" && sessionCwd !== currentCwd) {
    const note =
      `[Working directory correction] This session was originally created in "${sessionCwd}", ` +
      `but the current VS Code workspace has changed to "${currentCwd}". ` +
      `From now on, all file operations and command working directories must use "${currentCwd}". ` +
      `Do not keep reading/writing under "${sessionCwd}" unless the user explicitly asks.`;
    handle.agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembled = await next();
      return {
        ...assembled,
        sections: [
          ...(assembled.sections ?? []),
          { name: "cwd-correction", text: note },
        ],
      };
    });
    log("info", `session cwd ${sessionCwd} != workspace ${currentCwd}; injected cwd correction`);
  }

  const attached = attachAgent(ctx, handle, pump);
  await handle.agent.whenIdle();
  return { handle, agent: handle.agent, selection, resetStepBudget: attached.resetStepBudget };
}

/**
 * 多 Agent 编排模式的系统提示补充段。
 * 挂载在 system-prompt/assemble 瀑布上：multi 模式下注入"拆解 → 并行子代理 → 汇总"
 * 的指令，让主 agent 用 DSH 原生的 subagent 工具并行执行子任务。
 * 并行数量上限（DSH_MAX_PARALLEL_SUBAGENTS，默认 5）：prompt 级约束（内核无硬参数）。
 */
function multiAgentSection(env) {
  const maxParallel = Number(env.DSH_MAX_PARALLEL_SUBAGENTS) || 5;
  return {
    name: "work-mode",
    text:
      "Current work mode: MULTI-AGENT ORCHESTRATION.\n" +
      "For the task at hand: (1) decompose it into independent subtasks; " +
      `(2) run them in PARALLEL by dispatching subagents with the subagent tools ` +
      `(spawn multiple agents concurrently — at most ${maxParallel} in parallel, one per subtask, giving each a self-contained prompt); ` +
      "(3) collect their results and synthesize a final answer yourself. " +
      "Use parallel dispatch whenever subtasks do not depend on each other. " +
      "Keep the user informed: show each dispatched subagent as it starts and when it returns.",
  };
}

/**
 * 挂接事件/状态监听（create 与 resume 共用；每个 agent 各挂一份）。
 * 注意：审批监听不在这里——它必须挂在**根 ctx**（installApprovalListener，
 * 全局一次）：dsh-scope 的事件向上流动，根 ctx 的无标签监听器能收到
 * 所有 agent（含 subagent 工具创建的子 agent）的 approval/request，
 * 否则子 agent 的越界请求会因无监听者而 fail-closed（静默拒绝、无弹窗）。
 */

/**
 * 思考等级（reasoning effort）规范化。
 *
 * 备忘：DeepSeek 现役模型为 deepseek-v4-flash / deepseek-v4-pro；
 * deepseek-chat / deepseek-reasoner 已停止服务（旧模型下线），不再使用。
 *
 * 官方文档（api-docs.deepseek.com/guides/thinking_mode）：
 *   - 思考模式默认开启，默认 effort = high；
 *   - reasoning_effort 参数支持 low/high/max，映射表（v4-flash 与 v4-pro 相同）：
 *       low → low；medium → high；high → high；xhigh → high；max → max
 *     （即 low 是真实低档，medium/xhigh 归并为 high）；
 *   - 关闭思考用 thinking.type=disabled（即本插件的 off 档）。
 *
 * 内核适配器（dsh-llm-deepseek）当前只实现 off/high/max 三档，
 * 对 low 会抛 UNSUPPORTED_REASONING_EFFORT（resolveCallConfig 实测拒绝，
 * 见 scripts/effort-probe.mjs）。因此在宿主层把 low 归一为 high：
 *   官方 API 支持 low（真实低档），但内核未实现——这是"内核能力落后于
 *   官方 API"的兼容处理；待内核支持 low 后应移除该映射，让 low 真正生效。
 * 未知/空值返回 undefined → 走内核/提供商默认（DeepSeek 默认 high）。
 */
function normalizeEffort(value) {
  if (value === "off" || value === "high" || value === "max") return value;
  if (value === "low") return "high";
  return undefined;
}

/**
 * 系统提示层收尾引导（**从一开始就注入**，每轮系统提示均携带）：
 * 让模型预先知晓"单轮（一条用户消息）有 N 步思考预算"，主动规划任务节奏；
 * 达到上限时工具调用被禁用、必须立即收尾总结。经 system-prompt/assemble
 * 瀑布注入 `assembled.sections`，由 renderPrompt 渲染进系统提示（探针实证：
 * 注入确实进入 request.system，但长系统提示中的指令易被模型重视不足——
 * 故配合消息层 pre-step 注入与工具拦截兜底）。
 */
/** 宿主侧提示语言：由扩展按 VS Code 界面语言通过 DSH_LOCALE 传入（zh/en）。 */
const UI_LANG = process.env.DSH_LOCALE === "zh" ? "zh" : "en";

/** 终端用户可见提示的轻量双语助手：技术/debug 日志保持英文，用户可见提示按 UI 语言适配。 */
const L = (zh, en) => (UI_LANG === "zh" ? zh : en);

/** 用户刚切换过思考级别（setModel）：下一次模型请求强制打印实际思考级别。 */
let userEffortChanged = false;

/**
 * 语言一致性指令（系统提示层，每轮注入）：模型的思考链与输出语言会镜像
 * 用户消息/系统提示的语言，混杂会导致中英交替。随 DSH_LOCALE 注入明确
 * 指令，让思考与输出始终跟随 VS Code 界面语言（zh/en）。
 */
function languageDirectiveSection() {
  if (UI_LANG === "zh") {
    return {
      name: "language",
      text: "请始终使用简体中文回复用户，思考过程（reasoning）同样使用简体中文。除非用户明确要求使用其他语言。",
    };
  }
  return {
    name: "language",
    text: "Always reply in English, including your reasoning. Use English unless the user explicitly asks for another language.",
  };
}

function stepLimitSystemSection(limit) {
  if (UI_LANG === "zh") {
    return {
      name: "step-limit",
      text:
        `每轮对话（一条用户消息）的思考步数预算为 ${limit} 步，请在此预算内规划工作节奏。` +
        "预算用尽后，工具调用将被禁用，你必须立即收尾：停止所有新的工具调用与推理，" +
        "在回复中给出简洁的最终答复，说明已完成事项、未完成事项，以及用户下一步应发送的命令。" +
        "预算耗尽后请勿继续工作。",
    };
  }
  return {
    name: "step-limit",
    text:
      `Each turn (one user message) has a thinking-step budget of ${limit} model steps. ` +
      "Plan your work to finish within this budget. " +
      "When the budget is reached, tool calls are disabled and you must wrap up immediately: " +
      "stop all new tool calls and reasoning, and deliver a concise final answer covering what " +
      "was accomplished, what remains unfinished, and the next command the user should send. " +
      "Do not continue working beyond the budget.",
  };
}

/** 工具拦截拒绝文案（tools/pre-execute deny reason，与 UI 语言一致）。 */
function stepLimitDenyReason(count, limit) {
  return UI_LANG === "zh"
    ? `工具调用已禁用——本轮已达思考步数上限（${count}/${limit}）。请立即停止工作并给出最终答复。`
    : `Tool calls are disabled — this turn reached its step limit (${count}/${limit}). Stop working and deliver your final summary now.`;
}

/**
 * 消息层收尾指令（agent/pre-step 注入的 user 消息，超限后下一步必达）：
 * 对话末尾的 user 消息是模型必须处理的输入，必然引起响应——软性收尾的强
 * 注入点。内容明确：阈值（limit）与当前值（steps）、原因（工具已禁用）、
 * 要求的动作、语气专业坚定且礼貌。该消息会写入会话历史（收尾指令作为对话
 * 痕迹可见），以"[自动提示]/[Auto notice]"开头标明由系统自动注入，并按 UI
 * 语言（zh/en）本地化。注意：纯提示词对模型的约束力有限（实测模型可能继续
 * 执行），真正的收尾保障是 tools/pre-execute 工具拦截（见 attachAgent）。
 */
function stepLimitWrapUpMessage(limit, steps) {
  if (UI_LANG === "zh") {
    return (
      `[自动提示] 本轮思考步数已达上限（${steps}/${limit}），所有工具调用已被禁用。` +
      "单轮步数上限用于控制单次请求规模、防止工具循环失控，因此本轮工作到此为止。" +
      "请立即停止进一步推理，在本回复中给出最终答复：已完成什么、还剩下什么、用户下一步应发送的命令。" +
      "预算耗尽后请勿继续工作。本提示由系统自动注入，并非用户输入。谢谢配合收尾。"
    );
  }
  return (
    `[Auto notice] Step limit reached: ${steps}/${limit} steps used — this turn's thinking budget ` +
    "is exhausted and all tool calls are now disabled. The per-turn step limit keeps each request " +
    "bounded and prevents runaway tool loops, so continuing further work is not permitted. " +
    "Stop further reasoning and deliver your final answer in this reply: what was accomplished, " +
    "what remains unfinished, and the next command the user should send. " +
    "Do not continue working after this reply. This notice was injected automatically and is not user input. " +
    "Thank you for wrapping up cleanly."
  );
}

/**
 * 最大思考轮次兜底（借鉴 dsh web 的 step 概念）：**单轮**（一条用户消息）的
 * 思考步数上限，防单轮无限循环。内核无内置 step 上限参数，宿主侧监听
 * step/start 计数：
 *   - 计数按轮重置（attachAgent 返回 resetStepBudget，chat 入口在每条用户
 *     消息入队前调用）——stepLimit 只限制"用户发一条消息后、后台与 AI 交互
 *     的步数"，不是会话累计步数上限；会话可以一直聊下去；
 *   - 0 = 不限制：不计数、不注入收尾提示、不通报（env 值直接透传，勿用
 *     `|| 默认值` 吞掉 0）；
 *   - 软性收尾（不做硬截停）：系统提示从一开始就注入单轮预算约束（提醒模型
 *     规划节奏），达到上限后由消息层注入收尾指令（模型必须响应、总结收尾），
 *     直到本轮自然结束——绝不对会话/agent 执行 cancel；
 *   - 达到上限时向上层通报一次 stepLimit（UI 提示用户任务已到上限，可继续
 *     输入指令推进；会话与历史不受影响）。
 */
function attachAgent(ctx, handle, pump) {
  const agent = handle.agent;

  // 环境变量直读：非数字或缺失时回退 100；合法值原样保留（0 = 不限制）。
  const maxSteps = Number(process.env.DSH_MAX_STEPS);
  const stepLimit = Number.isFinite(maxSteps) ? maxSteps : 100;
  let stepCount = 0;
  let stepLimitHit = false;
  /** 消息层收尾指令是否已注入（每轮最多注入一次，避免刷屏）。 */
  let wrapUpInjected = false;
  /** 上次打印过的实际思考级别（仅在变化时打印，避免每步刷屏）。 */
  let lastLoggedEffort;

  /** 新一轮用户消息开始时调用：重置本轮步数预算（stepLimit 是单轮上限）。 */
  const resetStepBudget = () => {
    stepCount = 0;
    stepLimitHit = false;
    wrapUpInjected = false;
  };

  // 会话事件 → 扩展（scope-filtered：仅本 agent 的会话）
  agent.ctx.on("session/event", (_session, event) => {
    if (event.type === "step/start") {
      stepCount++;
      // 达到上限：不硬截停（agent.cancel 会生硬打断模型），只通报一次，
      // 由 assemble 钩子注入的收尾提示引导模型自然结束。
      if (!stepLimitHit && stepLimit > 0 && stepCount >= stepLimit) {
        stepLimitHit = true;
        // step 控制相关日志只保留"注入系统提示"一条（见 assemble 钩子），此处不再打印
        post({ t: "stepLimit", maxSteps: stepLimit, steps: stepCount });
      }
    }
    pump.push(event);
  });

  // 收尾引导（系统提示层）：**从一开始就注入**（每轮系统提示均携带单轮预算
  // 约束，让模型预先知晓并规划节奏）；达到上限后提示词继续存在于系统提示，
  // 直到本轮自然结束。stepLimit = 0 时不注入。
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const sections = [...(assembled.sections ?? [])];
    // 语言一致性指令：每轮注入（思考/输出语言跟随界面语言，见 languageDirectiveSection）
    sections.push(languageDirectiveSection());
    if (stepLimit > 0) {
      // 注入单轮步数预算约束（不打印日志：运行成熟后该信息属无意义刷屏）
      sections.push(stepLimitSystemSection(stepLimit));
    }
    return { ...assembled, sections };
  });

  // 收尾引导（对话消息层，最强）：已达上限（stepLimitHit）后，在**下一步**
  // 的输入 messages 末尾追加一条 user 收尾指令（含明确的阈值与当前值）。
  // 模型对对话末尾的 user 消息必然响应（它成为该步必须处理的输入），因此
  // 软性收尾真正生效。仅注入一次（wrapUpInjected），避免每步刷屏；该消息
  // 会写入会话历史（收尾指令作为对话痕迹可见，属软性收尾的合理表现）。
  // 注意：agent/request 瀑布改 messages 无效（dsh-agent-loop buildRequest 只
  // 消费 provider/model/effort 等配置字段，request.messages 由外部组装）——
  // 消息层注入只能走 agent/pre-step 的 decision.messages（探针已实证可行）。
  agent.ctx.on("agent/pre-step", async (_payload, next) => {
    const decision = await next();
    if (stepLimit > 0 && stepLimitHit && !wrapUpInjected && decision.kind === "enter") {
      wrapUpInjected = true;
      return {
        ...decision,
        messages: [
          ...(decision.messages ?? []),
          // 必须用 createUserMessage 构造（含 id/source 身份字段）——内核处理
          // user/message 事件会读 message.source.kind，裸对象会崩溃
          // （"Cannot read properties of undefined (reading 'kind')"）。
          createUserMessage({
            content: [{ type: "text", text: stepLimitWrapUpMessage(stepLimit, stepCount) }],
            source: { kind: "user" },
          }),
        ],
      };
    }
    return decision;
  });

  // 工具拦截（软性强制收尾的核心保障）：超限后（stepLimitHit），所有工具调用
  // 在 tools/pre-execute 门禁处被拒绝——工具不执行，模型收到
  // "Error: Tool calls are disabled — this turn reached its step limit (N/M)…"，
  // 无法再执行任何工具，只能总结收尾。与硬终止（agent.cancel）不同：会话、
  // 历史、后续对话完全不受影响，仅当前轮的工具执行被禁止——即使提示词被
  // 模型忽视，工具拦截也保证收尾必然发生。scope 向上流动，主 agent 超限时
  // 子代理的工具同样被禁（整轮收尾，符合预期）。
  agent.ctx.on("tools/pre-execute", async (exec, next) => {
    const gate = await next();
    if (stepLimit > 0 && stepLimitHit && gate.kind === "allow") {
      return {
        kind: "deny",
        reason: stepLimitDenyReason(stepCount, stepLimit),
      };
    }
    return gate;
  });

  // 思考级别实际值追踪：agent/request 是每次模型请求配置的**唯一**入口
  // （dsh-agent-loop buildRequest 由此消费 provider/model/reasoningEffort），
  // 应答/usage 不回显 effort（dsh-llm-deepseek 类型仅有请求侧定义），因此
  // 此处日志即"AI 实际使用的思考级别"。仅在变化、或用户刚切换思考级别
  // （userEffortChanged）时打印，避免每步刷屏。
  agent.ctx.on("agent/request", async (_payload, next) => {
    const request = await next();
    const actual = request?.reasoningEffort;
    if (actual !== lastLoggedEffort || userEffortChanged) {
      lastLoggedEffort = actual;
      userEffortChanged = false;
      log("info", L(`AI 实际思考级别: ${actual ?? "（未指定）"}`, `AI actual reasoning effort: ${actual ?? "(unset)"}`));
    }
    return request;
  });

  // 生命周期状态
  agent.ctx.on("agent/status", ({ agent: a, status }) => {
    post({ t: "status", status });
  });

  // 工作模式：multi 模式下注入多 agent 编排指令（每次请求组装时读取最新模式）
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    if (getWorkMode() !== "multi") return assembled;
    return {
      ...assembled,
      sections: [...(assembled.sections ?? []), multiAgentSection(process.env)],
    };
  });

  return { resetStepBudget };
}

/**
 * 全局审批监听（挂在根 ctx，仅安装一次）。
 * 覆盖所有 agent（主 agent 与 subagent 工具创建的子 agent）：
 * dsh-scope 保证根 ctx（无标签 = 全局监听）能收到每个后代作用域的事件。
 * 瀑布语义要求监听器唯一：若同时在 agent.ctx 挂监听，同一请求会被
 * 两个监听器各自 claim（重复弹窗/双帧），故全部审批集中在此。
 */
function installApprovalListener(ctx, approvals) {
  ctx.on("approval/request", async (req) => {
    const id = approvals.nextId();
    const agent = req.agent;
    // agent 标识：会话 id 短形式（多 agent 场景让用户知道是谁在请求授权）
    const agentId = agent?.session?.id ? String(agent.session.id).slice(-8) : undefined;
    log(
      "info",
      `approval #${id} requested: ${req.toolName}${agentId ? ` (agent …${agentId})` : ""}${req.reason ? ` — ${req.reason}` : ""}`,
      { callId: req.callId ?? null }
    );
    const outcome = await new Promise((resolve) => {
      const entry = { resolve };
      approvals.pending.set(id, entry);
      post({
        t: "approval",
        id,
        toolName: req.toolName,
        callId: req.callId,
        reason: req.reason,
        agentId,
      });
      // 2 分钟无人回应 → 视为取消（Agent 会收到工具取消并调整策略）
      entry.timer = setTimeout(() => {
        if (approvals.pending.get(id) === entry) {
          approvals.pending.delete(id);
          resolve("cancelled");
          // 通知扩展：该审批已不存在（清理未决缓存与状态栏警告）
          post({ t: "approvalGone", id });
          log("warn", `approval #${id} timed out (${req.toolName})`);
        }
      }, 120000);
      if (req.signal !== undefined && !req.signal.aborted) {
        req.signal.addEventListener(
          "abort",
          () => {
            const pending = approvals.pending.get(id);
            if (pending !== undefined) {
              approvals.pending.delete(id);
              clearTimeout(pending.timer);
              resolve("cancelled");
              post({ t: "approvalGone", id });
            }
          },
          { once: true }
        );
      }
    });
    log("info", `approval #${id} resolved: ${outcome}`);
    return outcome;
  });
}

/* ------------------------------------------------------------------ */
/* 会话隔离迁移                                                         */
/* ------------------------------------------------------------------ */

/**
 * 一次性迁移（幂等）：把旧位置中**本插件创建**的会话（id 以 dsh-vscode- 开头）
 * 移动到当前 DSH_HOME 的独立目录（sessions-ay-dsh）。迁移源：
 *   1. 旧共享 home 的 sessions/（dsh CLI/web 与插件共用的旧位置）
 *   2. 旧 home 的 sessions-ay-dsh/（插件上上版的独立位置）
 * 扩展侧通过 DSH_LEGACY_HOME 传入旧 home；未传时回退到用户目录下的 .dsh。
 * @returns 迁移的会话目录数。
 */
function migrateLegacySessions() {
  const newRoot = dshHomePath("sessions-ay-dsh");
  mkdirSync(newRoot, { recursive: true });
  const legacyHome = process.env.DSH_LEGACY_HOME || join(osHomedir(), ".dsh");
  const currentHome = resolveDshHome();
  const sources = [];
  if (legacyHome !== currentHome) {
    sources.push(join(legacyHome, "sessions"), join(legacyHome, "sessions-ay-dsh"));
  } else {
    // 同 home 时只迁移旧共享目录（sessions-ay-dsh 已是目标）
    sources.push(join(legacyHome, "sessions"));
  }
  let moved = 0;
  for (const oldRoot of sources) {
    if (!existsSync(oldRoot)) continue;
    for (const projectName of readdirSync(oldRoot)) {
      const projectDir = join(oldRoot, projectName);
      let stat;
      try {
        stat = statSync(projectDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const sessionName of readdirSync(projectDir)) {
        if (!sessionName.startsWith(SESSION_PREFIX)) continue; // 只迁移插件自己的会话
        const from = join(projectDir, sessionName);
        let sstat;
        try {
          sstat = statSync(from);
        } catch {
          continue;
        }
        if (!sstat.isDirectory()) continue;
        const toDir = join(newRoot, projectName);
        const to = join(toDir, sessionName);
        try {
          mkdirSync(toDir, { recursive: true });
          if (existsSync(to)) continue; // 新位置已有同名会话，跳过
          renameSync(from, to);
          moved++;
        } catch (error) {
          log("warn", `session migrate skipped: ${sessionName}`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
  if (moved > 0) log("info", `migrated ${moved} plugin session(s) to ${newRoot}`);
  return moved;
}

/* ------------------------------------------------------------------ */
/* 会话历史（list / resume / delete）                                   */
/* ------------------------------------------------------------------ */

/**
 * 列出持久化会话（newest-first），附标题。编码规则与
 * dsh-session-persistence-jsonl 的目录布局保持一致（纯函数复制）。
 */
async function listSessions(ctx) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) return [];
  const records = await query.listSessions();
  const ids = records.filter((r) => r.persisted || r.live).map((r) => r.header.id);
  const titleResults = ids.length > 0 ? await query.readTitleSnapshots(ids) : [];
  const titles = new Map();
  for (const r of titleResults) {
    if (r.status === "fulfilled" && r.value.title !== undefined) {
      titles.set(r.sessionId, { title: r.value.title.title, updatedAt: r.value.title.updatedAt });
    }
  }
  // 完整列出所有持久化/存活的会话，不做任何过滤（不掩盖问题）。
  // 空会话由清理机制移除（见 deleteEmptySessions），列表即真相。
  return records
    .filter((r) => r.persisted || r.live)
    .map((r) => ({
      id: r.header.id,
      cwd: r.header.cwd ?? "",
      createdAt: r.header.createdAt,
      title: titles.get(r.header.id)?.title,
      updatedAt: titles.get(r.header.id)?.updatedAt ?? r.header.createdAt,
      live: r.live,
    }));
}

/**
 * 计算会话统计快照（分页加载时 host.ts 无法从部分事件累计完整统计，
 * 由宿主侧全量扫描一次：标题 / token 累计 / 上下文窗口）。
 */
function computeSessionStats(events) {
  const stats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, steps: 0 };
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "session/title" && typeof d.title === "string" && d.title) {
      stats.title = d.title;
    } else if (e.type === "assistant/message" && d.usage) {
      const input = Number(d.usage.inputTokens) || 0;
      const cache = Number(d.usage.cacheReadTokens) || 0;
      const output = Number(d.usage.outputTokens) || 0;
      stats.inputTokens += input;
      stats.cacheReadTokens += cache;
      stats.outputTokens += output;
      stats.lastRequestInput = input + cache;
    } else if (e.type === "request/context") {
      if (typeof d.contextWindow === "number" && d.contextWindow > 0) {
        stats.contextWindow = d.contextWindow;
      }
      if (typeof d.model === "string" && d.model) stats.model = d.model;
    } else if (e.type === "step/start") {
      stats.steps = (stats.steps ?? 0) + 1;
    }
  }
  return stats;
}

/** 与 dsh-session-persistence-jsonl 相同的项目目录编码。 */
function encodeSegment(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = cwd[i];
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 删除一个持久化会话（物理删除其会话日志目录，仅限插件独立存储）。 */
async function deleteSession(ctx, sessionId) {
  try {
    const query = ctx.get("sessionQuery");
    let cwd;
    if (query !== undefined) {
      const snap = await query.readSession(SessionId(sessionId));
      cwd = snap.session.cwd ?? process.cwd();
    } else {
      cwd = process.cwd();
    }
    const dir = join(dshHomePath("sessions-ay-dsh"), projectKey(cwd), encodeSegment(sessionId));
    const artifacts = ["session.jsonl", "session.jsonl.zstd", "session.jsonl.zst"];
    const hasArtifact = artifacts.some((name) => existsSync(join(dir, name)));
    if (!hasArtifact) {
      return { ok: false, error: `会话文件不存在: ${dir}` };
    }
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** HTML 转义（导出页使用）。 */
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 内容块转文本。 */
function blocksText(content, type = "text") {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && typeof b === "object" && b.type === type).map((b) => b.text ?? "").join("");
}

/** 提取工具结果文本（可能嵌套在 tool-result 块内）。 */
function toolResultText(content) {
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) out.push(block.text);
    else if (block.type === "tool-result" && Array.isArray(block.content)) out.push(toolResultText(block.content));
  }
  return out.join("");
}

/**
 * 导出会话为完整 HTML 网页（不截断任何内容，作为 webview 显示限制的补充）。
 * 输出到 DSH home 的 exports/ 目录，返回文件路径。
 */
async function exportSession(ctx, sessionId) {
  try {
    const query = ctx.get("sessionQuery");
    if (query === undefined) return { ok: false, error: "sessionQuery unavailable" };
    const snap = await query.readSession(SessionId(sessionId));
    const events = snap.events;
    const title = (await query.readTitle(SessionId(sessionId)))?.title ?? sessionId.slice(0, 18);
    const created = new Date(snap.session.createdAt ?? Date.now()).toLocaleString();

    const parts = [];
    parts.push(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>${escHtml(title)}</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 860px; margin: 24px auto; padding: 0 20px; color: #222; line-height: 1.65; }
  h1 { font-size: 20px; border-bottom: 2px solid #4d9fff; padding-bottom: 8px; }
  .meta { color: #777; font-size: 13px; margin-bottom: 24px; }
  .msg { border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
  .msg.user { background: #eef5ff; border-left: 4px solid #4d9fff; }
  .msg.assistant { background: #fafafa; }
  .role { font-size: 12px; color: #888; margin-bottom: 4px; }
  .reasoning { background: #fff8e6; border-left: 3px solid #e6a700; padding: 6px 10px; margin: 6px 0; font-size: 13px; color: #6b5d1f; white-space: pre-wrap; }
  .reasoning summary { cursor: pointer; font-weight: 600; color: #a07d00; }
  .tool { background: #f2f2f2; border: 1px solid #ddd; border-radius: 6px; margin: 6px 0; font-size: 13px; }
  .tool-head { padding: 4px 10px; font-family: Consolas, monospace; font-weight: 600; color: #333; }
  .tool-body { border-top: 1px solid #ddd; padding: 6px 10px; white-space: pre-wrap; word-break: break-word; font-family: Consolas, "Courier New", monospace; font-size: 12px; max-height: 320px; overflow-y: auto; background: #fafafa; }
  .tool-result { border-left: 3px solid #4d9fff; }
  .tool-result.error { border-left-color: #e51400; }
  pre.msg-text { white-space: pre-wrap; word-break: break-word; margin: 4px 0; font-family: inherit; font-size: 14px; }
  .divider { border: none; border-top: 1px dashed #ccc; margin: 18px 0; }
</style>
<script>
  // 导出页语言自适应（浏览器语言）：zh 显示中文标签，其余显示英文
  const zh = (navigator.language || "").toLowerCase().startsWith("zh");
  const L = {
    user: zh ? "用户" : "User",
    assistant: zh ? "助手" : "Assistant",
    session: zh ? "会话" : "Session",
    sessionId: zh ? "会话 ID" : "Session ID",
    created: zh ? "创建时间" : "Created",
    workdir: zh ? "工作目录" : "Working directory",
    thinking: (n) => zh ? "思考过程（" + n + " 字，点击展开）" : "Thinking (" + n + " chars, click to expand)",
    result: zh ? "结果" : "Result",
    failed: zh ? "（失败）" : " (failed)",
  };
  document.documentElement.lang = zh ? "zh-CN" : "en";
  document.getElementById("h1").textContent = L.session + "：" + document.getElementById("h1").textContent;
  document.querySelectorAll(".role-user").forEach((e) => e.textContent = "👤 " + L.user);
  document.querySelectorAll(".role-assistant").forEach((e) => e.textContent = "🤖 " + L.assistant);
  document.querySelectorAll(".reasoning summary").forEach((e) => {
    const n = e.getAttribute("data-len") || "";
    e.textContent = L.thinking(n);
  });
  document.querySelectorAll(".tool-result-label").forEach((e) => {
    e.textContent = L.result + (e.getAttribute("data-error") === "1" ? L.failed : "") + "：";
  });
  const meta = document.getElementById("meta");
  if (meta) {
    meta.innerHTML = meta.innerHTML
      .replace("SESSION_ID", L.sessionId)
      .replace("CREATED", L.created)
      .replace("WORKDIR", L.workdir);
  }
</script></head><body>
<h1 id="h1">${escHtml(title)}</h1>
<div id="meta" class="meta">SESSION_ID：${escHtml(sessionId)}<br>CREATED：${escHtml(created)}<br>WORKDIR：${escHtml(snap.session.cwd ?? "")}</div>`);

    // 按事件顺序渲染：用户消息 → 助手消息（思考+文本）→ 工具卡片（调用+结果）
    const body = [];
    const pendingCalls = new Map(); // callId -> {name, args}

    for (const e of events) {
      const d = e.data ?? {};
      if (e.type === "user/message") {
        const t = blocksText(d.content);
        if (t) {
          body.push(`<div class="msg user"><div class="role role-user">👤 用户</div><pre class="msg-text">${escHtml(t)}</pre></div>`);
        }
      } else if (e.type === "assistant/message") {
        const t = blocksText(d.message?.content);
        const r = blocksText(d.message?.content, "reasoning");
        if (t || r) {
          let html = `<div class="msg assistant"><div class="role role-assistant">🤖 助手</div>`;
          if (r) {
            html += `<details class="reasoning"><summary data-len="${r.length}">思考过程（${r.length} 字，点击展开）</summary>${escHtml(r)}</details>`;
          }
          html += `<pre class="msg-text">${escHtml(t || "")}</pre></div>`;
          body.push(html);
        }
      } else if (e.type === "tool/call") {
        pendingCalls.set(d.callId, { name: d.name, args: d.arguments ?? "" });
      } else if (e.type === "tool/result") {
        const message = d.message ?? {};
        const callId = message.source?.callId ?? message.content?.[0]?.toolCallId ?? "";
        const call = pendingCalls.get(callId);
        const resultText = toolResultText(message.content);
        const isError = Boolean(message.isError || d.error);
        if (call) {
          body.push(`<div class="tool ${isError ? "error" : ""}">
  <div class="tool-head">⚙ ${escHtml(call.name)}</div>
  <div class="tool-body">${escHtml(call.args)}</div>
  <div class="tool-body tool-result ${isError ? "error" : ""}"><b class="tool-result-label" data-error="${isError ? "1" : "0"}">结果${isError ? "（失败）" : ""}：</b>${escHtml(resultText)}</div>
</div>`);
        }
      }
    }

    parts.push(...body);
    parts.push(`</body></html>`);

    const exportDir = join(dshHomePath("exports"));
    mkdirSync(exportDir, { recursive: true });
    const outPath = join(exportDir, `${sessionId}.html`);
    writeFileSync(outPath, parts.join("\n"), "utf8");
    return { ok: true, path: outPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const env = { ...process.env };
  const pump = new EventPump();
  const approvals = { nextId: (() => { let n = 0; return () => ++n; })(), pending: new Map() };

  let ctx;
  let handle;
  let agent;
  /** 当前 agent 的可变模型选择引用（installModelSelection 使用；setModel 热切换）。 */
  let selection = null;
  /** 当前 agent 的"重置本轮思考步数预算"回调（chat 入口在每条用户消息前调用）。 */
  let resetStepBudget = null;
  let shuttingDown = false;

  try {
    ctx = await bootTree();
    log("info", "DSH tree booted");

    // 全局审批监听（根 ctx，一次）：覆盖主 agent 与所有 subagent 的越界请求
    installApprovalListener(ctx, approvals);
    log("info", "approval listener installed (root scope, covers all agents)");

    // 会话隔离迁移：把旧共享目录中插件自己的会话搬入独立目录（幂等）
    migrateLegacySessions();

    // 惰性创建：宿主启动时不创建会话（避免界面操作产生空会话），
    // 收到第一条 chat 或 resumeSession 时才真正创建/恢复。
    handle = undefined;
    agent = undefined;

    post({
      t: "ready",
      sessionId: "",
      cwd: process.cwd(),
      provider: "",
      model: env.DSH_VSCODE_MODEL ?? "",
      version: CORE_VERSION,
    });
    log("info", "host ready (lazy session)");
    // 自检模式（运行时升级验证用）：就绪即输出哨兵并退出（扩展侧据此判定闭包可用）
    if (process.env.DSH_SELF_TEST === "1") {
      process.stdout.write("DSH_SELF_TEST_OK\n");
      log("info", "self-test ok — exiting");
      process.exit(0);
    }
  } catch (error) {
    log("error", "host boot failed", error instanceof Error ? error.stack ?? error.message : String(error));
    // 展开错误明细：boot() 会把底层错误包装（消息带 NAME 前缀），AggregateError
    // 也可能不是裸类型——不依赖 instanceof，直接遍历 .errors 数组与 .cause 链，
    // 便于 CI smoke test / 输出通道定位平台差异（如 loader entries failed to apply）。
    const details = [];
    let cur = error;
    for (let depth = 0; cur && depth < 6; depth++) {
      if (Array.isArray(cur.errors)) {
        for (const e of cur.errors) {
          details.push(e instanceof Error ? e.stack ?? e.message : String(e));
        }
      } else if (cur.cause !== undefined && cur.cause !== null) {
        details.push(cur.cause instanceof Error ? cur.cause.stack ?? cur.cause.message : String(cur.cause));
      } else if (typeof cur.message === "string") {
        details.push(cur.message);
        break;
      } else {
        break;
      }
      cur = cur.cause ?? null;
    }
    if (details.length > 0) log("error", "boot failure causes", details.join("\n---\n"));
    post({ t: "exit", code: 1, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    return;
  }

  /** 优雅关闭：dispose 整棵树后退出。 */
  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      pump.flush();
      if (handle !== undefined) await handle.dispose();
      if (ctx !== undefined) await ctx.fiber.dispose();
    } catch (error) {
      log("error", "shutdown error", error instanceof Error ? error.message : String(error));
    }
    process.exit(code);
  }

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  /**
   * 帧处理串行队列（仅共享 agent 状态的帧排队）：
   * resumeSession / chat / newSession / deleteSession / compact 会读写 handle/agent/
   * resetStepBudget 等共享状态，若并发执行会产生错乱——典型场景：恢复历史会话期间
   * 用户发送消息，chat 帧在 resume 完成前看到 agent === undefined，误判为"无 agent"
   * 而**新建会话**（丢失"接着对话"语义）。这些帧按到达顺序串行处理。
   * stop / approval:resolve / setModel 等帧即时执行、不排队：stop 必须能随时打断
   * 正在运行的 chat（chat 帧 await whenIdle 时会阻塞队列，stop 不能等它）。
   */
  let criticalQueue = Promise.resolve();
  const CRITICAL_FRAMES = new Set(["chat", "newSession", "resumeSession", "deleteSession", "compact"]);

  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("warn", "unparseable frame", line.slice(0, 200));
      return;
    }
    if (CRITICAL_FRAMES.has(msg.t)) {
      // 串行执行；handleFrame 内部已捕获错误并补发失败帧，.catch 仅为防队列断裂
      criticalQueue = criticalQueue.then(() => handleFrame(msg)).catch((error) => {
        log("error", "critical frame chain failure", error instanceof Error ? error.message : String(error));
      });
    } else {
      void handleFrame(msg);
    }
  });

  async function handleFrame(msg) {
    try {
      switch (msg.t) {
          case "chat": {
            const text = typeof msg.text === "string" ? msg.text : "";
            if (text.trim() === "") {
              post({ t: "chatDone", id: msg.id, ok: false, error: "empty message" });
              return;
            }
            // 惰性创建：用户发出第一条消息时才创建会话（绝不预先创建空会话）
            if (agent === undefined) {
              const created = await createAgent(ctx, { model: msg.model ?? env.DSH_VSCODE_MODEL }, pump, approvals);
              handle = created.handle;
              agent = created.agent;
              selection = created.selection;
              resetStepBudget = created.resetStepBudget;
            }
            // 新一轮用户消息：重置本轮思考步数预算（maxSteps 是单轮上限，
            // 不是会话累计上限——会话对话次数一直累加，不作为控制指标）。
            resetStepBudget?.();
            // 首次创建后，向 UI 报告真实会话 id
            post({
              t: "ready",
              sessionId: agent.session.id,
              cwd: process.cwd(),
              provider: agent.options.provider,
              model: agent.options.model,
              version: CORE_VERSION,
              sessionTitle: await currentSessionTitle(ctx, agent),
            });
            agent.followup(
              createUserMessage({
                content: [{ type: "text", text }],
                source: { kind: "user" },
              })
            );
            await agent.whenIdle();
            // 关键：chatDone 前必须 flush 事件泵，否则最后一条 assistant/message
            // （含最终总结文本与 usage）会晚于"完成"信号到达扩展，导致 UI 已显示
            // 完成但总结文本缺失（表现为"卡在最后总结阶段"）。
            pump.flush();
            post({ t: "chatDone", id: msg.id, ok: true });
            break;
          }
          case "stop": {
            if (agent !== undefined) agent.cancel({ kind: "user" });
            post({ t: "stopAck", id: msg.id });
            break;
          }
          case "approval:resolve": {
            const entry = approvals.pending.get(msg.id);
            if (entry === undefined) break;
            approvals.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg.approve === true ? "allowed-once" : "rejected");
            break;
          }
          case "newSession": {
            if (handle !== undefined) {
              await handle.dispose();
              handle = undefined;
              agent = undefined;
              resetStepBudget = null;
            }
            // 惰性：新会话也等第一条消息才真正创建
            post({
              t: "ready",
              sessionId: "",
              cwd: process.cwd(),
              provider: "",
              model: env.DSH_VSCODE_MODEL ?? "",
              version: CORE_VERSION,
            });
            break;
          }
          case "listSessions": {
            try {
              const list = await listSessions(ctx);
              post({ t: "sessions", list });
            } catch (error) {
              log("error", "listSessions failed", error instanceof Error ? error.message : String(error));
              post({ t: "sessions", list: [], error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "resumeSession": {
            if (typeof msg.id !== "string" || msg.id.trim() === "") {
              post({ t: "sessionResumed", id: msg.id, ok: false, error: "invalid session id" });
              break;
            }
            if (handle !== undefined) await handle.dispose();
            const resumed = await resumeAgent(
              ctx,
              msg.id,
              { model: msg.model ?? env.DSH_VSCODE_MODEL },
              pump,
              approvals
            );
            handle = resumed.handle;
            agent = resumed.agent;
            selection = resumed.selection;
            resetStepBudget = resumed.resetStepBudget;
            // 重放历史（分页）：首次只取最近 limit 条事件，避免大会话
            // （2.6MB / 数百条）全量传输拖慢恢复；向上滚动时按需补更早的。
            // 同时由宿主侧计算完整统计快照（分页下 host.ts 无法从部分事件累计）。
            const allEvents = agent.session.events.filter(
              (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
            );
            const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
            const tail = allEvents.slice(-limit);
            const hasMore = allEvents.length > tail.length;
            const nextSeq = hasMore ? tail[0].seq : undefined;
            const stats = computeSessionStats(allEvents);
            post({ t: "history", sessionId: agent.session.id, events: tail, hasMore, nextSeq, stats });
            post({
              t: "ready",
              sessionId: agent.session.id,
              cwd: process.cwd(),
              provider: agent.options.provider,
              model: agent.options.model,
              version: CORE_VERSION,
              sessionTitle: await currentSessionTitle(ctx, agent),
            });
            post({ t: "sessionResumed", id: msg.id, ok: true });
            break;
          }
          case "loadMoreHistory": {
            // 向上滚动加载更早历史：agent 已 resume（events 在内存中），纯内存分页，很快。
            if (agent === undefined || !Number.isFinite(msg.beforeSeq)) {
              post({ t: "historyMore", sessionId: "", events: [], hasMore: false });
              break;
            }
            const allEvents = agent.session.events.filter(
              (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
            );
            const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
            const older = allEvents.filter((e) => e.seq < msg.beforeSeq).slice(-limit);
            const hasMore = allEvents.some((e) => e.seq < (older[0]?.seq ?? msg.beforeSeq));
            post({
              t: "historyMore",
              sessionId: agent.session.id,
              events: older,
              hasMore,
              nextSeq: hasMore && older.length > 0 ? older[0].seq : undefined,
            });
            break;
          }
          case "deleteSession": {
            const result = await deleteSession(ctx, msg.id);
            if (result.ok && agent !== undefined && agent.session.id === msg.id) {
              // 删除的是当前会话：重置为"待开始"状态（惰性）——
              // 不立即创建新会话，等用户发出第一条消息才真正创建，
              // 避免产生无对话的空会话。
              if (handle !== undefined) await handle.dispose();
              handle = undefined;
              agent = undefined;
              selection = null;
              resetStepBudget = null;
              post({
                t: "ready",
                sessionId: "",
                cwd: process.cwd(),
                provider: "",
                model: env.DSH_VSCODE_MODEL ?? "",
                version: CORE_VERSION,
              });
            }
            post({ t: "sessionDeleted", id: msg.id, ok: result.ok, error: result.error });
            break;
          }
          case "exportSession": {
            const result = await exportSession(ctx, msg.id);
            post({ t: "sessionExported", id: msg.id, ok: result.ok, path: result.path, error: result.error });
            break;
          }
          case "setModel": {
            try {
              const defaultModel = ctx.get("agentDefaultModel");
              if (defaultModel === undefined) {
                post({ t: "modelChanged", provider: "", model: "", error: "agentDefaultModel unavailable" });
                break;
              }
              const base = defaultModel.currentSelection();
              const provider = typeof msg.provider === "string" && msg.provider !== "" ? msg.provider : base.provider;
              const model = typeof msg.model === "string" && msg.model !== "" ? msg.model : base.model;
              // 思考等级：统一小写并规范化（low → high，见 normalizeEffort 注释）；
              // 非法/空值回退到当前基线（基线同样规范化，历史遗留的大写/非法值一并修正）
              const baseEffort = normalizeEffort(base.reasoningEffort);
              const reasoningEffort =
                normalizeEffort(typeof msg.reasoningEffort === "string" ? msg.reasoningEffort : "") ?? baseEffort;
              const next = { provider, model, reasoningEffort };
              // 持久化默认选择（影响之后新建的 agent）
              await defaultModel.saveSelection(next);
              // 热切换当前 agent 的选择引用（installModelSelection 每次请求读取该对象）
              if (selection !== null) {
                selection.provider = provider;
                selection.model = model;
                selection.reasoningEffort = reasoningEffort;
              }
              userEffortChanged = true; // 用户切换思考级别：下一次模型请求打印实际值
              log("info", L(`模型选择 → ${provider}/${model}${reasoningEffort ? `（思考级别=${reasoningEffort}）` : ""}`, `model selection → ${provider}/${model}${reasoningEffort ? ` (effort=${reasoningEffort})` : ""}`));
              post({ t: "modelChanged", provider, model, reasoningEffort });
            } catch (error) {
              log("error", "setModel failed", error instanceof Error ? error.message : String(error));
              post({ t: "modelChanged", provider: "", model: "", error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "setWorkMode": {
            const mode = msg.mode === "multi" ? "multi" : "single";
            workMode = mode;
            log("info", `work mode → ${mode}`);
            post({ t: "workModeChanged", mode });
            break;
          }
          case "getModelInfo": {
            try {
              const llm = ctx.get("llm");
              const defaultModel = ctx.get("agentDefaultModel");
              let providers = [];
              if (llm !== undefined && typeof llm.listProviders === "function") {
                providers = llm.listProviders().map((p) => ({ id: p.id, name: p.name ?? p.id }));
              }
              let models = [];
              if (llm !== undefined && typeof llm.listModels === "function" && providers.length > 0) {
                try {
                  const listed = await llm.listModels(providers[0].id);
                  models = listed.map((m) => m.id);
                } catch {
                  models = [];
                }
              }
              if (models.length === 0) {
                // 兜底：现役 DeepSeek 模型（也包含当前选择，保证下拉至少可选回当前模型）。
                // 备忘：deepseek-chat / deepseek-reasoner 已停止服务（旧模型下线），
                // 不再列入候选；现役为 deepseek-v4-flash / deepseek-v4-pro。
                const cur = defaultModel?.currentSelection?.();
                const extra = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
                if (cur?.model) extra.add(cur.model);
                models = [...extra];
              }
              const current = defaultModel?.currentSelection?.() ?? { provider: "", model: "" };
              // 查询当前模型支持的思考等级与默认档（内核真实能力）。
              // 备忘：DeepSeek 适配器（dsh-llm-deepseek）只声明 off/high/max 三档，
              // 无 low——low 由官方服务端映射为 high。插件向 UI 返回完整四档
              // （off/low/high/max），low 在宿主 setModel 层归一为 high，保证可选不报错。
              let supportedEfforts = ["off", "low", "high", "max"];
              let defaultEffort = "high";
              if (llm !== undefined && typeof llm.resolveModelInfo === "function" && current.provider && current.model) {
                try {
                  // 注意：llm 服务（LlmRuntime）的方法名是 resolveModelInfo（resolveModel 是
                  // adapter 层方法，服务上不存在——早期误用导致内核能力从未被真正查询）。
                  const resolved = await llm.resolveModelInfo(current.provider, current.model, undefined);
                  const efforts = resolved?.reasoning?.efforts;
                  if (Array.isArray(efforts)) {
                    supportedEfforts = ["off", "low", "high", "max"]; // 插件语义层固定四档（见上）
                    if (typeof resolved?.reasoning?.defaultEffort === "string" && resolved.reasoning.defaultEffort !== "") {
                      defaultEffort = normalizeEffort(resolved.reasoning.defaultEffort) ?? "high";
                    }
                  }
                } catch (error) {
                  log("warn", "resolveModelInfo failed, fallback to 4-level effort list", error instanceof Error ? error.message : String(error));
                }
              }
              post({
                t: "modelInfo",
                providers,
                models,
                current: {
                  provider: current.provider,
                  model: current.model,
                  reasoningEffort: normalizeEffort(current.reasoningEffort),
                  supportedEfforts,
                  defaultEffort,
                },
              });
            } catch (error) {
              log("error", "getModelInfo failed", error instanceof Error ? error.message : String(error));
              post({
                t: "modelInfo",
                providers: [],
                models: [],
                current: { provider: "", model: env.DSH_VSCODE_MODEL ?? "" },
              });
            }
            break;
          }
          case "compact": {
            try {
              const compaction = ctx.get("compaction");
              if (compaction === undefined) {
                post({ t: "compactDone", id: msg.id, ok: false, error: "compaction service unavailable" });
                break;
              }
              if (agent === undefined) {
                post({ t: "compactDone", id: msg.id, ok: false, error: "no active session yet" });
                break;
              }
              const signal = new AbortController().signal;
              const result = await compaction.compactNow(agent, signal);
              if (result === null) {
                post({ t: "compactDone", id: msg.id, ok: true, text: "No compactable history yet." });
              } else {
                post({
                  t: "compactDone",
                  id: msg.id,
                  ok: true,
                  text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
                });
                // 压缩完成：立即推送刷新后的统计（上下文占用应显著下降）。
                // lastRequestInput 是最近一次请求输入（含缓存），减去被遮蔽的
                // token 数即近似当前上下文占用；下一次真实请求会给出精确值。
                try {
                  const allEvents = agent.session.events.filter(
                    (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
                  );
                  const stats = computeSessionStats(allEvents);
                  if (Number.isFinite(stats.lastRequestInput) && stats.lastRequestInput > 0 && result.shadowedTokenCount > 0) {
                    stats.lastRequestInput = Math.max(0, stats.lastRequestInput - result.shadowedTokenCount);
                  }
                  post({ t: "stats", stats });
                } catch (error) {
                  log("warn", "compact stats refresh failed", error instanceof Error ? error.message : String(error));
                }
              }
            } catch (error) {
              log("warn", "compact failed", error instanceof Error ? error.message : String(error));
              post({ t: "compactDone", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "shutdown": {
            await shutdown(0);
            break;
          }
          default:
            log("warn", "unknown frame type", msg.t);
        }
      } catch (error) {
        log("error", "frame handling failed", error instanceof Error ? error.stack ?? error.message : String(error));
        const message = error instanceof Error ? error.message : String(error);
        // 按帧类型补发失败响应（否则扩展/UI 会永久等待，如 resume 卡在"正在恢复会话…"）
        if (msg.t === "resumeSession") {
          post({ t: "sessionResumed", id: msg.id, ok: false, error: message });
        } else if (msg.id !== undefined) {
          post({ t: "chatDone", id: msg.id, ok: false, error: message });
        }
      }
  }

  rl.on("close", () => void shutdown(0));
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
