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
const CORE_VERSION = "0.1.0";
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
  // 平台感知路径拼接（修复 P1-15）：此前硬编码 "\\" 在非 Windows 上会生成
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
 * @returns {Promise<{handle: import('@deepseek-ai/dsh-agent').AgentHandle, agent: import('@deepseek-ai/dsh-agent').Agent, selection: object}>}
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

  attachAgent(ctx, handle, pump);
  await handle.agent.whenIdle();
  return { handle, agent: handle.agent, selection };
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

  attachAgent(ctx, handle, pump);
  await handle.agent.whenIdle();
  return { handle, agent: handle.agent, selection };
}

/**
 * 多 Agent 编排模式的系统提示补充段。
 * 挂载在 system-prompt/assemble 瀑布上：multi 模式下注入"拆解 → 并行子代理 → 汇总"
 * 的指令，让主 agent 用 DSH 原生的 subagent 工具并行执行子任务。
 */
const MULTI_AGENT_SECTION = {
  name: "work-mode",
  text:
    "Current work mode: MULTI-AGENT ORCHESTRATION.\n" +
    "For the task at hand: (1) decompose it into independent subtasks; " +
    "(2) run them in PARALLEL by dispatching subagents with the subagent tools " +
    "(spawn multiple agents concurrently, one per subtask, giving each a self-contained prompt); " +
    "(3) collect their results and synthesize a final answer yourself. " +
    "Use parallel dispatch whenever subtasks do not depend on each other. " +
    "Keep the user informed: show each dispatched subagent as it starts and when it returns.",
};

/**
 * 挂接事件/状态监听（create 与 resume 共用；每个 agent 各挂一份）。
 * 注意：审批监听不在这里——它必须挂在**根 ctx**（installApprovalListener，
 * 全局一次）：dsh-scope 的事件向上流动，根 ctx 的无标签监听器能收到
 * 所有 agent（含 subagent 工具创建的子 agent）的 approval/request，
 * 否则子 agent 的越界请求会因无监听者而 fail-closed（静默拒绝、无弹窗）。
 */
function attachAgent(ctx, handle, pump) {
  const agent = handle.agent;

  // 会话事件 → 扩展（scope-filtered：仅本 agent 的会话）
  agent.ctx.on("session/event", (_session, event) => {
    pump.push(event);
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
      sections: [...(assembled.sections ?? []), MULTI_AGENT_SECTION],
    };
  });
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
  const stats = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
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
  } catch (error) {
    log("error", "host boot failed", error instanceof Error ? error.stack ?? error.message : String(error));
    // AggregateError（如 cordis loader entries failed to apply）默认不打印 causes
    // 数组，这里展开明细，便于 CI smoke test / 输出通道定位平台差异
    if (error instanceof AggregateError && Array.isArray(error.errors)) {
      const causes = error.errors
        .map((e) => (e instanceof Error ? e.stack ?? e.message : String(e)))
        .join("\n---\n");
      log("error", "boot failure causes", causes);
    }
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
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("warn", "unparseable frame", line.slice(0, 200));
      return;
    }
    void (async () => {
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
            }
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
              const reasoningEffort =
                typeof msg.reasoningEffort === "string" && msg.reasoningEffort !== ""
                  ? msg.reasoningEffort
                  : base.reasoningEffort;
              const next = { provider, model, reasoningEffort };
              // 持久化默认选择（影响之后新建的 agent）
              await defaultModel.saveSelection(next);
              // 热切换当前 agent 的选择引用（installModelSelection 每次请求读取该对象）
              if (selection !== null) {
                selection.provider = provider;
                selection.model = model;
                selection.reasoningEffort = reasoningEffort;
              }
              log("info", `model selection → ${provider}/${model}${reasoningEffort ? ` (effort=${reasoningEffort})` : ""}`);
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
                // 兜底：常见 DeepSeek 模型（也包含当前选择，保证下拉至少可选回当前模型）
                const cur = defaultModel?.currentSelection?.();
                const extra = new Set(["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"]);
                if (cur?.model) extra.add(cur.model);
                models = [...extra];
              }
              const current = defaultModel?.currentSelection?.() ?? { provider: "", model: "" };
              // 查询当前模型支持的思考等级（如 deepseek-v4 系列支持 off/high/max；
              // 未来模型若支持 low 会自动出现在列表里，UI 按此渲染下拉选项）
              let supportedEfforts;
              if (llm !== undefined && typeof llm.resolveModel === "function" && current.provider && current.model) {
                try {
                  const resolved = await llm.resolveModel(current.provider, current.model, undefined);
                  const efforts = resolved?.reasoning?.efforts;
                  if (Array.isArray(efforts)) {
                    supportedEfforts = efforts.map((e) => (typeof e === "string" ? e : e?.id)).filter(Boolean);
                  }
                } catch {
                  supportedEfforts = undefined;
                }
              }
              post({
                t: "modelInfo",
                providers,
                models,
                current: {
                  provider: current.provider,
                  model: current.model,
                  reasoningEffort: current.reasoningEffort,
                  supportedEfforts,
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
    })();
  });

  rl.on("close", () => void shutdown(0));
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
