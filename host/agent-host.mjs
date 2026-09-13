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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { boot, loadLayeredEnv, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome, dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createUserMessage, BlockAssembler } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

// 父进程（VS Code 扩展宿主）消失时自杀：协议管道关闭/断开即退出，避免留下孤儿宿主。
// 扩展宿主被 Reload / 终止时不会执行 dispose()，若不自杀，本进程会长期存活、占用内存
// 并继续写同一个 dsh-host.log（这正是历史上出现"多个 node 宿主并存"的原因之一）。
for (const ev of ["end", "close"]) process.stdin.on(ev, () => process.exit(0));
process.on("disconnect", () => process.exit(0));

/** 统一读取扩展注入的布尔开关（"0"/"1"）。此前 composePatches 用分层 env、
 *  attachAgent 用 process.env 判读 DSH_ENABLE_CUSTOM，两源不一致时定制人设会静默
 *  丢失——这些开关只由扩展经 process.env 注入（host.ts），settings.yaml 不承载，
 *  故以 process.env 为唯一真源。 */
function envFlag(name) {
  return String(process.env[name] ?? "0") !== "0";
}

const NAME = "dsh-vscode-host";
const CORE_VERSION = "0.5.4";
/** 插件会话 id 前缀（也是会话隔离的标识）。 */
const SESSION_PREFIX = "dsh-vscode-";

/** 当前工作模式（模块级：createAgent 的 attachAgent 需要读取；setWorkMode 更新）。 */
let workMode = "single";

/** dshProviders（配置真源，与插件 globalState 的持久化键同名）：配置页保存的
 *  "已接入提供商 + 已选中模型"清单（含自定义提供商；也含官方路由 deepseek-official）。
 *  对话面板的提供商与模型**只**从这里取得——提供商及其模型都必须先在配置页配置，
 *  才能被选用。内核目录（llm-pi-ai / llm-deepseek 的 listModels）只用于补元数据与
 *  解析路由，不充当可选项枚举源。宿主重启后由扩展侧在 ready 时重新同步一次。 */
let dshProviders = [];
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
 * 探测**当前实际加载的**内核 `dsh-system-prompt` 是否使用 `personaPrefix` 字段。
 *
 * 背景（0.1.5 升级适配，2026-09）：dsh-system-prompt 在 0.1.5-rc.2 把部署人设字段由
 * `persona` 改名为 `personaPrefix`（并新增 `personaSuffix`）；而本插件对 system-prompt
 * 行是"整行替换 config"（Cordis patch 语义），若仍写 `persona`，新版 schema 会丢弃该
 * 未知键并取 `personaPrefix` 默认空串 → 插件人设（工作目录/编码注意事项等）静默失效。
 * 因此按**特征探测**而非版本号猜测：直接读已安装包源码，命中 `personaPrefix` 即用新键；
 * 探测不到（旧版/读取失败）→ 保持 `persona`（内置 0.1.1-rc.2 行为不变）。
 * 运行时升级场景下 import.meta.resolve 指向 DSH_RUNTIME_NODE_MODULES 隔离目录中的包，
 * 探测结果即实际加载版本，无需人工同步。
 */
/** 判定内核版本是否 ≥ 0.1.5（persona → personaPrefix 的重命名版本）。 */
function personaPrefixSince(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!m) return false;
  const ma = Number(m[1]);
  const mi = Number(m[2]);
  const pa = Number(m[3]);
  if (ma > 0) return true;
  if (mi > 1) return true; // 0.2.x+ 也在 0.1.5 之后
  if (mi < 1) return false; // 0.0.x
  return pa >= 5; // 0.1.x：0.1.5 起
}

function detectPersonaPrefixField() {
  // 版本优先（authoritative）：0.1.5 起 persona 永久改名为 personaPrefix，
  // 版本可比对则不再依赖子串探测（子串会被注释/类型/重导出误报、被压缩漏报）。
  try {
    const pkgPath = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-system-prompt/package.json"));
    const ver = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (typeof ver === "string" && /^(\d+)\.(\d+)\.(\d+)/.test(ver)) {
      return personaPrefixSince(ver);
    }
  } catch {
    /* 版本读取失败 → 回退源码特征探测 */
  }
  // 回退：源码特征探测（老包 exports 可能不允许 package.json 子路径）
  for (const spec of [
    "@deepseek-ai/dsh-system-prompt/lib/index.js",
    "@deepseek-ai/dsh-system-prompt/package.json",
  ]) {
    let resolved;
    try {
      resolved = fileURLToPath(import.meta.resolve(spec));
    } catch {
      continue; // exports 不允许该子路径 → 尝试下一个候选
    }
    try {
      if (spec.endsWith("package.json")) {
        // 从包根推导入口（兼容 lib / dist 布局）
        const dir = dirname(resolved);
        for (const rel of ["lib/index.js", "dist/index.js", "lib/types/index.js"]) {
          const f = join(dir, rel);
          if (existsSync(f) && readFileSync(f, "utf8").includes("personaPrefix")) return true;
        }
        continue;
      }
      if (readFileSync(resolved, "utf8").includes("personaPrefix")) return true;
    } catch {
      /* 读取失败 → 继续尝试下一个候选 */
    }
  }
  return false;
}

/** 进程内一次性探测结果（运行时升级后宿主重启会重新探测）。 */
const DSH_PERSONA_PREFIX_SUPPORTED = detectPersonaPrefixField();

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

  // 人设文本（与 system-prompt 行的字段名解耦：0.1.5 起内核把 persona 改名为
  // personaPrefix，旧版仍用 persona——见 detectPersonaPrefixField 特征探测）。
  const personaText =
    "You are a coding agent powered by the {{model}} model, running inside the DeepSeek Harness VS Code extension. " +
    `Your working directory is ${currentCwd} — the user's current workspace. Use this directory for all file operations and command workdirs. ` +
    "Help with coding tasks: read and edit files, run commands, search the web, and orchestrate subagents and workflows. " +
    "File edits you make appear live in the editor. Plan before large changes; prefer the plan-mode workflow for ambiguous or big tasks. " +
    "Work is driven turn by turn by the user: a long-running task that cannot be finished within one turn must end with a clear summary of progress and next steps, waiting for the user's next instruction. " +
    "Tool calls, approvals, and todos are shown to the user in real time; keep them informed and concise. " +
    "Permissions: operations outside the workspace are denied by the sandbox by default. " +
    "When a task genuinely needs wider access (e.g. reading or writing files outside the workspace, or system-level commands), " +
    "you may request a one-time escalation by passing `sandbox_permissions` (the narrowest wider mode that suffices, e.g. \"danger-full-access\") " +
    "together with a clear `justification` to the file/command tools and parameters in detail — the user is then prompted to approve or deny in the UI. " +
    "Do not request escalation casually; prefer working inside the workspace. " +
    "Encoding: on Windows, command output (PowerShell 5.1 / Python) defaults to the system code page, " +
    "which garbles non-ASCII text (any language) when captured. When running a command whose output " +
    "may contain non-ASCII characters, force UTF-8 output: prefix PowerShell commands with " +
    "`[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8;` " +
    "or run `chcp 65001 >nul` first, and for Python set `$env:PYTHONIOENCODING='utf-8'` — " +
    "otherwise the captured output will be garbled.";

  // 用户定制（ay-dsh-custom.md）的内核承载位：0.1.5 起 system-prompt 提供
  // `personaSuffix`（全局部署模板，order 10200，位于第一方指导之后）。把这种
  // **用户可编辑内容**放在后缀位，编辑文件后重启宿主不会改动靠前的 personaPrefix，
  // 第一方可复用前缀保持不变（配合 deepseek-flash 的 in-history 追加，KV cache 继续命中）。
  // 旧内核无该字段：保持原有 system-prompt/assemble 动态 section 注入路径。
  let personaSuffixText = "";
  if (DSH_PERSONA_PREFIX_SUPPORTED && envFlag("DSH_ENABLE_CUSTOM")) {
    try {
      personaSuffixText = readFileSync(join(resolveDshHome(), "ay-dsh-custom.md"), "utf8").trim();
    } catch {
      /* 文件不存在 / 不可读：不注入后缀（等同于未启用定制） */
    }
  }

  const overlay = [
    {
      id: "system-prompt",
      // 内核字段名适配（patch 为整行替换 config 语义：只提供内核实际支持的键，
      // 误用旧键会被新版 schema 丢弃 → 人设静默失效）。
      config: DSH_PERSONA_PREFIX_SUPPORTED
        ? { personaPrefix: personaText, ...(personaSuffixText ? { personaSuffix: personaSuffixText } : {}) }
        : { persona: personaText },
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
    // 上下文自动压缩（compaction-basic）：把扩展侧 VS Code 设置注入内核配置。
    // auto=是否启用，thresholdRatio=触发比例（contextWindow 占比），maxTokens=摘要 token 上限。
    // 值来自 host.ts spawn 时设置的环境变量；配置面板"控制参数"区保存后重启宿主生效。
    {
      id: "compaction-basic",
      config: {
        auto: env.DSH_COMPACTION_AUTO !== "false",
        thresholdRatio: Number(env.DSH_COMPACTION_THRESHOLD_RATIO) || 0.8,
        maxTokens: Number(env.DSH_COMPACTION_MAX_TOKENS) || 8192,
      },
    },
    // 禁用的插件（对应依赖已从 VSIX 剔除，不加载即不 import）：
    // - session-telemetry-otel：遥测，插件默认关闭
    // - typert-gateway（dsh-api-gateway / host-apiproxy）：web API 网关。它会先于
    //   本插件的监听器拦截 approval/request 并等待 web 客户端响应（插件无 web 客户端），
    //   导致审批请求永久挂起、授权弹框不出现。headless 场景无需该网关。
    // llm-pi-ai：多提供商网关（启用）。它提供内置提供商目录（openai/anthropic/gemini/
    // groq/mistral/openrouter…）与通用适配器；提供商配置经 settings 服务（llm-pi-ai
    // namespace）写入后即可路由。deepseek 仍由 llm-deepseek 适配器独占路由。
    { id: "session-telemetry-otel", disabled: true },
    { id: "typert-gateway", disabled: true },
  ];

  // G1（2026-09 owner 定）：默认排除 DSH 内核的 goal 自动续跑机制。
  // goal 是"无人值守长跑"设计（agent idle 即自动 followup <goal_round> 续跑），与
  // 插件的"人工在环"模式（每轮由用户消息驱动 + 单轮步数预算、达限即总结等待用户）
  // 冲突：goal round 不经 chat 帧、不触发宿主预算重置，曾导致达限后 0 步空转死循环
  // （token 黑洞）。故默认禁用三件套，仅保留 goals 域服务供宿主恢复会话时 pause
  // 存量遗留 goal（见 pauseLegacyActiveGoal）：
  //   - goal-round-driver：自动续跑驱动（死循环源头）
  //   - tool-goal：模型创建/管理 goal 的工具（无工具则不会产生新 goal）
  //   - command-goal：/goal 斜杠命令入口
  // G2 扩展点：若将来需要无人值守长跑（如授权后自主完成大任务），把
  // env.DSH_ENABLE_GOAL_ROUNDS 置 "1"（或改为配置项）跳过下方禁用，并配套
  // 改造"预算按 agent turn 重置"（goal round 每轮独立预算，避免 0 步空转）。
  // 当前默认关闭——插件不需要无人值守模式，短期预计不启用。
  if (env.DSH_ENABLE_GOAL_ROUNDS !== "1") {
    overlay.push({ id: "goal-round-driver", disabled: true });
    overlay.push({ id: "tool-goal", disabled: true });
    overlay.push({ id: "command-goal", disabled: true });
  }

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
  constructor(sizeProvider) {
    this.queue = [];
    this.timer = undefined;
    this.sizeProvider = sizeProvider;
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
    // 每批附带当前会话日志文件大小（前端标题栏 KB 显示；批内一次 stat 开销可忽略）
    let sessionBytes;
    try { sessionBytes = this.sizeProvider?.(); } catch { /* ignore */ }
    post(
      sessionBytes === undefined
        ? { t: "events", events: batch }
        : { t: "events", events: batch, sessionBytes }
    );
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

  // 支持轮转场景指定会话 id（会话已预写摘要、meta 已绑定，agent 惰性创建于首条消息）
  const sessionId = options?.sessionId ?? `dsh-vscode-${randomUUID()}`;
  const handle = await agents.create({
    sessionId: SessionId(sessionId),
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
  // 恢复历史会话时可按 meta 还原当时的思考级别（options.reasoningEffort）
  const reasoningEffort =
    normalizeEffort(typeof options.reasoningEffort === "string" ? options.reasoningEffort : "") ?? base.reasoningEffort;
  const selection = { provider, model, reasoningEffort };

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
 * 对 low 会抛 UNSUPPORTED_REASONING_EFFORT（resolveCallConfig 实测拒绝）。
 * 因此在宿主层把 low 归一为 high：
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
 * 思考档位强度序（弱 → 强，含 pi-ai/各家厂商扩展档位）。
 * 面板固定 4 档（off/low/high/max），但模型实际档位各异（如 zai 的
 * [off, minimal, low, medium, high]）。**匹配按语义强度位置对齐，不按文字**：
 * 面板的 high 对应模型档位序列里"语义强度相当"的一档（如 zai 的 medium），
 * 而非简单 high→high（那是模型自己的最高档）。
 */
const EFFORT_STRENGTH = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** 面板固定四档（弱 → 强；off 为关闭思考）。 */
const PANEL_EFFORTS = ["off", "low", "high", "max"];

/**
 * 思考级别参数自动适配：把请求的档位映射到模型真实支持的档位，
 * 让"模型不支持某参数"不再中断任务（原行为：内核抛 UNSUPPORTED_* → 大红错误）。
 *
 * 匹配规则（**按语义强度位置，不按文字**）：
 * - 请求档位在模型**完整档位序列**（含 off）里的对应位置直接命中 → 原样返回；
 * - 未命中时按位置比例对齐：面板第 pi 档（0..3，off/low/high/max）→ 模型序列
 *   中 round(pi * (n-1) / 3) 的位置（如面板 high 对 zai5 → medium、对 deepseek → high）；
 * - 模型无任何档位（supported 空）→ 剔除参数（undefined，走模型默认），
 *   此时 off 语义=不传 thinking（关闭思考），其余档位语义=不传 effort 走模型默认。
 * @param {string|undefined} requested 请求的思考级别（面板四档之一）
 * @param {string[]} supported 模型真实支持的档位列表（resolveModelInfo.reasoning.efforts[].id）
 * @returns {{value: string|undefined, adapted: boolean}} value 为最终档位（undefined = 不传），
 *   adapted 表示是否做了调整（供日志/状态栏提示）
 */
function adaptEffort(requested, supported) {
  if (!requested) return { value: undefined, adapted: false };
  const list = Array.isArray(supported) ? supported : [];
  // off（关闭思考）：模型支持 off 就原样用；否则剔除（不传 thinking = 关闭）
  if (requested === "off") {
    return list.includes("off") ? { value: "off", adapted: false } : { value: undefined, adapted: true };
  }
  // 模型完整档位（含 off），按语义强度升序
  const seq = [...list].filter(Boolean).sort((a, b) => (EFFORT_STRENGTH[a] ?? 0) - (EFFORT_STRENGTH[b] ?? 0));
  if (seq.length === 0) return { value: undefined, adapted: true };
  const pi = PANEL_EFFORTS.indexOf(requested);
  if (pi < 0) return { value: undefined, adapted: true };
  // **按语义强度位置对齐**（含 off 的完整序列，不按文字）：
  // 面板第 pi 档（0..3）→ 模型序列中 round(pi * (n-1) / 3) 的位置。
  // 例：面板 high(pi=2) 对 deepseek [off,high,max] → round(2*2/3)=1 → high（不越级）；
  //     对 zai5 [off,minimal,low,medium,high] → round(2*4/3)=3 → medium（不落到模型最高档）。
  const ti = Math.round((pi * (seq.length - 1)) / (PANEL_EFFORTS.length - 1));
  const value = seq[ti];
  return { value, adapted: value !== requested };
}

/**
 * 对 agent/request 瀑布的 request 应用思考档位替换。
 * request 由 dsh-agent-loop buildRequest **深冻结**（deepFreeze）——任何就地
 * 赋值/删除都会在 ESM 严格模式下抛 TypeError（"Cannot assign to read only
 * property 'reasoningEffort'"）。必须解构重建新对象，靠瀑布返回值替换原配置
 * （与 dsh-agent installModelSelection 对同一瀑布的做法一致）。
 * @param {object} request 内核冻结的请求配置对象
 * @param {string|undefined} effort 最终档位（undefined = 剔除该参数走模型默认）
 * @returns {object} 新的请求配置对象
 */
function applyEffort(request, effort) {
  if (effort === undefined) {
    const { reasoningEffort: _drop, ...rest } = request;
    return rest;
  }
  return { ...request, reasoningEffort: effort };
}

/** 思考级别缓存挂在 globalThis：即使模块被加载多份（bundle / 源文件 / 多次实例化），
 *  也共享同一份缓存，避免同一 `provider|model|effort` 组合在每个请求都重新查询能力。 */
const EFFORT_CACHE_SLOT = "__ayDshVscodeEffortCaches";
const effortCaches = (globalThis[EFFORT_CACHE_SLOT] ??= { capability: new Map(), adapted: new Map() });
/** 模型思考能力缓存：`provider|model` -> 支持的档位数组（能力查询免重复开销）。 */
const effortCapabilityCache = effortCaches.capability;
/**
 * 思考级别适配结果缓存：`provider|model|requestedEffort` -> 最终档位。
 * **每个模型每种档位组合首次请求时查询并适配一次，之后直接复用适配后的参数**，
 * 不再做 resolveModelInfo / includes 等任何校正工作（模型换不了几个、思考级别
 * 就 4 档，组合数量级极小）。值为 undefined 表示"该组合被判定为剔除参数
 * （走模型默认）"，与"未缓存"用 Map.has 区分。
 */
const effortAdaptedCache = effortCaches.adapted;
/** 适配诊断日志开关（默认关）：需要排查时设 `DSH_DEBUG_ADAPT=1` 打开。 */
const DEBUG_ADAPT = process.env.DSH_DEBUG_ADAPT === "1";

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
      text: "【语言规则】：请始终使用简体中文回复用户，思考过程（reasoning）同样使用简体中文。除非用户明确要求使用其他语言。",
    };
  }
  return {
    name: "language",
    text: "[Language rule]: Always reply in English, including your reasoning. Use English unless the user explicitly asks for another language.",
  };
}

/** 标题时间字段（统一可读格式）：`YYYY-MM-DD_HH-mm-ss.SSS`（下划线代替空格，精确到毫秒）。 */
function fmtTitleTime(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** 子代理会话标题：`subsession_<可读时间>_<sessionId>`（sessionId 天然唯一防重叠，可追溯）。 */
function genSubsessionTitle(sessionId) {
  return `subsession_${fmtTitleTime(Date.now())}_${sessionId}`;
}

/** 生成会话静态临时标题：`newsession_<可读时间>_<首条指令前10字>`。
 *  - 时间精确到毫秒（下划线代空格，可读）；
 *  - 标题是**静态记录**：创建会话时生成一次，之后仅由用户重命名覆盖；
 *    列表读取直接走 session-meta.json，不读会话日志。 */
function genTempTitle(firstInstruction) {
  const head = String(firstInstruction ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 10);
  return `newsession_${fmtTitleTime(Date.now())}_${head}`;
}

/**
 * 系统提示层：工具调用边界规则（每轮注入）。
 * 区分"模型推理必需的工具调用"与"替用户完成的工作"：
 *  - 前者（读文件/搜索/执行能直接产生推理依据的命令）→ 模型发起并处理结果；
 *  - 后者（编译/打包/部署/全面安全检查等重复性收尾动作、非推理必需的操作）→
 *    **不调用工具**、不发起不必要的授权请求，改为在最终答复给出操作步骤/命令
 *    清单由用户自行执行。目的：大幅减少无谓工具调用与授权弹窗，省时间省 token。
 */
function toolBoundarySection() {
  if (UI_LANG === "zh") {
    return {
      name: "tool-boundary",
      text:
        "【工具调用边界规则】：工具调用仅用于**模型推理所必需**的信息收集与分析" +
        "（读文件、搜索、执行能直接产生推理依据的命令），且优先调用沙箱内工具。" +
        "**替用户完成的工作不要调用工具**——例如编译、打包、部署、每轮结尾的全面安全检查等" +
        "重复性验证动作，除非用户明确要求，否则不主动执行：改为在最终答复中给出清晰的操作步骤/命令清单，" +
        "由用户自行执行；也不要发起不必要的权限授权请求。",
    };
  }
  return {
    name: "tool-boundary",
    text:
      "[Tool-use boundary rule]: use tools ONLY for information gathering and analysis your reasoning requires " +
      "(reading files, searching, running commands that directly produce reasoning evidence), and prefer in-sandbox tools." +
      "Do NOT call tools to do the user's work for them — e.g. compiling, packaging, deploying, or full " +
      "security sweeps at the end of every turn. Unless the user explicitly asks, don't perform these yourself: " +
      "instead give a clear step-by-step command list in your final answer for the user to run. " +
      "Don't raise unnecessary approval requests either.",
  };
}

/**
 * 系统提示层：收尾报告规则（独立 section，**文本完全静态**——KV 缓存纪律：
 * 系统提示不得含任何动态内容）。规则：最终答复首行按固定格式报告本轮统计。
 * 数字来源：达限时由 [达限警示]（prompt 末尾）提供精确值并数字直拼；自然
 * 收尾时由模型引用最近的 [本步指引]（含截至当前步的实时数字）或按执行自述。
 * 遵守率非 100%——owner 决策：不做宿主兜底 UI，未看到报告时由 owner 明确
 * 要求模型报告（见 docs 2.13）。
 */
/**
 * 系统提示层：单轮思考预算静态规则（每轮注入，**文本完全静态**——KV 缓存纪律）。
 * 预算 limit 为进程内常量（修改=重启生效），静态安全；规则强调"最少步数/批量
 * 工具调用/达限收尾"，动态数值（已用/剩余/工具/耗时）由 [本步指引] 每步提供。
 */
function stepBudgetSection(limit) {
  if (UI_LANG === "zh") {
    return {
      name: "step-budget",
      text:
        `【每轮对话思考预算规则】: 每轮对话（一条用户消息）的思考步数预算为 ${limit} 步，请在此预算内规划工作节奏。` +
        "请全力发挥能力，以**最少的步数**实现最好的解决效果，提高效率、节省 tokens。" +
        "效率要点：动手前先简述你的计划与预估步数（写在回复文本中，不消耗工具步数），按计划执行减少绕路；" +
        "需要收集多项信息时，在同一答复中**一次发起多个工具调用**（并行批量收集），" +
        "一次性拿回所有需要的信息后再分析；仅当调用之间**存在依赖**时才逐个进行。" +
        "预算用尽后工具调用将被禁用，你必须立即收尾总结（说明已完成/未完成/下一步命令），发出应答并停止工作。" +
        "本轮实时进度由系统每步通过 [本步指引] 提供（专用字段 STEPS_USED/STEPS_REMAIN/TOOLS_USED/ELAPSED_SEC），请引用其数值。",
    };
  }
  return {
    name: "step-budget",
    text:
      `[Per-turn thinking budget rule]: Each turn (one user message) has a thinking-step budget of ${limit} steps. Plan your work to finish within it. ` +
      "Do your best to achieve the best outcome in the FEWEST steps — be efficient and save tokens. " +
      "Efficiency guidance: before acting, briefly state your plan and estimated steps in your reply text (costs no tool steps) and follow it to avoid detours; " +
      "when you need several pieces of information, issue MULTIPLE tool calls in a single reply " +
      "(parallel batch collection), then analyze once all results are back; go step-by-step only when calls DEPEND on each other. " +
      "When the budget is exhausted, tool calls are disabled and you must wrap up immediately: deliver a concise final answer " +
      "(accomplished / unfinished / next command), and then stop working immediately. " +
      "Real-time progress is provided each step via [Step guide] (named fields STEPS_USED/STEPS_REMAIN/TOOLS_USED/ELAPSED_SEC); quote those values.",
  };
}

function wrapUpReportSection() {
  if (UI_LANG === "zh") {
    return {
      name: "wrap-up-report",
      text:
        "【收尾报告规则】（**强制，非可选项**）：每轮对话（对应用户的一次输入）的最终答复的**第一行**必须以如下格式开头：" +
        "`⏱ 本轮统计：STEPS_USED 步思考 / TOOLS_USED 次工具调用 / 耗时 ELAPSED_SEC 秒`" +
        "——**STEPS_USED / TOOLS_USED / ELAPSED_SEC 取本步 [本步指引] 中同名专用字段的值**；" +
        "如果你本步还进行了工具调用，则 TOOLS_USED 还必须加上你本步调用工具的次数，" +
        "ELAPSED_SEC 必须加上你本步的耗时，随后再写总结正文（已完成/未完成/下一步命令）。",
    };
  }
  return {
    name: "wrap-up-report",
    text:
      "[Wrap-up report rule] (MANDATORY, not optional): Per turn (one user input) your final answer's FIRST LINE must open with " +
      "`⏱ Stats this turn: STEPS_USED steps / TOOLS_USED tool calls / ELAPSED_SECs elapsed`" +
      " — STEPS_USED / TOOLS_USED / ELAPSED_SEC are the values of the SAME NAMED FIELDS in THIS step's " +
      "[Step guide]; if you issue additional tool calls in this step, ADD them to TOOLS_USED and ADD this " +
      "step's elapsed time to ELAPSED_SEC, then write the summary body (accomplished / unfinished / next command).",
  };
}

/**
 * 每轮首步注入的 `[本轮指引]` 消息文本（pre-step 注入 → prompt 末尾/历史区，
 * 模型全程可见、前缀缓存稳定命中；**不进系统提示**——KV 缓存纪律）。
 * 内容：仅**动态**绩效参考（静态预算/效率规则已移入系统提示 stepBudgetSection）；
 * 前缀 `[本轮指引]`/`[Round guide]` 供前端过滤。
 */
function roundGuideText(perfNoteText) {
  if (UI_LANG === "zh") {
    return `[本轮指引] 必须严格遵守【语言规则】、【工具调用边界规则】、【每轮对话思考预算规则】和【收尾报告规则】。` +
      ` ${ perfNoteText || "本轮请以最少步数高效完成任务。" }`;
  }
  return `[Round guide] Must strictly comply with the [Language rule], [Tool-use boundary rule], ` +
    `[Per-turn thinking budget rule], and [Wrap-up report rule]. ` +
    `${ perfNoteText || "Complete this round efficiently in as few steps as possible." }`;
}

/**
 * 每步注入的 `[本步指引]` 消息文本——**只传动态数据**（执法），规则已立法在
 * 系统提示（stepBudgetSection / wrapUpReportSection）。**专用字段名**（大写+
 * 下划线，不易与其他消息混淆）与立法同名呼应：STEPS_USED / STEPS_REMAIN /
 * TOOLS_USED / ELAPSED_SEC。收尾报告引用同名专用字段值。
 */
function stepGuideText(limit, steps, tools, elapsed) {
  const remaining = Math.max(0, limit - steps);
  if (UI_LANG === "zh") {
    return `[本步指引] STEPS_USED=${steps} / STEPS_REMAIN=${remaining} / TOOLS_USED=${tools} / ELAPSED_SEC=${elapsed}`;
  }
  return `[Step guide] STEPS_USED=${steps} / STEPS_REMAIN=${remaining} / TOOLS_USED=${tools} / ELAPSED_SEC=${elapsed}`;
}

/** 工具拦截拒绝文案（tools/pre-execute deny reason，与 UI 语言一致）。 */
function stepLimitDenyReason(count, limit) {
  return UI_LANG === "zh"
    ? `工具调用已禁用——本轮已达思考步数上限（${count}/${limit}）。请立即停止工作并给出最终答复。`
    : `Tool calls are disabled — this turn reached its step limit (${count}/${limit}). Stop working and deliver your final summary now.`;
}

/**
 * 达限警示消息（agent/pre-step 注入的 user 消息，超限后下一步必达）：
 * 对话末尾的 user 消息是模型必须处理的输入，必然引起响应——软性收尾的强
 * 注入点。内容：阈值与当前值、原因（工具已禁用）、**数字直拼的收尾报告
 * 首行格式**（X/Y/Z 直接用系统数据，无需模型查找引用）、要求的动作。
 * 前缀 `[达限警示]`/`[Limit warning]` 为系统指令标识（前端据此过滤不显示）。
 * 注意：纯提示词对模型的约束力有限（实测模型可能继续执行），真正的收尾
 * 保障是 tools/pre-execute 工具拦截（见 attachAgent）。
 */
function stepLimitWrapUpMessage(limit, steps, tools, elapsedSec) {
  if (UI_LANG === "zh") {
    return (
      `[达限警示] 本轮思考步数已达上限（${steps}/${limit}），已发起 ${tools} 次工具调用，本轮耗时 ${elapsedSec} 秒，` +
      "所有工具调用已被禁用。单轮步数上限用于控制单次请求规模、防止工具循环失控，因此本轮工作到此为止。" +
      "请立即停止进一步推理，在本回复中给出最终答复，**第一行**必须以如下格式开头：" +
      "`⏱ 本轮统计：STEPS_USED 步思考 / TOOLS_USED 次工具调用 / 耗时 ELAPSED_SEC 秒`" +
      `（其中 STEPS_USED=${steps}、TOOLS_USED=${tools}、ELAPSED_SEC=${elapsedSec}，若本答复中还有新的工具调用和耗时请一并计入），` +
      "随后写总结正文（已完成/未完成/下一步命令）。" +
      "请务必严格遵守此规则！预算已耗尽，完成收尾总结后务必立即停止工作！"
    );
  }
  return (
    `[Limit warning] This turn's step limit is reached: ${steps}/${limit} steps used, ${tools} tool calls issued, ` +
    `${elapsedSec}s elapsed — the thinking budget is exhausted and all tool calls are now disabled. ` +
    "The per-turn step limit keeps each request bounded and prevents runaway tool loops, so continuing further work is not permitted. " +
    "Stop further reasoning and deliver your final answer in this reply, opening with a first line in this exact format: " +
    "`⏱ Stats this turn: STEPS_USED steps / TOOLS_USED tool calls / ELAPSED_SECs elapsed`" +
    ` (STEPS_USED=${steps}, TOOLS_USED=${tools}, ELAPSED_SEC=${elapsedSec}; count any NEW tool calls and time used in this reply too), ` +
    "then the summary body (accomplished / unfinished / next command). " +
    "Please strictly comply with this rule! Stop working immediately after deliver this response!"
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

  // 【0.1.5 兼容｜2026-09】会话事件访问统一走模块级 sessionEventsOf()（见会话工具
  // 函数区）——新版 Session 不再公开 events 属性、且实例可能不可扩展，defineProperty
  // 注入不可靠；统计落盘 / 历史重放 / 预览 / 轮转摘要等读取点均已改为显式调用。

  // 会话日志大小：绑定到本 agent 的局部闭包。main 作用域闭包在 flush 时
  // 可能读到 undefined（曾导致 events 帧从不携带 sessionBytes，标题栏大小
  // 标签常态不显示）；此处 agent 是本函数局部变量，闭包求值必然可靠。
  pump.sizeProvider = () =>
    agent === undefined || agent.session === undefined
      ? undefined
      : sessionFileSize(String(agent.session.id));

  // 环境变量直读：非数字或缺失时回退 100；合法值原样保留（0 = 不限制）。
  const maxSteps = Number(process.env.DSH_MAX_STEPS);
  const stepLimit = Number.isFinite(maxSteps) ? maxSteps : 100;
  let stepCount = 0;
  let stepLimitHit = false;
  /** 消息层收尾指令是否已注入（每轮最多注入一次，避免刷屏）。 */
  let wrapUpInjected = false;
  /** 每轮首步 [本轮指引] 是否已注入（每轮一次，pre-step 末尾消息；不进系统提示）。 */
  let roundGuideInjected = false;
  /** 本轮实际执行的工具调用次数（收尾报告用；tools/pre-execute 允许时计数）。 */
  let toolCallCount = 0;
  /** 本轮开始时间（耗时统计；resetStepBudget 时刷新）。 */
  let turnStartAt = Date.now();
  /** 本轮已耗时（秒）。 */
  const elapsedSec = () => Math.round((Date.now() - turnStartAt) / 1000);
  /**
   * 无状态激励的宿主代理记忆：最近几轮的实际绩效（步数/工具次数/是否达限），
   * 注入下一轮系统提示作为"绩效参考"，让模型当轮就知道历史表现、
   * 延续高效模式（批量工具调用等）、改进低效模式。
   * 持久化到 session-meta（meta[sid].perf，杠杆3）：跨宿主重启保留，跨会话
   * 延续"效率人设"；进程内仅作内存缓存，每轮结束落盘。
   */
  const PERF_KEEP = 5;
  const PERF_META_KEY = "perf";
  let perfQueue = []; // {steps, tools, hitLimit}
  try {
    const saved = getSessionMeta(agent.session.id)[PERF_META_KEY];
    if (Array.isArray(saved)) perfQueue = saved.slice(-PERF_KEEP);
  } catch {
    perfQueue = [];
  }
  /** 组装绩效参考文案（最近 PERF_KEEP 轮；无记录返回空串）。
   *  杠杆1（行为归因）：同时报步数与工具次数——tools > steps 即"一步多调用"，
   *  标注"（含并发批量）"让模型看到上轮**为什么**快，而不仅是"用了几步"。 */
  const perfNote = () => {
    if (perfQueue.length === 0) return "";
    const rows = perfQueue.map((p, i) => {
      const tools = p.tools ?? 0; // 兼容旧持久化格式 {steps, hitLimit}（无 tools 字段）
      const batchHint = tools > p.steps ? (UI_LANG === "zh" ? "（含并发批量）" : " (with parallel batching)") : "";
      return UI_LANG === "zh"
        ? `第${i + 1}轮用了 ${p.steps} 步 / ${tools} 次工具调用${batchHint}${p.hitLimit ? "（达限未完成）" : "（预算内完成）"}`
        : `Round ${i + 1}: ${p.steps} steps / ${tools} tool calls${batchHint}${p.hitLimit ? " (hit limit, unfinished)" : " (finished within budget)"}`;
    });
    return UI_LANG === "zh"
      ? `绩效参考：你最近完成的轮次：${rows.join("；")}。高效模式通常包括：一步内并发多个工具调用、减少重复搜索与冗余操作、先规划再动手（简述计划与预估步数）。请延续高效模式，在本轮预算内以最少步数圆满完成任务。`
      : `Performance reference: recent rounds: ${rows.join("; ")}. Efficient patterns usually include: batching multiple tool calls in one step, avoiding repeated searches and redundant operations, and planning before acting (state your plan and estimated steps). Keep the efficient patterns and complete this round within budget in as few steps as possible.`;
  };
  /** 上次打印过的实际思考级别（仅在变化时打印，避免每步刷屏）。 */
  let lastLoggedEffort;

  /** 新一轮用户消息开始时调用：重置本轮步数预算（stepLimit 是单轮上限）。 */
  const resetStepBudget = () => {
    // 先记录上一轮绩效（无状态激励的宿主代理记忆）：清零前读旧值入队；
    // **stepCount > 0 才记录**（0 步空轮——首条消息前的重置——不算完成一轮）
    if (stepLimit > 0 && stepCount > 0) {
      perfQueue.push({ steps: stepCount, tools: toolCallCount, hitLimit: stepLimitHit });
      if (perfQueue.length > PERF_KEEP) perfQueue.shift();
      // 杠杆3：每轮结束落盘到 session-meta，跨重启/跨会话延续绩效参考。
      // 清理纪律：内存 perfQueue 已截断到 PERF_KEEP；落盘前再强制
      // slice(-PERF_KEEP) 防御（坏数据/未来 bug 不污染 meta）；会话删除时
      // removeSessionMeta 整体清除 meta[sid]（含 perf），无孤儿条目。
      // 因此 perf 不随对话次数增长（每会话恒 ≤5 条），meta 条目数只随
      // 会话数线性（每会话一条，属正常元数据，删除即清）。
      updateSessionMeta(agent.session.id, { [PERF_META_KEY]: [...perfQueue].slice(-PERF_KEEP) });
    }
    stepCount = 0;
    stepLimitHit = false;
    wrapUpInjected = false;
    roundGuideInjected = false;
    toolCallCount = 0;
    turnStartAt = Date.now();
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
    // 内核标题同步：DSH 生成/更新会话标题（首条消息 fallback 截断或 LLM 总结
    // provider，source=fallback/provider）时，同步写插件 meta.title——会话列表
    // 与面板标题栏统一用内核标题，覆盖创建时的静态临时标题（newsession_...）。
    // 用户显式重命名会 pin 内核标题（session/title source=user，后续自动生成
    // 被内核 supersede），此处只回写同名值，幂等，不会覆盖用户自定义名。
    if (
      event.type === "session/title" &&
      event.data &&
      typeof event.data.title === "string" &&
      event.data.title.trim() !== ""
    ) {
      try {
        const title = event.data.title.trim();
        updateSessionMeta(agent.session.id, { title });
        invalidateSessionsCache(); // 列表标题变更，下次读取即新值
        post({ t: "sessionTitleSynced", id: agent.session.id, title });
      } catch (error) {
        log("warn", "session title sync to meta failed", error instanceof Error ? error.message : String(error));
      }
    }
    pump.push(event);
  });

  /**
   * 【0.1.5 兼容｜实时流桥接】把新版"临时流帧"重新包装成旧版 `assistant/chunk`
   * 会话事件推给扩展，从而**不改动**扩展/前端的流式渲染链路（translateEvent 的
   * assistant/chunk → assistant-delta → 节流 markdown 渲染）。
   *
   * 背景：≤0.1.1 内核把每个 token 增量作为会话事件 `assistant/chunk` 落日志（体积
   * 巨大，v0 日志因此膨胀到 4.9MB/31 万事件）；0.1.5 改为**进程内临时帧**
   * `agent/assistant-stream`（见 dsh-agent-loop 的 AssistantStreamAttempt），
   * 只把压缩后的 stream 存进 `assistant/message`，不再产生 chunk 会话事件。
   *
   * 若不桥接：面板在整个模型输出期间**完全没有增量**（表现为"反应明显变慢、
   * 输出迟迟不出现"），且每条 assistant/message 会被当成"已流式渲染过"处理，
   * 导致一轮里第一条之后的正文（含最后的总结报告）被丢弃。
   *
   * 帧形状（0.1.5）：start{attemptId,revision,turn,step} / chunk{...,index,time,chunk}
   * / end{...,outcome}。这里只转发 chunk，并补回 start 携带的 turn/step（chunk 帧
   * 本身不含），包装成 {type:"assistant/chunk", data:{turn, step, chunk}}。
   * 旧内核对 `agent/assistant-stream` 从不 emit → 本监听器天然不触发，无副作用。
   */
  let streamTurn;
  let streamStep;
  agent.ctx.on("agent/assistant-stream", (payload) => {
    try {
      const subject = payload?.agent;
      if (subject !== undefined && subject !== agent) return; // 仅本 agent 的流
      const frame = payload?.frame;
      if (frame === undefined || frame === null) return;
      if (frame.type === "start") {
        streamTurn = frame.turn;
        streamStep = frame.step;
        return;
      }
      if (frame.type !== "chunk") return; // end（含 abandoned）不渲染
      if (streamTurn === undefined) return; // 未收到 start：无可归属轮次，丢弃
      pump.push({
        type: "assistant/chunk",
        seq: frame.index ?? 0,
        time: frame.time ?? Date.now(),
        data: { turn: streamTurn, step: streamStep, chunk: frame.chunk },
      });
    } catch (error) {
      log("warn", "assistant stream bridge failed", error instanceof Error ? error.message : String(error));
    }
  });

  // **统计与日志强同步落盘**（owner 反复强调：日志落盘时统计同步落盘，保证
  // 一致性）。内核 `session/flush` 是持久化检查点（日志落盘边界）——在此把
  // 统计写 meta.stats：以 meta 中上次落盘的 stats 为基准，对日志**增量补算**
  // （computeSessionStats base，只算 seq > lastSeq 的新事件——基于日志权威
  // 事件、纯函数，无事件流累加 bug），覆盖落盘。崩溃/重启后恢复直读 meta.stats
  // 即与日志一致；resolveSessionStats 的滞后补算仅兜底未 flush 的极小窗口。
  agent.ctx.on("session/flush", () => {
    try {
      const sid = agent.session.id;
      const meta = loadSessionMeta();
      const prev = meta[sid]?.stats;
      const base = prev && Number.isFinite(prev.lastSeq) ? prev : undefined;
      // 【性能】只取 base.lastSeq 之后的新增段（seq 从 1 连续）——原实现对 30 万
      // 事件级长会话每次 flush 都要全量拷贝 + filter + 逐条跳过，是 O(n) 拷贝与
      // 扫描；flush 是内核高频持久化检查点，长会话下会明显拖慢每次交互。
      // 同时必须保留 chunk/end-seed 过滤（chunk 不参与统计且体积最大）。
      const delta = sessionEventsSince(agent.session, base === undefined ? 0 : base.lastSeq + 1).filter(
        (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
      );
      if (delta.length === 0) return; // 无新增（纯 chunk/心跳 flush）→ 无需落盘
      const stats = computeSessionStats(delta, base);
      meta[sid] = { ...(meta[sid] ?? {}), stats: { ...stats } };
      saveSessionMeta(meta);
    } catch (error) {
      log("warn", "session stats flush failed", error instanceof Error ? error.message : String(error));
    }
  });

  // 统计方案（docs 2.27）：恢复/查看走 resolveSessionStats——meta.stats 直读
  // （合理则用，零遍历）；meta 无 stats（旧会话/机制转换）或异常（转换期坏值）
  // 则**全量算一次并落盘**（新旧机制平稳转换，之后直读）。压缩只推占比不落盘。

  // 收尾引导（系统提示层）：**从一开始就注入**（每轮系统提示均携带单轮预算
  // 约束，让模型预先知晓并规划节奏）；达到上限后提示词继续存在于系统提示，
  // 直到本轮自然结束。stepLimit = 0 时不注入。
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const sections = [...(assembled.sections ?? [])];
    // 语言一致性指令：每轮注入（思考/输出语言跟随界面语言，见 languageDirectiveSection）
    sections.push(languageDirectiveSection());
    // 工具调用边界规则：每轮注入（推理必需 vs 替用户完成，见 toolBoundarySection）
    sections.push(toolBoundarySection());
    // 单轮预算静态规则（总预算 + 效率引导；limit 进程内常量，静态安全——KV 缓存纪律）
    if (stepLimit > 0) sections.push(stepBudgetSection(stepLimit));
    // 收尾报告规则：独立 section（**静态文本**——系统提示禁止动态内容；动态数值
    // 由 [本步指引] 每步提供，规则引用其数值）
    sections.push(wrapUpReportSection());
    return { ...assembled, sections };
  });

  // 系统指令注入（对话消息层，pre-step）：三类系统指令消息——均注入 prompt
  // **末尾**（历史区），前缀稳定命中 KV 缓存；消息会写入会话历史（模型全程
  // 可见），前端据前缀**过滤不显示**（见 chat.js isSystemDirective）。
  //  - [本轮指引]：每轮首步一次（总预算 + 效率引导 + 绩效参考）；
  //  - [本步指引]：每步一次（动态剩余预算/工具次数/耗时，尽快完成）；
  //  - [达限警示]：达限后一次（收尾指令 + 数字直拼收尾报告首行）。
  // 注意：agent/request 瀑布改 messages 无效（dsh-agent-loop buildRequest 只
  // 消费 provider/model/effort 等配置字段，request.messages 由外部组装）——
  // 消息层注入只能走 agent/pre-step 的 decision.messages（探针已实证可行）。
  agent.ctx.on("agent/pre-step", async (_payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    let messages = decision.messages ?? [];
    let changed = false;
    const add = (text) => {
      // 必须用 createUserMessage 构造（含 id/source 身份字段）——内核处理
      // user/message 事件会读 message.source.kind，裸对象会崩溃
      // （"Cannot read properties of undefined (reading 'kind')"）。
      messages = [...messages, createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })];
      changed = true;
    };
    // 达限：注入 [达限警示]（每轮一次），此后不再注入指引
    if (stepLimit > 0 && stepLimitHit && !wrapUpInjected) {
      wrapUpInjected = true;
      add(stepLimitWrapUpMessage(stepLimit, stepCount, toolCallCount, elapsedSec()));
      return { ...decision, messages };
    }
    // 每轮首步：先注入 [重申纪律]（引用并重申定制品格/学习经验的规定标签，
    // 位置在 [本轮指引] 之前——前呼后应的"后应"层，拉回模型对系统提示规则的
    // 注意力），再注入 [本轮指引]（预算 + 效率 + 绩效）。
    if (!roundGuideInjected) {
      roundGuideInjected = true;
      if (reiterationText) {
        add(`${UI_LANG === "zh" ? "[重申纪律]" : "[Reiterate rules]"}\n${reiterationText}`);
      }
      add(roundGuideText(perfNote()));
    }
    // 每步：注入 [本步指引]（动态剩余，尽快完成）
    if (stepLimit > 0) {
      add(stepGuideText(stepLimit, stepCount, toolCallCount, elapsedSec()));
    }
    return changed ? { ...decision, messages } : decision;
  });

  // 工具拦截（软性强制收尾的核心保障）：超限后（stepLimitHit），所有工具调用
  // 在 tools/pre-execute 门禁处被拒绝——工具不执行，模型收到
  // "Error: Tool calls are disabled — this turn reached its step limit (N/M)…"，
  // 无法再执行任何工具，只能总结收尾。与硬终止（agent.cancel）不同：会话、
  // 历史、后续对话完全不受影响，仅当前轮的工具执行被禁止——即使提示词被
  // 模型忽视，工具拦截也保证收尾必然发生。scope 向上流动，主 agent 超限时
  // 子代理的工具同样被禁（整轮收尾，符合预期）。
  agent.ctx.on("tools/pre-execute", async (exec, next) => {
    // 命令级规则的**前提**：只对"被命令级规则覆盖的工具"记录本次调用参数（按需，绝不逐个
    // 工具一刀切；其余工具连一次序列化都没有）。approval 阶段用 callId 取回这份参数。
    if (exec && typeof exec.name === "string" && exec.callId !== undefined && toolNeedsApprovalArgs(exec.name)) {
      if (pendingApprovalArgs.size >= APPROVE_ARG_CALLID_LIMIT) {
        const oldest = pendingApprovalArgs.keys().next().value;
        if (oldest !== undefined) pendingApprovalArgs.delete(oldest);
      }
      pendingApprovalArgs.set(exec.callId, exec.arguments);
    }
    const gate = await next();
    // 工具调用总次数统计（收尾报告用）：实际允许执行的才算一次
    if (gate.kind === "allow") toolCallCount++;
    // 黑名单（deny）在准入阶段直接拒绝：工具级与命令级都生效
    // （白名单 allow 不在此处理——它只在 approval 授权越界升级）
    if (exec && typeof exec.name === "string") {
      const rule = findAutoApproveRule(exec.name, exec.callId);
      if (rule && rule.action === "deny") {
        log("info", `auto-deny ${exec.name} at pre-execute (${ruleLabel(rule)})`);
        return { kind: "deny", reason: autoApproveDenyReason(exec.name) };
      }
    }
    if (stepLimit > 0 && stepLimitHit && gate.kind === "allow") {
      return {
        kind: "deny",
        reason: stepLimitDenyReason(stepCount, stepLimit),
      };
    }
    return gate;
  });

  // 参数表清理：结果返回后不再需要（tools/result 是只读观察事件）。
  agent.ctx.on("tools/result", (exec) => {
    if (exec && exec.callId !== undefined) pendingApprovalArgs.delete(exec.callId);
  });

  // 思考级别实际值追踪 + 参数自动适配：agent/request 是每次模型请求配置的**唯一**入口
  // （dsh-agent-loop buildRequest 由此消费 provider/model/reasoningEffort），
  // 应答/usage 不回显 effort（dsh-llm-deepseek 类型仅有请求侧定义），因此
  // 此处日志即"AI 实际使用的思考级别"。仅在变化、或用户刚切换思考级别
  // （userEffortChanged）时打印，避免每步刷屏。
  // 参数适配：请求的 effort 若不被该模型支持，自动降级到最接近的兼容档位
  // （或剔除参数走模型默认），绝不因参数不支持中断任务——适配动作记日志、
  // 状态栏提示（modelAdapted 帧），随后继续工作。
  // 性能：适配结果按 `provider|model|effort` 组合缓存，每个组合仅首次请求
  // 做一次能力查询+校正，之后每次请求只是查缓存键直接套用，无任何重复开销。
  // 注意：**必须 prepend**。Cordis waterfall 的监听器按注册顺序组成洋葱——
  // 先注册的在最外层、最后处理返回值。installModelSelection（内核，在
  // agents.create 的 setup 里注册）每次请求都会把 selection.reasoningEffort
  // 无条件写回 request；若不 prepend，本钩子剔除/降级 effort 后会被它在外层
  // 覆盖（实测 ollama 仍报 UNSUPPORTED_REASONING_EFFORT）。prepend 后本钩子
  // 成为最外层：先 await next() 拿到 installModelSelection 应用后的完整配置，
  // 再做适配，最终返回值即适配结果。
  agent.ctx.on(
    "agent/request",
    async (_payload, next) => {
      let request = await next();
      if (request && request.provider && request.model && request.reasoningEffort) {
        const cacheKey = `${request.provider}|${request.model}|${request.reasoningEffort}`;
        // 诊断日志：cacheHit=false 表示该 provider/model/effort 组合**首次**遇到
        // （本轮将查询模型能力并做一次适配，结果记入 effortAdaptedCache）；
        // 之后的相同组合 cacheHit=true，直接复用适配结果，不再查询/校正。
        const cacheHit = effortAdaptedCache.has(cacheKey);
        // 诊断日志：仅首次遇到（cacheHit=false）打印——将查询能力并适配一次；
        // 命中（cacheHit=true）静默复用，避免每步刷屏。
        if (!cacheHit) {
          if (DEBUG_ADAPT) log("debug", `[adapt] ${request.provider}/${request.model} effort=${request.reasoningEffort} cacheHit=false`);
        }
        if (cacheHit) {
          // 该组合已适配过：直接套用记忆的最终档位（undefined = 剔除，走模型默认）。
          // request 是内核深冻结对象，不能就地改——applyEffort 解构重建，靠瀑布返回值生效。
          const cached = effortAdaptedCache.get(cacheKey);
          if (cached !== request.reasoningEffort) request = applyEffort(request, cached);
        } else {
          // 首次遇到该组合：查询模型真实能力（能力本身也有缓存）并做一次适配
          try {
            const llm = ctx.get("llm");
            if (llm !== undefined && typeof llm.resolveModelInfo === "function") {
              const capKey = `${request.provider}|${request.model}`;
              let supported = effortCapabilityCache.get(capKey);
              if (supported === undefined) {
                const info = await llm.resolveModelInfo(request.provider, request.model);
                supported = (info?.reasoning?.efforts ?? []).map((e) => (typeof e === "string" ? e : e?.id)).filter(Boolean);
                effortCapabilityCache.set(capKey, supported);
                if (DEBUG_ADAPT) log("debug", `[adapt] capability ${capKey} → supported=[${supported.join(", ")}]`);
              }
              const from = request.reasoningEffort;
              const { value, adapted } = adaptEffort(from, supported);
              effortAdaptedCache.set(cacheKey, value); // 记住该组合的最终档位（含 undefined = 剔除）
              if (adapted) {
                request = applyEffort(request, value);
                log(
                  "info",
                  L(
                    `思考级别按语义强度映射：${request.provider}/${request.model} ${from} → ${
                      value === undefined ? "不传（模型默认）" : value
                    }`,
                    `effort mapped by semantic strength: ${request.provider}/${request.model} ${from} → ${
                      value === undefined ? "(omit, model default)" : value
                    }`
                  )
                );
                // 状态栏提示（扩展侧显示为温和提示，不打断对话）
                post({
                  t: "modelAdapted",
                  provider: request.provider,
                  model: request.model,
                  from,
                  to: value ?? "",
                });
              }
            }
          } catch (error) {
            // 能力查询失败：不能静默透传原参数（模型可能根本不支持该档位 → 内核
            // 抛 UNSUPPORTED_* 中断任务）。保守剔除 effort（走模型默认），并记日志；
            // **把剔除结果也写入适配缓存**（该组合后续请求直接复用，不再重复失败
            // 查询与重复提示；配置变更时缓存会被清空重新适配）。
            log(
              "warn",
              L(
                `参数适配：无法查询模型 ${request.provider}/${request.model} 的思考级别能力，已移除思考级别参数（走模型默认）`,
                `param adapt: cannot probe effort capability of model ${request.provider}/${request.model}; removed effort (model default)`
              )
            );
            const from = request.reasoningEffort;
            request = applyEffort(request, undefined);
            effortAdaptedCache.set(cacheKey, undefined); // 记住该组合 = 剔除
            // 状态栏温和提示（不打断对话）
            post({ t: "modelAdapted", provider: request.provider, model: request.model, from, to: "" });
          }
        }
      }
      const actual = request?.reasoningEffort;
    if (actual !== lastLoggedEffort || userEffortChanged) {
      lastLoggedEffort = actual;
      userEffortChanged = false;
      log("info", L(`AI 实际思考级别: ${actual ?? "（未指定）"}`, `AI actual reasoning effort: ${actual ?? "(unset)"}`));
    }
    return request;
  },
    // prepend：见上方注释——必须排在内核 installModelSelection 之前（外层）
    { prepend: true }
  );
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

  // 用户自定义系统提示词 + 自动学习经验（DSH home 固定文件，跨项目共享）。
  // **agent 启动时快照一次，本 agent 生命周期内保持稳定**——频繁变化的系统
  // 提示词会使模型 KV 缓存前缀失效，每次变化都是费用灾难。新内容在宿主重启
  // （配置面板"保存并应用"）或新建会话（agent 重建 → 重新快照）后生效。
  // "启用定制"/"启用经验"开关（DSH_ENABLE_CUSTOM / DSH_ENABLE_LEARNING=0 关闭）
  // 关闭时即使文件有内容也不加载。
  const enableCustom = envFlag("DSH_ENABLE_CUSTOM");
  const enableLearning = envFlag("DSH_ENABLE_LEARNING");
  const enableReiteration = envFlag("DSH_ENABLE_REITERATION");
  const customPrompt = enableCustom ? readTextFile(CUSTOM_PROMPT_FILE) : "";
  const learningText = enableLearning ? readTextFile(LEARNING_FILE) : "";
  // [重申纪律]（"每轮重申指令"，2026-09 owner 定）：每轮首条系统消息（位于
  // [本轮指引] 之前）引用并重申"用户定制品格 / 自动学习经验"中的规定标签——
  // 前呼后应的"后应"强调层，把模型注意力拉回系统提示中的规则全文，强化长会话
  // 中的规则遵循权重。agent 启动快照一次保持稳定（内容/开关变化在宿主重启或
  // 新建会话后生效）；文件为空时不注入；开关 DSH_ENABLE_REITERATION=0 关闭。
  const reiterationText = enableReiteration ? readTextFile(REITERATION_FILE) : "";
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const sections = [...(assembled.sections ?? [])];
    // 0.1.5 起"用户定制"由 system-prompt 行的 personaSuffix 承载（见上方 overlay 构造）：
    // 已由后缀注入时不再重复追加动态 section；旧内核仍走此处的 section 注入。
    const customHandledByPersonaSuffix = DSH_PERSONA_PREFIX_SUPPORTED && customPrompt !== "";
    if (customPrompt && !customHandledByPersonaSuffix) sections.push({ name: "user-custom-prompt", text: customPrompt });
    if (learningText) sections.push({ name: "user-learning", text: `以下是从既往对话沉淀的工作经验，请自觉遵守：\n${learningText}` });
    if (sections.length === (assembled.sections ?? []).length) return assembled;
    return { ...assembled, sections };
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
/** 自动授权规则（白名单 / 黑名单）。
 *  结构：{ match: 工具名(支持 "*" 通配), commands?: 前缀列表, action: "allow" | "deny" }
 *  · `commands` 省略 = **工具级**规则；给出 = **命令级**规则（对命令类工具 bash/pwsh 有意义）：
 *    语义是**前缀匹配**（命令以该前缀开头即命中）。允许在末尾写 `*` 作记号（解析时去掉，
 *    与不写完全等价）；**拒绝中间/开头的 `*`**——不提供完整 glob，避免 `*rm*` 之类误放行。
 *  · deny  → 在 tools/pre-execute 阶段直接拒绝（工具级 / 命令级都生效）；
 *  · allow → 在 approval/request 阶段自动放行（= 越界升级重试不再弹框）；
 *  · 未命中 / 无参数 / 无 callId → 继续弹框（fail-safe）。
 *  **复合命令保护**：命令含 && || ; | > < 反引号 $( 时，allow 规则一律不命中
 *  （`git status && rm -rf /` 不会因前缀 `git status` 被放行），仍走弹框；deny 不受此限。
 *  默认空表 = 一切走内核默认（write/edit/bash/pwsh 越界升级时弹框）。
 *  注意：approval 请求不带参数（subsystems/approval.md："deliberately omits tool arguments"），
 *  参数靠 callId 关联 pre-execute 记录的调用参数——内核设计意图即如此。 */

/** 命令含这些 shell 组合符时，白名单不放行（交人工审批）。 */
const SHELL_COMPOSITE_RE = /(&&|\|\||;|\||>|<|`|\$\()/;
/** 单条前缀长度上限（防御性）。 */
const COMMAND_PREFIX_MAX = 200;

/** 工具名匹配：字面量，或仅含 `*` 的简单通配（其余字符一律转义，不引入正则元字符）。 */
function toolNameMatches(pattern, toolName) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === toolName;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(toolName);
  } catch {
    return false;
  }
}

/** 归一化一条命令前缀：去空白；只允许末尾一个 `*`；其余位置的 `*` = 非法（丢弃该条）。
 *  复合命令门禁：含 shell 元字符（&& || ; | > < 反引号 $(）的前缀一律丢弃——
 *  与 UI 文案 permissionCommandNote、前端 config-panel.js、后端 configPanel.ts 三方一致。 */
function normalizeCommandPrefix(raw) {
  const text = String(raw ?? "").trim();
  if (text === "" || text.length > COMMAND_PREFIX_MAX) return undefined;
  if (SHELL_COMPOSITE_RE.test(text)) return undefined;
  const body = text.endsWith("*") ? text.slice(0, -1) : text;
  if (body === "" || body.includes("*")) return undefined;
  return body;
}

/** 规则归一化（host 侧兜底：非法条目丢弃并告警；UI 保存时另有正式校验）。 */
function normalizeAutoApproveRules(input) {
  const out = [];
  for (const r of Array.isArray(input) ? input : []) {
    const action = r?.action === "deny" ? "deny" : r?.action === "allow" ? "allow" : undefined;
    if (action === undefined) continue; // "ask" 或不认识的值 = 不配置
    const match = String(r?.match ?? "").trim();
    if (match === "") continue;
    const rule = { match, action };
    if (Array.isArray(r?.commands) && r.commands.length > 0) {
      const prefixes = [];
      for (const c of r.commands) {
        const p = normalizeCommandPrefix(c);
        if (p === undefined) {
          log("warn", `auto-approve rule: illegal command prefix dropped: ${JSON.stringify(c)} (rule ${match})`);
          continue;
        }
        if (!prefixes.includes(p)) prefixes.push(p);
      }
      // 声明了命令但全部非法 → **丢弃整条规则**，绝不降级为工具级：
      // 那会把"允许某条命令"放大成"允许该工具的全部命令"（安全放大）。
      if (prefixes.length === 0) {
        log("warn", `auto-approve rule dropped: no legal command prefix (rule ${match})`);
        continue;
      }
      rule.commands = prefixes;
    }
    out.push(rule);
  }
  return out;
}

function loadAutoApproveRules() {
  try {
    const raw = process.env.DSH_AUTO_APPROVE;
    if (!raw) return [];
    return normalizeAutoApproveRules(JSON.parse(raw));
  } catch (error) {
    log("warn", "auto-approve rules unreadable; falling back to an empty table", error instanceof Error ? error.message : String(error));
    return [];
  }
}
const autoApproveRules = loadAutoApproveRules();

/** 该工具是否需要记录参数：只有**命令级**规则覆盖的工具才记录；其余工具调用零开销。 */
function toolNeedsApprovalArgs(toolName) {
  return autoApproveRules.some((r) => r.commands !== undefined && toolNameMatches(r.match, toolName));
}

/** callId → 工具参数（对象引用，不做 JSON 序列化）；结果返回即清理，另有条数上限兜底。 */
const pendingApprovalArgs = new Map();
const APPROVE_ARG_CALLID_LIMIT = 512;

/** 取该调用的命令文本（命令类工具的 `command` 参数，见内核 tool-catalog）。 */
function commandOfArgs(args) {
  if (args === null || typeof args !== "object") return undefined;
  const c = args.command;
  return typeof c === "string" ? c : undefined;
}

/** 规则匹配：工具名命中 +（命令级则）前缀命中；allow 还要过复合命令保护。 */
function ruleMatchesCall(rule, toolName, args) {
  if (!toolNameMatches(rule.match, toolName)) return false;
  if (rule.commands === undefined) return true;
  const command = commandOfArgs(args);
  if (command === undefined) return false;
  if (rule.action === "allow" && SHELL_COMPOSITE_RE.test(command)) return false;
  return rule.commands.some((p) => command.startsWith(p));
}

/** 按规则表顺序取首个命中规则（工具级 / 命令级；命令级需 callId 已关联到参数）。 */
function findAutoApproveRule(toolName, callId) {
  const args = callId !== undefined ? pendingApprovalArgs.get(callId) : undefined;
  for (const r of autoApproveRules) {
    if (r.commands !== undefined && args === undefined) continue; // 命令级规则：无参数不判定
    if (ruleMatchesCall(r, toolName, args)) return r;
  }
  return undefined;
}

/** 规则描述（日志用）。 */
function ruleLabel(rule) {
  return rule.commands === undefined ? "tool-level" : `commands=[${rule.commands.join(", ")}]`;
}

/** deny 文案（模型收到的工具拒绝原因）。 */
function autoApproveDenyReason(toolName) {
  return UI_LANG === "zh"
    ? `工具 ${toolName} 被授权规则拒绝（配置项 dshVscode.autoApproveRules）。`
    : `Tool ${toolName} was denied by an approval rule (dshVscode.autoApproveRules).`;
}

function installApprovalListener(ctx, approvals) {
  ctx.on("approval/request", async (req) => {
    // 规则裁决：工具级直接命中；命令级用 callId 关联 pre-execute 记录的参数（approval 请求
    // 本身不带参数）。命中即应答；未命中继续走瀑布 → 弹框（fail-safe）。
    const rule = findAutoApproveRule(req.toolName, req.callId);
    if (rule && rule.action === "allow") {
      log("info", `auto-approve ${req.toolName} (${ruleLabel(rule)})`);
      if (req.callId !== undefined) pendingApprovalArgs.delete(req.callId);
      return "allowed-once";
    }
    if (rule && rule.action === "deny") {
      log("info", `auto-deny ${req.toolName} (${ruleLabel(rule)})`);
      if (req.callId !== undefined) pendingApprovalArgs.delete(req.callId);
      return "rejected";
    }
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
/* 会话历史（list / resume / delete / rename / meta）                   */
/* ------------------------------------------------------------------ */

/**
 * 会话附加元数据（标题覆盖 + 模型/思考级别/workMode）持久化。
 *
 * 为什么需要：会话标题与模型参数是"用户意图"的一部分，恢复历史会话时应
 * 还原当时所用的模型/思考级别/工作模式。标题内核有 session/title 事件可写
 * （sessionTitle.rename，需 live session）；模型选择（provider/model/effort）
 * 与 workMode 内核没有会话级持久化 API，故宿主自行落盘一份轻量 JSON：
 *   { [sessionId]: { title?, provider?, model?, reasoningEffort?, workMode? } }
 * 存于 DSH home 的 sessions-ay-dsh/ 下（与会话日志同根，删会话时一并清理）。
 */
const SESSION_META_FILE = "session-meta.json";

function sessionMetaPath() {
  return join(dshHomePath("sessions-ay-dsh"), SESSION_META_FILE);
}

/** 全部会话元数据的内存缓存（session/flush 等热路径不再每次 readFileSync 全量解析）。 */
let sessionMetaCache = null;
let sessionMetaCacheAt = 0;
/** 缓存 TTL：跨实例对 session-meta.json 的并发写（无锁）最多造成 1.5s 的标题/统计陈旧。 */
const SESSION_META_CACHE_TTL = 1500;

/** 读取全部会话元数据（无文件/损坏时返回空对象，不抛错）。 */
function loadSessionMeta() {
  const now = Date.now();
  if (sessionMetaCache !== null && now - sessionMetaCacheAt < SESSION_META_CACHE_TTL) return sessionMetaCache;
  try {
    const raw = readFileSync(sessionMetaPath(), "utf8");
    const parsed = JSON.parse(raw);
    sessionMetaCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    sessionMetaCache = {};
  }
  sessionMetaCacheAt = now;
  return sessionMetaCache;
}

/** 写入全部会话元数据（原子写：先写临时文件再 rename；同步更新内存缓存）。 */
function saveSessionMeta(meta) {
  sessionMetaCache = meta;
  sessionMetaCacheAt = Date.now();
  try {
    const dir = dirname(sessionMetaPath());
    mkdirSync(dir, { recursive: true });
    const tmp = `${sessionMetaPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
    renameSync(tmp, sessionMetaPath());
  } catch (error) {
    log("warn", "session meta save failed", error instanceof Error ? error.message : String(error));
  }
}

/** 读单个会话元数据。 */
function getSessionMeta(sessionId) {
  return loadSessionMeta()[sessionId] ?? {};
}

/** 合并更新单个会话元数据（保留未提及字段）。 */
function updateSessionMeta(sessionId, patch) {
  if (!sessionId) return;
  const meta = loadSessionMeta();
  meta[sessionId] = { ...(meta[sessionId] ?? {}), ...patch };
  saveSessionMeta(meta);
}

/** 删除单个会话元数据（会话被物理删除时同步清理）。 */
function removeSessionMeta(sessionId) {
  const meta = loadSessionMeta();
  if (sessionId in meta) {
    delete meta[sessionId];
    saveSessionMeta(meta);
  }
}

/** 会话标题：用户显式重命名优先，否则取内核自动标题。 */
async function sessionDisplayTitle(ctx, sessionId, kernelTitle) {
  const meta = getSessionMeta(sessionId);
  if (typeof meta.title === "string" && meta.title.trim() !== "") return meta.title;
  return kernelTitle;
}

/** 会话日志文件名（与 dsh-session-persistence-jsonl 的 logSuffix 一致）。
 *  【0.1.5 兼容】内核引入"多代不可变日志"：同一会话目录可能同时存在
 *  session.jsonl.zstd（v0）与 session.v1/v2/v3.jsonl[.zstd]（v1/v2/v3），
 *  打开时以**最高代**为准。必须识别全部代际并优先取最高代，否则大小/列表
 *  显示的是升级前冻结的旧代文件（曾出现"面板显示 4.2M、实际写入的是 v3 1.5M"）。 */
/** 【0.1.5 兼容】统一的会话事件访问器：
 *  旧内核（≤0.1.1）`session.events` 是数组属性；新内核（≥0.1.5）改为
 *  `snapshotEvents()` / `ownEvents()` 方法（不再公开 events 属性）。
 *  本函数供统计落盘、历史重放、预览、轮转摘要等**全部**读取点使用，
 *  不依赖 Object.defineProperty 注入（Session 实例可能不可扩展）。
 *  250ms TTL 缓存避免长会话被 flush/统计高频读取时反复全量拷贝。 */
const sessionEventsCache = new WeakMap();

/** 会话事件读取策略：统一判定内核版本分支（≤0.1.1 数组 / ≥0.1.5 snapshotEvents /
 *  ownEvents），供 sessionEventsOf 与 sessionEventsSince 共用，避免同一判断双处漂移。 */
function sessionEventReader(session) {
  if (session === undefined || session === null) return null;
  if (Array.isArray(session.events)) return { kind: "array", events: session.events }; // ≤0.1.1
  if (typeof session.snapshotEvents === "function") return { kind: "snapshot" }; // ≥0.1.5
  if (typeof session.ownEvents === "function") return { kind: "own" };
  return null;
}

function sessionEventsOf(session) {
  const reader = sessionEventReader(session);
  if (reader === null) return [];
  if (reader.kind === "array") return reader.events;
  if (reader.kind === "own") return session.ownEvents();
  // snapshot：250ms TTL 缓存（长会话全量拷贝昂贵）
  const hit = sessionEventsCache.get(session);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < 250) return hit.list;
  const list = session.snapshotEvents();
  sessionEventsCache.set(session, { at: now, list });
  return list;
}

/** 【0.1.5 兼容】只读读取一个已持久化会话（元数据 + 全量事件）的统一入口。
 *
 *  背景：0.1.1 的 `sessionPersistence` 提供 `inspect(id)`（只读、不取写所有权），
 *  插件的历史预览 / 只读浏览 / 分页都直接调用它。0.1.5 **移除了 `inspect`/`load`**，
 *  改为基于句柄的 `open(id, access)`：只读浏览必须用 `open(id, "read")` 拿
 *  `SessionHandle`，再 `handle.read(0)` 取事件、`handle.close()` 释放。
 *  旧代码用 `typeof persistence.inspect === "function"` 守卫，0.1.5 下守卫静默失败
 *  → **一个 history 帧都不发**：面板标题（bootstrap 携带）与日志大小标签（文件 stat）
 *  仍在，而消息列表被清空、统计归零——即"重启宿主后会话历史恢复不了"的不一致状态。
 *
 *  取值优先级（按代价从低到高，且均可与活跃写句柄并存）：
 *   1. `persistence.inspect`   —— ≤0.1.1，与 resume 共享 prepared 缓存；
 *   2. `persistence.open(id,"read")` + `handle.read(0)` —— ≥0.1.5，不取写所有权；
 *   3. `sessionQuery.readSession` —— 两版本都有，最后兜底。
 *
 *  @returns {Promise<{meta: object, events: Array}>}
 */
async function inspectStoredSession(ctx, sessionId) {
  const id = SessionId(sessionId);
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined && typeof persistence.inspect === "function") {
    const inspected = await persistence.inspect(id);
    return { meta: inspected.meta, events: inspected.events ?? [] };
  }
  if (persistence !== undefined && typeof persistence.open === "function") {
    // 0.1.5：read 句柄只观察、永不取所有权——可与另一实例/本进程的写句柄并存
    const handle = await persistence.open(id, "read");
    try {
      const result = await handle.read(0);
      return { meta: handle.header, events: result?.events ?? [] };
    } finally {
      try {
        await handle.close();
      } catch {
        /* 释放失败不影响已读到的数据 */
      }
    }
  }
  const query = ctx.get("sessionQuery");
  if (query !== undefined && typeof query.readSession === "function") {
    const snapshot = await query.readSession(id);
    return { meta: snapshot.session, events: snapshot.events ?? [] };
  }
  throw new Error("dsh-vscode-host: no session read API available (sessionPersistence.inspect/open, sessionQuery.readSession)");
}

const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd?)?$/;

/** 【0.1.5 兼容】按 seq 增量取会话事件（seq ≥ fromSeq）。
 *
 *  统计落盘（session/flush）原本每次都要 `sessionEventsOf()` 全量拷贝 + filter
 *  一遍整条日志，再用 base.lastSeq 逐条跳过——对 30 万事件级别的长会话是 O(n)
 *  拷贝 + O(n) 扫描，且 flush 是内核的持久化检查点（高频），实测会显著拖慢每次
 *  交互。这里直接按 seq 切片，只取新增段：seq 与日志下标在 0.1.1/0.1.5 都是
 *  连续且相等（"seq 恒等于日志长度"契约），故下标 == seq。
 */
function sessionEventsSince(session, fromSeq) {
  const from = Number.isFinite(fromSeq) && fromSeq > 0 ? Math.floor(fromSeq) : 0;
  const reader = sessionEventReader(session);
  if (reader === null) return [];
  if (reader.kind === "array") return from === 0 ? reader.events : reader.events.slice(from); // ≤0.1.1
  if (reader.kind === "own") return session.ownEvents();
  return from === 0 ? session.snapshotEvents() : session.snapshotEvents(from); // ≥0.1.5
}

/** 取 seq < beforeSeq 的最近 limit 条非 chunk/end-seed 事件（反向单遍，
 *  避免 `sessionEventsOf().filter()` 构造全量过滤数组——向上滚动分页的热路径）。 */
function olderSessionEvents(events, beforeSeq, limit) {
  const older = [];
  let hasMore = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "assistant/chunk" || e.type === "session/end-seed") continue;
    if ((e.seq ?? 0) >= beforeSeq) continue;
    if (older.length < limit) older.push(e);
    else { hasMore = true; break; }
  }
  older.reverse();
  return { older, hasMore };
}

/** 文件名 → 代数（无法识别返回 -1）。 */
function sessionLogGeneration(name) {
  const m = SESSION_LOG_RE.exec(name);
  if (m === null) return -1;
  return m[1] === undefined ? 0 : Number(m[1]);
}

/** 在会话目录中挑选**当前活跃**的日志文件（无匹配返回 null）。
 *  0.1.5 起会话日志按"格式代际"分文件（v0 保留旧名 session.jsonl[.zstd]，
 *  之后为 session.v<N>.jsonl[.zstd]，旧代际不可变保留、不双写）。因此
 *  **不能只按代际取最高**：若用户从 0.1.5 重置回旧内核（0.1.1），旧代文件
 *  才是正在被写入的活跃日志——按代际取高会选到已停止增长的 v3，导致列表
 *  更新时间/日志大小错乱。规则：优先最近写入（mtime），同 mtime 再取更高代。 */
function pickSessionLog(dir) {
  let best = null;
  let bestMtime = -1;
  let bestGen = -1;
  try {
    for (const name of readdirSync(dir)) {
      const gen = sessionLogGeneration(name);
      if (gen < 0) continue;
      let st;
      try {
        st = statSync(join(dir, name));
      } catch {
        continue; // 读不到 → 跳过
      }
      if (!st.isFile()) continue;
      const mtime = st.mtimeMs;
      if (mtime > bestMtime || (mtime === bestMtime && gen > bestGen)) {
        bestMtime = mtime;
        bestGen = gen;
        best = join(dir, name);
      }
    }
  } catch {
    /* 目录不可读 → 视为无日志 */
  }
  return best;
}

/** 会话日志大小缓存：sessionId -> { at, size }（TTL 内复用，避免高频事件批反复 statSync）。 */
const sessionSizeCache = new Map();
const SESSION_SIZE_CACHE_TTL = 1000; // 1s：标题栏大小最多滞后 1s，可接受

/** 当前会话日志文件大小（字节）；带 TTL 缓存（轮转检测与前端标签共用，降低同步 stat 频率）。 */
function sessionFileSize(sessionId) {
  try {
    const key = String(sessionId);
    const now = Date.now();
    const hit = sessionSizeCache.get(key);
    if (hit !== undefined && now - hit.at < SESSION_SIZE_CACHE_TTL) return hit.size;
    const root = dshHomePath("sessions-ay-dsh");
    // 按会话**实际所在目录**反查：跨项目/工作区恢复的会话，其目录键取创建时 cwd，
    // 不等于当前 process.cwd() 的 projectKey（与 acquireSessionLock 同理），否则大小显示错误。
    let dir = null;
    for (const entry of scanSessionDirs()) {
      if (entry.id === key) { dir = dirname(entry.logPath); break; }
    }
    if (dir === null) dir = join(root, projectKey(process.cwd()), encodeSegment(key));
    let size;
    // 多代日志（0.1.5）：pickSessionLog 取当前活跃（最近写入）日志文件大小；无日志则 undefined
    const logPath = pickSessionLog(dir);
    if (logPath !== null) size = statSync(logPath).size;
    sessionSizeCache.set(key, { at: now, size });
    return size;
  } catch { /* ignore */ }
  return undefined;
}

/** 从倒数第 n 条用户输入起，截取之后（含）所有 user/assistant 消息文本，保持时间顺序。
 *  用于轮转摘要：摘要取 n=30、fallback 取 n=5。
 *  **实证**：内核 user/message 事件结构为 `{ type, seq, time, data: { content, source, role, id } }`
 *  （无 message 字段）——必须读 `e.data.content`，此前误读 `e.message` 导致摘要恒为空。 */
function tailConversationText(events, lastUserCount) {
  const userSeqs = [];
  const msgs = []; // { seq, text }：只收 user/assistant 消息，跳过海量 assistant/chunk（单遍遍历）
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "user/message" && d.source?.kind === "user") userSeqs.push(e.seq);
    if (e.type === "user/message" || e.type === "assistant/message") {
      const content = e.type === "user/message" ? d.content : (d.message?.content ?? d.content);
      const text = (content ?? [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      if (text !== "") {
        msgs.push({ seq: e.seq, text: `${e.type === "user/message" ? "用户" : "AI"}：${text}` });
      }
    }
  }
  if (userSeqs.length === 0) return "";
  const startSeq = userSeqs[Math.max(0, userSeqs.length - lastUserCount)];
  return msgs.filter((m) => m.seq >= startSeq).map((m) => m.text).join("\n\n");
}

/** 用 LLM 生成用户对话摘要；不可用/失败时返回空串（调用方走 fallback）。
 *  与 compaction 的摘要调用不同：这里只输入用户消息文本，不复用系统提示词。 */
async function summarizeUserMessages(ctx, agent, texts, signal) {
  const llm = ctx.get("llm");
  if (llm === undefined || typeof llm.stream !== "function" || texts.length === 0) return "";
  const latest = agent.session.requestHeader?.()?.config;
  const target = (agent.options?.provider && agent.options?.model)
    ? { provider: agent.options.provider, model: agent.options.model }
    : latest;
  if (target === undefined) return "";
  // texts 是 tailConversationText 拼好的字符串（倒数 30 条用户消息起的对话）。
  // **不按 12000 字符截断**（此前导致大会话只摘要到最近一两轮、丢上下文），
  // 仅设 150000 字符上限，防止超长输入打爆摘要调用（token 成本：一次性摘要可接受）。
  const joined = texts.slice(-150000);
  if (joined.length === 0) return "";
  const instruction =
    "你是对话摘要助手。请通读以下会话内容（可能是很长对话的最近部分），"
    + "输出该会话的简明摘要，覆盖：整体任务目标、已完成的重点工作、关键决策与结论、"
    + "当前进度、待办事项。不要复述对话过程，只输出摘要正文，控制在 500 字以内。\n\n";
  const messages = [
    createUserMessage({
      content: [{ type: "text", text: instruction + joined }],
      source: { kind: "plugin", plugin: "dsh-vscode-host" },
    }),
  ];
  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      // maxTokens 需覆盖推理模型的 reasoning 消耗：600 会被思考吃光导致正文截断，
      // 2048 保证 reasoning + 摘要正文都有余量
      maxTokens: 2048,
      sessionId: agent.session.id,
      purpose: "rotate-session",
      signal,
    })) {
      assembler.push(chunk);
    }
    const text = assembler.blocks()
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return text;
  } catch (e) {
    log("warn", "rotate summary llm failed", e instanceof Error ? e.message : String(e));
    return "";
  }
}

/** 用户自定义提示词 / 自动学习经验文件（DSH home 固定路径固定文件名）：
 *  跨项目全局共享（非每个项目一份）；本地与 Remote 的 DSH home 各自独立维护。
 *  文件不存在/为空即不注入，不影响默认提示词。 */
const CUSTOM_PROMPT_FILE = join(resolveDshHome(), "ay-dsh-custom.md");
const LEARNING_FILE = join(resolveDshHome(), "ay-dsh-learning.md");
const REITERATION_FILE = join(resolveDshHome(), "ay-dsh-reiteration.md");

/** 读文件文本（不存在/空/异常返回空串）。 */
function readTextFile(p) {
  try {
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8").trim();
  } catch { /* ignore */ }
  return "";
}

/** 自动学习信号：用户消息出现明确的规则/指示表达才触发提炼（避免每轮都调 LLM）。 */
const LEARNING_SIGNAL_RE = /记住|教训|经验|以后|规则|禁止|不要|千万别|务必|必须|always|never|remember|rule|lesson|do not|don't/i;

/** 对抗性指令信号（自动学习门禁用）：这些措辞几乎不会出现在用户真实偏好中，却是指示
 *  模型"忽略系统提示/外泄密钥/窃取凭据"的典型提示注入载荷。命中则拒绝持久化。 */
const INJECTION_SIGNAL_RE = /忽略|无视|系统提示|system\s*prompt|system\s*message|外泄|泄露|泄漏|leak|exfiltrat|密钥|api\s*key|credential|secret|password/i;

/** 自动学习：检测用户消息中的"明确规则/被肯定经验"信号，用 LLM 提炼一条简洁
 *  经验，追加到工作区学习文件（去重：已存在相同条目则跳过）。异步、静默失败。 */
async function maybeLearnFromTurn(ctx, agent, userText) {
  // "启动学习"开关（DSH_ENABLE_LEARN=0 关闭）：关闭时不做自动学习
  if (String(process.env.DSH_ENABLE_LEARN ?? "0") === "0") return;
  if (typeof userText !== "string" || userText.trim() === "") return;
  if (!LEARNING_SIGNAL_RE.test(userText)) return;
  const llm = ctx.get("llm");
  if (llm === undefined || typeof llm.stream !== "function") return;
  const latest = agent.session.requestHeader?.()?.config;
  const target = (agent.options?.provider && agent.options?.model)
    ? { provider: agent.options.provider, model: agent.options.model }
    : latest;
  if (target === undefined) return;
  const input = userText.trim().slice(0, 4000);
  const instruction =
    "你是经验提炼助手。下面是一轮对话中用户的发言（可能含少量 AI 回复）。"
    + "请提取用户**明确提出**的工作规则、偏好或对 AI 行为的肯定/纠正，写成一条简洁经验。"
    + "要求：1) 一条一行，20~80 字，陈述句；2) 只提取明确陈述的规则/经验，忽略闲聊与事实问答；"
    + "3) 若没有任何明确的规则或经验，只输出空字符串，不要编造。\n\n";
  const messages = [
    createUserMessage({
      content: [{ type: "text", text: instruction + input }],
      source: { kind: "plugin", plugin: "dsh-vscode-host" },
    }),
  ];
  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      maxTokens: 200,
      sessionId: agent.session.id,
      signal: new AbortController().signal,
    })) {
      assembler.push(chunk);
    }
    const text = assembler.blocks()
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (text.length === 0) return;
    // 【门禁】自动学习把 LLM 输出持久化并注入后续系统提示，需防"提示注入跨会话固化"：
    //  合并为单行（去代码围栏/Markdown 结构）、长度 20~200、拒绝对抗性指令措辞。
    const collapsed = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#*_>`~|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (collapsed.length < 20 || collapsed.length > 200) return;
    if (INJECTION_SIGNAL_RE.test(collapsed)) return;
    const clean = collapsed;
    const file = LEARNING_FILE;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (existing.includes(clean)) return; // 简单去重：已存在相同条目
    if (existing.length > 64 * 1024) return; // 文件上限兜底，防被持续注入撑大
    const next = existing.trim() ? `${existing.trim()}\n\n- ${clean}` : `- ${clean}`;
    mkdirSync(dirname(file), { recursive: true });
    // 原子写（temp + rename），避免读-改-写交错产生半截文件（L4）
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, file);
    log("info", `learned rule: ${clean}`);
  } catch (e) {
    log("warn", "auto-learn llm failed", e instanceof Error ? e.message : String(e));
  }
}

/**
 * 旧会话（meta 无 title）的静态标题：`oldsession_<mtime>`。
 * **不读任何日志文件**（列表性能纪律）：标题是纯静态记录，首指令前缀需要
 * 读日志（zstd 解压），成本高于价值——放弃；用户可随时重命名覆盖。
 */
function genOldSessionTitle(mtime, sessionId) {
  return `oldsession_${fmtTitleTime(mtime || Date.now())}_${sessionId}`;
}

/**
 * 宿主**自扫持久化目录**拿会话清单（方案 B，零 zstd 解压）。
 * 目录结构：`sessions-ay-dsh/<projectKey>/<sessionId>/session.jsonl[.zstd]`
 * readdir 两级，**目录名即会话 id**——完全不读日志内容，避开内核
 * `query.listSessions()` 逐会话解压读 header（listArtifacts）的性能问题。
 * @returns {Array<{id:string, logPath:string, project:string}>} 无日志文件的目录跳过
 */
function scanSessionDirs() {
  const root = dshHomePath("sessions-ay-dsh");
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 目录不存在 → 无会话
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let sessions;
    try {
      sessions = readdirSync(join(root, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      // 多代日志（0.1.5）：取该会话目录中**当前活跃**（最近写入）的日志文件
      const logPath = pickSessionLog(join(root, p.name, s.name));
      if (logPath === null) continue; // 无日志文件 → 非会话目录（跳过）
      out.push({ id: s.name, logPath, project: p.name });
    }
  }
  return out;
}

/**
 * 列出持久化会话（newest-first），附标题。
 *
 * **方案 B（2026-08-20 owner 定）**：宿主自扫目录（scanSessionDirs，零解压），
 * **不再调用内核 query.listSessions()**（其 listArtifacts 对每个会话 zstd 解压
 * 读 header，会话多/日志大时列表很慢——内核无轻量列表 API，宿主绕开）。
 * 标题为静态记录（meta 单文件；无则生成 `oldsession_<mtime>` 补写，不读日志）。
 * updatedAt = 日志文件 mtime（stat，不读内容）。
 * live 标记由调用方（main listSessions case）按当前 agent 补标。
 * 缓存 TTL 3s：反复打开秒回；创建/删除/重命名/补写时失效（invalidateSessionsCache）。
 */
const SESSIONS_CACHE_TTL = 3000;
let sessionsCache = null;
let sessionsCacheAt = 0;
function invalidateSessionsCache() {
  sessionsCache = null;
  sessionsCacheAt = 0;
}
async function listSessions(ctx) {
  const now = Date.now();
  if (sessionsCache !== null && now - sessionsCacheAt < SESSIONS_CACHE_TTL) {
    return sessionsCache;
  }
  const entries = scanSessionDirs();
  // 项目隔离（2026-09 owner 定）：历史列表**默认只显示当前工作区（项目）的会话**，
  // 不加任何切换标识。会话库是机器级共享根（dshHomePath("sessions-ay-dsh")），
  // 目录虽按 projectKey 分档，但若不在此过滤，其它项目/工作区的会话会全量可见、
  // 可被误恢复（曾导致跨工作区恢复他人会话）。切掉即与"当前工作区"强绑定。
  const currentProject = projectKey(process.cwd());
  // Windows 路径大小写不敏感：会话目录名来自会话**创建时**的 cwd（旧 home 迁移的
  // 会话还会原样保留旧键名），与当前进程 cwd 的盘符大小写可能不同
  // （d:\... vs D:\...）。严格相等会让历史列表**静默变空**——恰恰造成
  // "不知道是新会话还是继承的旧会话"的困惑（本次 0.1.5 升级排查即命中）。
  const sameProject =
    process.platform === "win32"
      ? (a, b) => a.toLowerCase() === b.toLowerCase()
      : (a, b) => a === b;
  const scoped = entries.filter((e) => sameProject(e.project, currentProject));
  const allMeta = loadSessionMeta();
  const patch = {};
  const result = [];
  for (const e of scoped) {
    const meta = allMeta[e.id] ?? {};
    let title = meta.title;
    if (typeof title !== "string" || title.trim() === "") {
      let mtime = 0;
      try {
        const st = statSync(e.logPath);
        if (st.mtimeMs > 0) mtime = st.mtimeMs;
      } catch {
        // 日志文件缺失 → 用当前时间
      }
      title = genOldSessionTitle(mtime, e.id);
      patch[e.id] = { ...meta, title };
    }
    let updatedAt = 0;
    try {
      const st = statSync(e.logPath);
      if (st.mtimeMs > 0) updatedAt = st.mtimeMs;
    } catch {
      // 日志文件缺失 → 回退当前时间
    }
    result.push({
      id: e.id,
      cwd: e.project, // 展示用（projectKey 目录名；不反解，恢复/删除走内核不受影响）
      createdAt: updatedAt || now,
      title,
      updatedAt: updatedAt || now,
      live: false, // 调用方按当前 agent 补标
      // 会话类型：主代理（dsh-vscode- 前缀）或子代理（subagent 工具，裸 UUID）
      kind: String(e.id).startsWith(SESSION_PREFIX) ? "main" : "sub",
      // 会话级模型/思考级别/workMode（恢复时还原用；前端可展示）
      provider: meta.provider,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      workMode: meta.workMode,
    });
  }
  if (Object.keys(patch).length > 0) {
    for (const [id, v] of Object.entries(patch)) allMeta[id] = v;
    saveSessionMeta(allMeta);
    invalidateSessionsCache(); // meta 变化，丢弃可能存在的旧缓存
  }
  result.sort((a, b) => b.updatedAt - a.updatedAt); // newest-first
  sessionsCache = result;
  sessionsCacheAt = Date.now();
  return result;
}

/**
 * 计算会话统计快照（token 累计 / 上下文窗口 / steps）。
 *  - 恢复/查看/压缩统一全量纯算（或经 resolveSessionStats 直读 meta.stats）；
 *  - 注：仅统计 token，不做费用估算（2026-08-20 owner 决策放弃计费）。
 * @param {Array} events 会话事件（按 seq 升序）
 * @param {object|undefined} base 累计基准（可选，seq > base.lastSeq 才计入）
 */
function computeSessionStats(events, base) {
  const stats = {
    inputTokens: base?.inputTokens ?? 0,
    cacheReadTokens: base?.cacheReadTokens ?? 0,
    outputTokens: base?.outputTokens ?? 0,
    steps: base?.steps ?? 0,
    lastSeq: base?.lastSeq ?? 0,
  };
  if (base?.title) stats.title = base.title;
  if (base?.contextWindow) stats.contextWindow = base.contextWindow;
  if (base?.model) stats.model = base.model;
  if (base?.lastRequestInput) stats.lastRequestInput = base.lastRequestInput; // 增量落盘勿丢该字段（compact 依赖）
  for (const e of events) {
    if (base !== undefined && (e.seq ?? 0) <= base.lastSeq) continue; // 已在基准内，跳过
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
    stats.lastSeq = Math.max(stats.lastSeq, e.seq ?? 0);
  }
  return stats;
}

/**
 * 解析会话统计（meta.stats 直读 + 崩溃/重启一致性 + 新旧机制转换，docs 2.27）。
 *  - meta.stats 存在且**同步**（lastSeq == 日志末尾 seq）→ **直读**（零遍历）；
 *  - meta.stats 存在但**滞后**（lastSeq < 日志末尾——会话中断后未落盘的新事件，
 *    如崩溃/重启前最后一段对话）→ **直读 + 增量补算尾部**（base 参数只算
 *    seq > lastSeq 的事件）并落盘更新——保证崩溃/重启后统计与重启前一致；
 *  - meta 无 stats（旧会话/机制转换前）→ **全量算一次并落盘**（首次迁移）；
 *  - meta.stats **异常**（转换期坏值：lastSeq 超过日志末尾）→ **重算修复**并落盘。
 * @param {object|undefined} metaStats 会话 meta 中已存的 stats
 * @param {Array} events 当前日志事件（过滤后）
 * @param {string} sessionId 会话 id（落盘用）
 * @param {boolean} persist 是否把重算的统计落盘 meta（只读浏览传 false）
 */
function resolveSessionStats(metaStats, events, sessionId, persist = true) {
  // 事件按 seq 升序，末元素即 maxSeq（避免 O(n) reduce）
  const maxSeq = events.length > 0 ? (events[events.length - 1].seq ?? 0) : 0;
  if (metaStats && Number.isFinite(metaStats.lastSeq) && metaStats.lastSeq <= maxSeq) {
    // 有效：直读（同步）或滞后补算（崩溃/重启一致）
    if (metaStats.lastSeq === maxSeq) return metaStats;
    const stats = computeSessionStats(events, metaStats); // base 增量：只算尾部
    if (persist) try {
      const meta = loadSessionMeta();
      meta[sessionId] = { ...(meta[sessionId] ?? {}), stats: { ...stats } };
      saveSessionMeta(meta);
    } catch (error) {
      log("warn", "session stats persist failed", error instanceof Error ? error.message : String(error));
    }
    return stats;
  }
  // 首次迁移 / 异常修复：全量纯算（persist 时才落盘，之后直读）
  const stats = computeSessionStats(events);
  if (persist) try {
    const meta = loadSessionMeta();
    meta[sessionId] = { ...(meta[sessionId] ?? {}), stats: { ...stats } };
    saveSessionMeta(meta);
  } catch (error) {
    log("warn", "session stats persist failed", error instanceof Error ? error.message : String(error));
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/* 会话占用锁（2026-09 owner 定：防两个 VS Code 实例并发读写同一会话日志） */
/* ------------------------------------------------------------------ */
/**
 * 活性判定**只依赖系统进程状态**（process.kill(pid, 0)），不做心跳、不强抢：
 *  - pid 存活 → 持有者仍在（哪怕正卡在长任务/等待外设），拒绝恢复并提示，等它自己
 *    恢复继续使用——绝不抢占活进程的会话；
 *  - pid 不存在（正常退出/崩溃/窗口强杀）→ stale，自动接管——永不永久锁死；
 *  - 释放：正常退出走 shutdown 钩子 best-effort 删除；崩溃无需处理（pid 消失即解锁）。
 * 局限（已知并接受）：pid 可能被系统复用；同机短时复用概率极低且需恰巧命中同一
 * 会话目录才可能误伤。未来若需消除，可加"进程启动时间"二次校验（Linux /proc、
 * Windows CIM），当前不引入。
 * 锁文件放会话目录内（.host-lock.json）；内核只认固定 transcript 文件名，不冲突；
 * 会话删除时目录连带删除。
 */
const SESSION_LOCK_NAME = ".host-lock.json";
let currentSessionLock = null; // { file } 当前宿主持有的会话锁

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionDirFor(sessionId) {
  return join(dshHomePath("sessions-ay-dsh"), projectKey(process.cwd()), encodeSegment(sessionId));
}

/** 释放本宿主持有的锁（best-effort；崩溃时 pid 消失即由他方接管，无需此处兜底）。 */
function clearOwnLock() {
  if (currentSessionLock === null) return;
  try {
    rmSync(currentSessionLock.file, { force: true });
  } catch {
    /* best-effort */
  }
  currentSessionLock = null;
}

/**
 * 接管会话：先原子独占抢占目标会话锁，**成功后才释放旧锁**——若目标锁被他实例
 * 占用（busy）则旧锁保留，旧会话仍受互斥保护（避免"先释放旧锁再抢失败"把仍存活的
 * 旧会话暴露成无锁态、他方接管造成双写）。
 * @returns {ok:true} 或 {ok:false, busy:true, holderPid}（他实例进程活着）
 *         或 {ok:true, degraded:true}（锁不可用但不阻断会话功能）。
 */
function acquireSessionLock(sessionId) {
  // 锁文件锚定会话**实际所在目录**（按日志目录反查），而不是检查方当前 cwd 的
  // projectKey——否则不同工作区/项目的窗口（cwd 不同）会各自写不同路径的锁文件，
  // 互斥失效（会话 id 全局唯一、目录按项目分档，锁必须落在真实目录）。restorePreview
  // 的自动恢复不经列表过滤，正是必须按真实目录加锁的场景。新会话（日志尚未落盘）
  // 回退到当前 cwd 分档——同工作区双开场景路径一致，仍然互斥。
  let dir = null;
  try {
    for (const entry of scanSessionDirs()) {
      if (entry.id === sessionId) {
        dir = dirname(entry.logPath);
        break;
      }
    }
  } catch {
    /* 扫描失败回退 */
  }
  if (dir === null) dir = sessionDirFor(sessionId);
  const file = join(dir, SESSION_LOCK_NAME);
  // 已持有同一会话锁：幂等成功（不清旧锁再抢，避免 EEXIST 误判他实例占用）。
  if (currentSessionLock !== null && currentSessionLock.file === file) {
    return { ok: true };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 尽力而为 */
  }
  const payload = JSON.stringify({
    pid: process.pid,
    project: projectKey(process.cwd()),
    acquiredAt: Date.now(),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, payload, { flag: "wx" }); // 原子独占创建
      clearOwnLock(); // 新锁已到手，才释放旧锁（busy 时旧锁保留，旧会话仍受保护）
      currentSessionLock = { file };
      return { ok: true };
    } catch (err) {
      if (err !== null && typeof err === "object" && err.code === "EEXIST") {
        let holder = null;
        try {
          holder = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          /* 坏锁内容按 stale 处理 */
        }
        if (holder !== null && Number.isInteger(holder.pid) && processAlive(holder.pid)) {
          return { ok: false, busy: true, holderPid: holder.pid };
        }
        try {
          rmSync(file, { force: true }); // stale：持有者已死，清锁重试一次
        } catch {
          /* 忽略 */
        }
        continue;
      }
      // 其它异常（目录只读等）：降级为无锁继续，不阻断会话功能
      log("warn", "session lock acquire degraded", err instanceof Error ? err.message : String(err));
      clearOwnLock(); // 降级：新会话无锁、旧会话即将被 dispose，释放旧锁避免自留 stale
      return { ok: true, degraded: true };
    }
  }
  clearOwnLock();
  return { ok: true, degraded: true };
}

/** 恢复会话后的存量目标收尸（G1）：插件已禁用 goal 自动续跑与工具，若会话遗留
 *  active goal（历史上模型创建的无人值守目标），宿主直接 pause，杜绝任何恢复后
 *  复活续跑的可能（driver 禁用是主闸，此为二次保险）。失败不阻断恢复。 */
async function pauseLegacyActiveGoal(ctx, agent) {
  try {
    const goals = ctx.get("goals");
    if (goals === undefined || typeof goals.get !== "function") return;
    const goal = goals.get(agent);
    if (goal === undefined || goal.phase !== "active") return;
    if (typeof goals.pause !== "function") return;
    const result = goals.pause(agent, { id: goal.id, revision: goal.revision });
    if (result !== undefined && typeof result.then === "function") await result;
    log("info", `paused legacy active goal (id=${goal.id} rev=${goal.revision}) after session resume`);
    post({
      t: "hint",
      text: L("已暂停该会话遗留的自动续跑目标，可安全继续对话。", "Paused a legacy auto-continuation goal for this session; safe to continue."),
    });
  } catch (error) {
    log("warn", "pause legacy goal failed", error instanceof Error ? error.message : String(error));
  }
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
/** 会话锁是否被**他实例**（存活的其它进程）持有。删除前互斥检查用。 */
function isSessionLockedByOther(dir) {
  try {
    const holder = JSON.parse(readFileSync(join(dir, SESSION_LOCK_NAME), "utf8"));
    if (holder !== null && Number.isInteger(holder.pid) && holder.pid !== process.pid && processAlive(holder.pid)) {
      return true;
    }
  } catch {
    /* 无锁/坏锁 → 不忙 */
  }
  return false;
}

async function deleteSession(ctx, sessionId) {
  try {
    // **零解压定位目录**（scanSessionDirs 只 readdir，不读日志）——原实现用
    // query.readSession 全量解压拿 cwd，删除大会话时慢（docs 2.25）。
    let dir = null;
    for (const entry of scanSessionDirs()) {
      if (entry.id === sessionId) {
        dir = dirname(entry.logPath);
        break;
      }
    }
    if (dir === null) {
      // 回退：目录扫描未找到（live 会话等）→ 用内核读 cwd 定位
      const query = ctx.get("sessionQuery");
      const cwd = query !== undefined ? (await query.readSession(SessionId(sessionId))).session.cwd ?? process.cwd() : process.cwd();
      dir = join(dshHomePath("sessions-ay-dsh"), projectKey(cwd), encodeSegment(sessionId));
    }
    // 互斥检查：会话正被（本进程当前使用 或 他实例存活持有）→ 拒绝删除，
    // 避免在他实例/本进程正在写入时 rmSync 删目录造成写坏会话。
    const lockFile = join(dir, SESSION_LOCK_NAME);
    if (currentSessionLock !== null && currentSessionLock.file === lockFile) {
      return { ok: false, error: "正在使用的会话无法删除，请先切换到其它会话或新建会话" };
    }
    if (isSessionLockedByOther(dir)) {
      return { ok: false, error: "会话正被另一 VS Code 实例使用中，无法删除" };
    }
    // 多代日志（0.1.5）：目录内存在**任一世代**日志（v0 旧名或 session.v<N>.jsonl[.zstd]）
    // 即视为有效会话；删除时整目录递归移除（覆盖全部世代文件与 .host-lock.json）。
    if (pickSessionLog(dir) === null) {
      return { ok: false, error: `会话文件不存在: ${dir}` };
    }
    rmSync(dir, { recursive: true, force: true });
    removeSessionMeta(sessionId);
    invalidateSessionsCache(); // 列表缓存同步失效
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
 * 输出到**当前工作区的 exports/ 目录**（不放 DSH home——敏感文件区），返回文件路径。
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

    // 导出到**当前工作区**的 exports/ 目录（用户可见、易管理；不放 DSH home——
    // 那里含密钥等敏感文件，不轻易留存导出内容）
    const exportDir = join(process.cwd(), "exports");
    mkdirSync(exportDir, { recursive: true });
    // 文件名清洗：sessionId 来自 webview 帧，未校验不得直接拼路径（防 ../ 穿越）
    const safeId = /^[A-Za-z0-9._-]+$/.test(String(sessionId)) ? sessionId : "session";
    const outPath = join(exportDir, `${safeId}.html`);
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
  // 轮转检测**不挂在写日志/事件 flush 上**（恢复会话重放也会 flush 造成误触发，
  // 且每次写日志都检查降低效率）——改由定时器**闲时**检查日志文件大小（见下方定时器）。
  const pump = new EventPump(
    () => (agent === undefined || agent.session === undefined ? undefined : sessionFileSize(String(agent.session.id)))
  );
  const approvals = { nextId: (() => { let n = 0; return () => ++n; })(), pending: new Map() };

  let ctx;
  let handle;
  let agent;
  /** 当前 agent 的可变模型选择引用（installModelSelection 使用；setModel 热切换）。 */
  let selection = null;
  /** 当前 agent 的"重置本轮思考步数预算"回调（chat 入口在每条用户消息前调用）。 */
  let resetStepBudget = null;
  let shuttingDown = false;
  /** 轮转检查退避定时器（对话进行中 → 30s 后重试；等闲下来再做，不取消检查）。 */
  let rotateRetryTimer = null;
  /** 主 agent 是否正在回复（由内核 agent/status 事件维护；轮转须避开运行期）。 */
  let agentBusy = false;
  /** 会话轮转：历史文件超限后预建的下一会话 id（agent 惰性创建于首条消息）。 */
  let pendingSessionId = null;
  /** 用户当天拒绝轮转的日期（拒绝后当天不再检测）。 */
  let rotateRejectedDate = "";
  /** 轮转确认框待回复（非 null 时等待前端 rotateConfirm 消息）。 */
  let rotateConfirmResolve = null;
  let rotateConfirmOk = false;
  /** 轮转执行中（摘要生成/新会话创建）：期间阻止新对话，避免相互干扰。 */
  let rotating = false;

  try {
    ctx = await bootTree();
    log("info", "DSH tree booted");
    // 主 agent 运行状态跟踪（根 ctx 可收到子 agent 事件；仅跟踪当前主 agent）
    ctx.on("agent/status", ({ agent: a, status }) => {
      if (agent !== undefined && a === agent) agentBusy = status === "running";
    });

    // ---- 会话轮转：日志超阈值后预建新会话（agent 惰性创建），避免长会话拖垮宿主 ----
    // 配置（env 可覆盖）：DSH_ROTATE_BYTES 阈值（默认 10MB）、DSH_ROTATE_SUMMARY
    // （"1"=LLM 对话摘要，"0"=直接取最近用户消息）、DSH_ROTATE_FALLBACK_MSGS fallback 条数。
    const ROTATE_BYTES = (() => {
      const n = Number(process.env.DSH_ROTATE_BYTES);
      return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
    })();
    const ROTATE_SUMMARY_ENABLED = String(process.env.DSH_ROTATE_SUMMARY ?? "1") !== "0";
    const ROTATE_FALLBACK_MSGS = (() => {
      const n = Number(process.env.DSH_ROTATE_FALLBACK_MSGS);
      return Number.isInteger(n) && n > 0 ? n : 5;
    })();
    const stripSeqSuffix = (t) => String(t).replace(/_\d+$/, "");
    const nextSessionSeq = (t) => {
      const m = /_(\d+)$/.exec(String(t));
      return m ? Number(m[1]) + 1 : 1;
    };
    async function maybeRotateSession() {
      if (agent === undefined || pendingSessionId !== null || shuttingDown) return;
      // 对话进行中：**退避不取消**——30s 后重试（或等 agent/status 变空闲时立即补查），
      // 绝不打断进行中的对话
      if (agentBusy) {
        if (rotateRetryTimer === null) {
          rotateRetryTimer = setTimeout(() => {
            rotateRetryTimer = null;
            void maybeRotateSession();
          }, 30_000);
        }
        return;
      }
      // 用户当天已明确拒绝轮转：当天不再检测
      if (rotateRejectedDate === new Date().toDateString()) return;
      try {
        const size = sessionFileSize(agent.session.id);
        if (size === undefined || size <= ROTATE_BYTES) return;
        // 轮转前**请求用户确认**（不自动轮转）：确认后执行；拒绝则当天不再检测
        if (rotateConfirmResolve !== null) return; // 已有确认框在等
        const oldTitle = (await currentSessionTitle(ctx, agent)) || "会话";
        post({ t: "rotateRequest", oldTitle, sessionBytes: size });
        rotateConfirmOk = false;
        await new Promise((resolve) => { rotateConfirmResolve = resolve; });
        rotateConfirmResolve = null;
        if (!rotateConfirmOk) {
          rotateRejectedDate = new Date().toDateString();
          return;
        }
        // 轮转执行中：通知前端锁定发送并提示状态（摘要生成可能耗时数秒），
        // 期间 chat 分支拒绝新消息，避免与新会话创建/摘要生成相互干扰
        rotating = true;
        post({ t: "rotateWorking" });
        // 1) 生成**用户对话摘要**（含 AI 回复；不再调用 compaction.compactNow：
        //    那是同会话上下文压缩，摘要复用系统提示词，不适合跨会话迁移）
        // 覆盖最近 60 条用户消息起的对话（配合 summarizeUserMessages 内 150K 上限，
        // 避免大会会话只摘要到最近一两轮）
        const tailText = tailConversationText(sessionEventsOf(agent.session), 60);
        let summary = "";
        if (ROTATE_SUMMARY_ENABLED && tailText !== "") {
          try {
            summary = await summarizeUserMessages(ctx, agent, tailText, new AbortController().signal);
          } catch (e) {
            log("warn", "rotate summary failed, falling back to verbatim", e instanceof Error ? e.message : String(e));
            summary = "";
          }
        }
        if (summary === "") {
          // fallback：LLM 摘要不可用/关闭 → 取倒数第 N 条用户输入起的所有
          // user/assistant 消息原文（默认 N=5），不丢失记忆
          summary = tailConversationText(sessionEventsOf(agent.session), ROTATE_FALLBACK_MSGS);
        }
        // 2) 创建新会话：**立即创建 agent 并注入摘要**（轮转经用户确认，新会话应
        //    直接可用并继承前会话摘要——不等首条消息，摘要即显示在对话面板）
        const newId = `dsh-vscode-${randomUUID()}`;
        const seq = nextSessionSeq(oldTitle);
        const newTitle = `${stripSeqSuffix(oldTitle)}_${seq}`;
        updateSessionMeta(newId, { title: newTitle, seedSummary: undefined, rotated: true });
        invalidateSessionsCache();
        // 3) 关闭旧 agent
        if (handle !== undefined) { await handle.dispose(); handle = undefined; agent = undefined; resetStepBudget = null; }
        // 4) 立即创建新 agent + 注入上一会话摘要（作为新会话首条 user 消息，
        //    持久化到日志，随 history 帧立即显示，用户不再面对空会话）
        let seedEvents = [];
        try {
          const created = await createAgent(ctx, { sessionId: newId }, pump, approvals);
          handle = created.handle;
          agent = created.agent;
          selection = created.selection;
          resetStepBudget = created.resetStepBudget;
          if (summary !== "") {
            agent.inject(createUserMessage({
              content: [{ type: "text", text: `【上一会话摘要】\n${summary}` }],
              source: { kind: "user" },
            }));
            // inject 仅入队不落地（内核语义 wakeup=false，等待下次唤醒才写入日志），
            // 立即读 agent.session.events 拿不到——直接构造摘要事件供 history 帧显示；
            // 持久化由用户首条消息时 driver 处理队列完成（前端据此文本去重，避免重复显示）。
            // 注意：user/message 事件的 data 结构是 `content`（host.ts translateEvent
            // 读 data.content 做 blocksToText），不是 messages 包装。
            seedEvents = [{
              type: "user/message",
              seq: 1,
              time: Date.now(),
              data: { content: [{ type: "text", text: `【上一会话摘要】\n${summary}` }] },
            }];
          }
          log("info", `rotated session created with seed summary (${summary.length} chars)`);
        } catch (e) {
          // 创建失败：回退惰性创建（首条消息时经 agent.inject 再注入摘要），不阻塞轮转
          log("warn", "rotate new agent create failed, deferring to lazy create", e instanceof Error ? e.message : String(e));
          pendingSessionId = newId;
          updateSessionMeta(newId, { seedSummary: summary });
        }
        // 5) 前端自动切换到新会话 + 弹框提示
        post({
          t: "ready",
          sessionId: newId,
          cwd: process.cwd(),
          provider: selection?.provider ?? "",
          model: selection?.model ?? env.DSH_VSCODE_MODEL ?? "",
          version: CORE_VERSION,
          sessionTitle: newTitle,
          sessionBytes: sessionFileSize(newId),
        });
        // 5.5) 补发新会话 history 帧（携带摘要 events）：前端渲染摘要消息
        //（不再是无内容的空会话），避免旧会话内容残留造成"看起来没切换"。
        post({ t: "history", sessionId: newId, events: seedEvents, hasMore: false, nextSeq: undefined, sessionBytes: sessionFileSize(newId) });
        post({ t: "sessionRotated", oldTitle, newTitle, sessionBytes: sessionFileSize(newId) });
        log("info", `session rotated: ${oldTitle} -> ${newTitle} (file ${size} bytes, summary ${summary.length} chars)`);
      } catch (e) {
        log("warn", "session rotation failed", e instanceof Error ? e.message : String(e));
      } finally {
        rotating = false; // 无论成败：轮转结束，恢复对话
      }
    }
    // 轮转检测：**仅定时器、闲时检查**（超限不是致命问题，不追求精准）。
    // - 启动后延迟 5 分钟首次检查（不抢启动；agentBusy 时 maybeRotateSession 直接
    //   return，**绝不打断进行中的对话**）；
    // - 之后每 1 小时检查一次当前会话日志文件大小，超限才请求用户确认
    //   （用户拒绝则当天不再检测）。
    // **不在写日志/事件 flush 时检测**（恢复会话重放也会 flush，会造成"一打开就
    // 提示轮转"；且每次写日志都检查降低效率）。
    setTimeout(() => { void maybeRotateSession(); }, 5 * 60 * 1000);
    setInterval(() => { void maybeRotateSession(); }, 60 * 60 * 1000);

    // 全局审批监听（根 ctx，一次）：覆盖主 agent 与所有 subagent 的越界请求
    installApprovalListener(ctx, approvals);
    log("info", "approval listener installed (root scope, covers all agents)");

    // 子代理会话标题：`agent/created`（内核 announce，覆盖所有 agent）时，
    // 对**子代理会话**（裸 UUID，非主代理前缀）写静态标题 `newsession_<时间戳>`
    // ——与会话管理一致（主代理 chat 惰性创建时已写 newsession_；子代理无用户
    // 指令概念，前缀留空）。避免新子代理会话落入"oldsession_"补写路径。
    ctx.on("agent/created", ({ agent: createdAgent }) => {
      try {
        const sid = createdAgent.session.id;
        if (String(sid).startsWith(SESSION_PREFIX)) return; // 主代理：chat 分支已写
        const meta = getSessionMeta(sid);
        if (typeof meta.title === "string" && meta.title.trim() !== "") return; // 已有
        updateSessionMeta(sid, { title: genSubsessionTitle(sid) }); // subsession_<时间>_<sessionId>
        invalidateSessionsCache();
      } catch (error) {
        log("warn", "subagent title init failed", error instanceof Error ? error.message : String(error));
      }
    });
    log("info", "subagent title listener installed (agent/created)");

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
    // 自检模式（运行时升级验证用）：DSH_SELF_TEST 为一次性 nonce 时回显该 nonce 并退出
    // （扩展侧据此判定闭包可用；nonce 防伪造静态哨兵提前通过）
    if (typeof process.env.DSH_SELF_TEST === "string" && process.env.DSH_SELF_TEST !== "" && process.env.DSH_SELF_TEST !== "0") {
      process.stdout.write(`${process.env.DSH_SELF_TEST}\n`);
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
    clearOwnLock(); // 释放会话锁（best-effort；崩溃时 pid 消失即自动失效）
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
  const CRITICAL_FRAMES = new Set(["chat", "newSession", "resumeSession", "restorePreview", "deleteSession", "compact"]);

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
            // 轮转执行中：拒绝新消息（前端已锁定发送，此处兜底防并发干扰）
            if (rotating) {
              post({ t: "chatDone", id: msg.id, ok: false, error: "rotation in progress" });
              return;
            }
            // 惰性创建：用户发出第一条消息时才创建会话（绝不预先创建空会话）
            // 注意：此处**不**写会话 meta——lazy session 策略下，未持久化的
            // 会话不视为有效会话，提前记录会产生孤儿 meta 条目（会话从未
            // 落盘时无法随删除清理）。新会话的模型选择已通过 setModel 的
            // defaultModel.saveSelection 持久化为全局默认，createAgent 即用该
            // 默认创建；对话中途切换模型则由 setModel/setWorkMode 的
            // `agent !== undefined` 分支记录 meta（此时会话已真实存在）。
            if (agent === undefined) {
              // 恢复预览已由 restorePreview 立即 resumeAgent（不等发消息），
              // 此处仅剩"新会话"的惰性创建（用户发第一条消息才建）。
              // 注意：**不**用 env.DSH_VSCODE_MODEL（扩展配置的固定 model）覆盖——
              // 那会让 model 与 agentDefaultModel 持久化的 provider 脱节，拼出
              // 如 zai-free+deepseek-v4-flash 的错配请求。model 一律取
              // agentDefaultModel 的持久化默认（createAgent 内部 options.model ??
              // base.model），与 getModelInfo 展示给 UI 的选择同源。
              const created = await createAgent(ctx, { model: msg.model, sessionId: pendingSessionId ?? undefined }, pump, approvals);
              pendingSessionId = null;
              handle = created.handle;
              agent = created.agent;
              selection = created.selection;
              resetStepBudget = created.resetStepBudget;
              // 新会话接管会话锁（统一写锁：其他实例试图恢复本会话时将被拒绝）。
              acquireSessionLock(agent.session.id);
              // 会话已真实创建：立即生成**静态临时标题**写入 meta（标题是静态
              // 记录，此后仅由用户重命名覆盖）。列表直接读 meta，无需内核折叠
              // 会话日志推导标题——历史列表因此秒开，与会话内容大小无关。
              // 仅当会话尚无标题时才用首条消息生成临时标题：轮转新会话的
              // meta 已写入 _N 标题（保持会话关联），不能被 genTempTitle 覆盖
              if (!getSessionMeta(agent.session.id).title) {
                updateSessionMeta(agent.session.id, { title: genTempTitle(text) });
              }
              invalidateSessionsCache(); // 新会话入列表，丢弃旧缓存
            }
            // 轮转标题钉住：仅对**轮转新会话**（meta.rotated=true）钉住 _N 标题——
            // 调用内核 rename 后，后续自动标题（source=user）被 supersede，不再覆盖。
            // 普通新会话无此标记，内核自动标题仍正常生成（不误伤）。
            // （此前钉住逻辑误挂在 seedSummary 块内；摘要改用 inject 持久化后
            //  seedSummary 被清除，导致轮转标题失去保护被自动标题覆盖）
            const meta = getSessionMeta(agent.session.id);
            if (meta?.rotated === true && typeof meta.title === "string" && meta.title.trim() !== "") {
              const titleSvc = ctx.get("sessionTitle");
              if (titleSvc !== undefined && typeof titleSvc.rename === "function") {
                Promise.resolve()
                  .then(() => titleSvc.rename(agent.session, meta.title))
                  .catch((error) => {
                    log("warn", "rotate session title pin failed", error instanceof Error ? error.message : String(error));
                  });
              }
            }
            // 轮转摘要注入（兼容旧轮转：meta.seedSummary 仍在时注入一次；新轮转
            // 已改为轮转时直接 inject，seedSummary 已清除，此处不重复）
            if (meta?.seedSummary) {
              try {
                agent.inject(createUserMessage({
                  content: [{ type: "text", text: `【上一会话摘要】\n${meta.seedSummary}` }],
                  source: { kind: "user" },
                }));
                updateSessionMeta(agent.session.id, { seedSummary: undefined });
                log("info", `rotated session seed summary injected (${meta.seedSummary.length} chars)`);
              } catch (e) {
                log("warn", "rotate seed summary inject failed", e instanceof Error ? e.message : String(e));
              }
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
            // 组装用户消息内容：文本块 + 图片块（图片先存入 DSH 附件服务 → 附件引用）。
            // 内核 serialize 时会把图片附件读回并转 data URL 发给模型（多模态）。
            let userContent = [{ type: "text", text }];
            if (Array.isArray(msg.images) && msg.images.length > 0) {
              try {
                const attach = ctx.get("attachments");
                if (!attach) throw new Error("attachment service unavailable");
                for (const img of msg.images) {
                  try {
                    const ref = await attach.saveImage({
                      data: Buffer.from(String(img?.data ?? ""), "base64"),
                      mediaType: img?.mediaType,
                      name: img?.name,
                    });
                    userContent.push({ type: "image", attachment: ref });
                  } catch (imgErr) {
                    log("warn", "chat image skip: " + (imgErr instanceof Error ? imgErr.message : String(imgErr)));
                  }
                }
              } catch (e) {
                log("error", "chat image upload failed: " + (e instanceof Error ? e.message : String(e)));
              }
            }
            agent.followup(
              createUserMessage({
                content: userContent,
                source: { kind: "user" },
              })
            );
            await agent.whenIdle();
            // 自动学习：本轮用户消息含明确"规则/经验"信号时，LLM 提炼并追加到
            // 工作区学习文件（异步、静默，不阻塞 chatDone；失败不影响对话）
            void maybeLearnFromTurn(ctx, agent, text).catch(() => {});
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
            pendingSessionId = null; // 用户主动新建：作废轮转预建的下一会话 id
            clearOwnLock(); // 释放旧会话锁（即将不再持有任何会话）
            if (handle !== undefined) {
              await handle.dispose();
              handle = undefined;
              agent = undefined;
              resetStepBudget = null;
            }
            // 惰性：新会话也等第一条消息才真正创建
            // 同步清空旧 selection：恢复预览的会话可能持有与默认选择不同的
            // provider/model（如 zai-free），不清空会让 getModelInfo 在
            // "新会话"下继续显示旧会话的模型（与 deleteSession 分支一致）。
            selection = null;
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
              // 方案 B：live 标记由宿主补标（当前主代理会话）
              if (agent !== undefined) {
                for (const s of list) s.live = s.id === agent.session.id;
              }
              post({ t: "sessions", list });
            } catch (error) {
              log("error", "listSessions failed", error instanceof Error ? error.message : String(error));
              post({ t: "sessions", list: [], error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "restorePreview": {
            // 恢复预览（Reload 自动恢复，owner 方案）：**① 只读分页秒显历史 →
            // ② 立即继续 resumeAgent**（不等用户发消息）。
            //  - 历史秒显：persistence.inspect 只读（不建 agent），最近 limit 条立即下发；
            //  - agent 就绪：inspect 后立即 resumeAgent——与 inspect 共享 prepared 缓存
            //    （SessionPreparations，一次加载），**不重复解压**；用户读历史+输入期间
            //    agent 已就绪，首条消息零等待；
            //  - 模型还原：resumeAgent 用会话 meta 的 provider/model → ready 帧后
            //    前端模型下拉恢复为该会话模型（不再显示全局默认）。
            if (typeof msg.id !== "string" || msg.id.trim() === "") break;
            try {
              // 【0.1.5 兼容】不得再用 persistence.inspect（0.1.5 已移除）：用
              // inspectStoredSession 跨版本只读读取，否则 0.1.5 下这里静默跳过 →
              // 不发 history 帧 → 面板消息列表清空 / 统计归零（标题与文件大小仍在）。
              const inspected = await inspectStoredSession(ctx, msg.id);
              const events = (inspected.events ?? []).filter(
                (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
              );
              const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
              const tail = events.slice(-limit);
              const hasMore = events.length > tail.length;
              const nextSeq = hasMore ? tail[0].seq : undefined;
              // 统计：meta.stats 直读（合理则用，零遍历）；无/异常则全量算并落盘
              const stats = resolveSessionStats(getSessionMeta(msg.id).stats, events, msg.id);
              // sessionBytes：宿主已知道内核实际使用的日志（pickSessionLog 取最近写入），
              // 前端标题栏据此显示 KB。
              post({ t: "history", sessionId: msg.id, events: tail, hasMore, nextSeq, stats, sessionBytes: sessionFileSize(msg.id) });
            } catch (error) {
              log("warn", "restorePreview preview failed", error instanceof Error ? error.message : String(error));
              // 预览失败帧：前端据此解锁（否则卡"正在恢复"直到 15s 兜底）
              post({ t: "viewSessionFailed", id: msg.id, error: error instanceof Error ? error.message : String(error) });
              break;
            }
            // ② 立即继续 resumeAgent（历史已秒显；复用 inspect 的 prepared 缓存）
            try {
              // 会话占用锁：自动恢复同样受"他实例活着持有"保护（防并发双写）。
              const lock = acquireSessionLock(msg.id);
              if (!lock.ok && lock.busy) {
                log("warn", `restorePreview denied: session busy by pid ${lock.holderPid}`);
                post({
                  t: "hint",
                  text: L(
                    `该会话正被另一 VS Code 实例（进程 ${lock.holderPid}）使用中，未自动恢复。`,
                    `This session is in use by another VS Code instance (pid ${lock.holderPid}); not auto-resumed.`
                  ),
                });
                post({ t: "sessionResumed", id: msg.id, ok: false, error: "session busy" });
                break;
              }
              const meta = getSessionMeta(msg.id);
              if (handle !== undefined) await handle.dispose();
              const resumed = await resumeAgent(
                ctx,
                msg.id,
                {
                  provider: meta.provider || undefined,
                  // 不把 env.DSH_VSCODE_MODEL 作为 options.model 传入：meta 缺失
                  // 时由 resumeAgent 内部回退到 agentDefaultModel 的持久化默认，
                  // 保证 provider/model 同源（避免 meta.provider=zai-free 却拼上
                  // 扩展配置固定 model 的错配）。
                  model: meta.model || undefined,
                  reasoningEffort: meta.reasoningEffort || undefined,
                },
                pump,
                approvals
              );
              handle = resumed.handle;
              agent = resumed.agent;
              selection = resumed.selection;
              resetStepBudget = resumed.resetStepBudget;
              // 存量目标收尸（G1）：自动恢复同样 pause 遗留 active goal。
              await pauseLegacyActiveGoal(ctx, agent);
              if (meta.workMode === "multi" || meta.workMode === "single") {
                workMode = meta.workMode;
                post({ t: "workModeChanged", mode: workMode });
              }
              // 标题写回内核（session/title 快照一致；非阻塞）
              if (typeof meta.title === "string" && meta.title.trim() !== "") {
                const titleSvc = ctx.get("sessionTitle");
                if (titleSvc !== undefined && typeof titleSvc.rename === "function") {
                  Promise.resolve()
                    .then(() => titleSvc.rename(agent.session, meta.title))
                    .catch((error) => {
                      log("warn", "session title restore failed", error instanceof Error ? error.message : String(error));
                    });
                }
              }
              // ready 帧：前端得知 agent 就绪 + 模型下拉恢复为会话 meta 模型
              post({
                t: "ready",
                sessionId: agent.session.id,
                cwd: process.cwd(),
                provider: agent.options.provider,
                model: agent.options.model,
                version: CORE_VERSION,
                sessionTitle: await currentSessionTitle(ctx, agent),
              });
            } catch (error) {
              log("warn", "restorePreview resume failed", error instanceof Error ? error.message : String(error));
              post({ t: "sessionResumed", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "resumeSession": {
            pendingSessionId = null; // 用户主动恢复：作废轮转预建的下一会话 id
            if (typeof msg.id !== "string" || msg.id.trim() === "") {
              post({ t: "sessionResumed", id: msg.id, ok: false, error: "invalid session id" });
              break;
            }
            // 会话占用锁（2026-09 owner 定）：恢复前先查他实例是否活着持有该会话。
            // pid 存活 → 拒绝（防两实例并发写同一日志——曾写坏会话文件）；pid 已死
            // → stale 自动接管。锁不可用时降级继续，不阻断。
            const lock = acquireSessionLock(msg.id);
            if (!lock.ok && lock.busy) {
              log("warn", `resumeSession denied: session busy by pid ${lock.holderPid}`);
              post({
                t: "sessionResumed",
                id: msg.id,
                ok: false,
                error: L(
                  `该会话正被另一 VS Code 实例（进程 ${lock.holderPid}）使用中，请先关闭那边的窗口或稍后再试。`,
                  `This session is in use by another VS Code instance (pid ${lock.holderPid}). Close that window or retry later.`
                ),
              });
              break;
            }
            // 恢复会话参数：模型/思考级别/workMode 优先取该会话记录的 meta
            const meta = getSessionMeta(msg.id);
            if (handle !== undefined) await handle.dispose();
            // 恢复耗时量化（性能定位：慢在何处，见 docs 2.20）
            const tResume0 = Date.now();
            log("info", `resumeSession start: ${msg.id}`);
            const resumed = await resumeAgent(
              ctx,
              msg.id,
              {
                provider: meta.provider || undefined,
                model: meta.model || msg.model || undefined,
                reasoningEffort: meta.reasoningEffort || undefined,
              },
              pump,
              approvals
            );
            handle = resumed.handle;
            agent = resumed.agent;
            selection = resumed.selection;
            resetStepBudget = resumed.resetStepBudget;
            // 存量目标收尸（G1）：该会话若遗留 active goal（历史自动续跑目标），
            // 宿主直接 pause——插件已排除 goal 自动续跑，恢复即清零，杜绝复活续跑。
            await pauseLegacyActiveGoal(ctx, agent);
            // 恢复工作模式（meta 记录；无则保持当前）
            if (meta.workMode === "multi" || meta.workMode === "single") {
              workMode = meta.workMode;
              post({ t: "workModeChanged", mode: workMode });
            }
            // 用户曾重命名过：把标题写回内核（session/title 事件），
            // 使标题快照与显示一致（即使换机器/重装也保留）。
            // **非阻塞**（fire-and-forget）：不拖慢恢复主链路。
            // 注意：内核 sessionTitle.rename 是**同步方法**（返回标题快照对象，
            // 非 Promise）——直接 .catch 链式调用会 TypeError；统一经
            // Promise.resolve().then() 包装，同步返回值与未来可能的异步
            // 签名均兼容，同步抛错也能被 catch 捕获。
            if (typeof meta.title === "string" && meta.title.trim() !== "") {
              const titleSvc = ctx.get("sessionTitle");
              if (titleSvc !== undefined && typeof titleSvc.rename === "function") {
                Promise.resolve()
                  .then(() => titleSvc.rename(agent.session, meta.title))
                  .catch((error) => {
                    log("warn", "session title restore failed", error instanceof Error ? error.message : String(error));
                  });
              }
            }
            // 重放历史（分页）：首次只取最近 limit 条事件，避免大会话全量传输；
            // 统计直读 meta.stats（旧会话无统计则全量算一次并落盘）。
            // 注意：**单次加载**（只用 resume，不做 readSession 预读）——两阶段
            // 双份全量加载会拖慢 2 倍（Node 单线程下并行无效），已回滚（docs 2.23）。
            const allEvents = sessionEventsOf(agent.session).filter(
              (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
            );
            const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
            const tail = allEvents.slice(-limit);
            const hasMore = allEvents.length > tail.length;
            const nextSeq = hasMore ? tail[0].seq : undefined;
            // 统计：meta.stats 直读（合理则用，零遍历）；无/异常则全量算并落盘
            // （新旧机制平稳转换，docs 2.27）
            const stats = resolveSessionStats(meta.stats, allEvents, agent.session.id);
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
            log(
              "info",
              `resumeSession done: ${msg.id} in ${Date.now() - tResume0}ms (${allEvents.length} events)`
            );
            break;
          }
          case "viewSession": {
            // 只读浏览一个会话（用于子代理会话：不创建 agent、不改全局宿主状态、
            // 不持久化会话 id——仅把历史与统计推给 UI 浏览）。
            if (typeof msg.id !== "string" || msg.id.trim() === "") {
              post({ t: "viewSessionFailed", id: msg.id, error: "invalid session id" });
              break;
            }
            try {
              // **跨版本只读读取（inspectStoredSession）**——≤0.1.1 走 inspect
              // （prepared 缓存共享，重复查看同一会话秒回）；≥0.1.5 走
              // open(id,"read")+read(0)（inspect 已移除，见 inspectStoredSession）。
              const inspected = await inspectStoredSession(ctx, msg.id);
              const events = (inspected.events ?? []).filter(
                (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
              );
              const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
              const tail = events.slice(-limit);
              const hasMore = events.length > tail.length;
              const nextSeq = hasMore ? tail[0].seq : undefined;
              // 统计：meta.stats 直读（合理则用）；无/异常则全量算（只读浏览不落盘，persist=false）
              const stats = resolveSessionStats(getSessionMeta(msg.id).stats, events, msg.id, false);
              post({ t: "history", sessionId: msg.id, events: tail, hasMore, nextSeq, stats });
              post({ t: "viewSession", id: msg.id });
            } catch (error) {
              log("error", "viewSession failed", error instanceof Error ? error.message : String(error));
              post({ t: "viewSessionFailed", id: msg.id, error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "loadMoreHistory": {
            // 向上滚动加载更早历史：已 resume 的 agent（events 在内存中）纯内存分页；
            // 只读浏览模式（viewSession）下 agent 未创建，改从持久化会话读取。
            if (!Number.isFinite(msg.beforeSeq)) {
              post({ t: "historyMore", sessionId: "", events: [], hasMore: false });
              break;
            }
            const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
            if (agent !== undefined) {
              const { older, hasMore } = olderSessionEvents(sessionEventsOf(agent.session), msg.beforeSeq, limit);
              post({
                t: "historyMore",
                sessionId: agent.session.id,
                events: older,
                hasMore,
                nextSeq: hasMore && older.length > 0 ? older[0].seq : undefined,
              });
            } else if (typeof msg.sessionId === "string" && msg.sessionId !== "") {
              try {
                // 跨版本只读读取（inspectStoredSession）：≤0.1.1 复用 inspect 的
                // prepared 缓存；≥0.1.5 走 open(id,"read")+read(0)。避免每次滚动
                // 都独立全量解压（readSession 无缓存复用）。
                const inspected = await inspectStoredSession(ctx, msg.sessionId);
                const { older, hasMore } = olderSessionEvents(inspected.events ?? [], msg.beforeSeq, limit);
                post({
                  t: "historyMore",
                  sessionId: msg.sessionId,
                  events: older,
                  hasMore,
                  nextSeq: hasMore && older.length > 0 ? older[0].seq : undefined,
                });
              } catch (error) {
                log("warn", "view loadMoreHistory failed", error instanceof Error ? error.message : String(error));
                post({ t: "historyMore", sessionId: msg.sessionId, events: [], hasMore: false });
              }
            } else {
              post({ t: "historyMore", sessionId: "", events: [], hasMore: false });
            }
            break;
          }
          case "renameSession": {
            // 重命名会话标题：写入会话 meta（title 覆盖，用户显式重命名优先于
            // 内核自动标题；listSessions 直接读取 meta 展示）。目标是当前 live
            // 会话时顺带写回内核 session/title 事件（标题快照一致）；历史会话
            // 无需临时恢复——"继续"该会话时 resumeSession 会把 meta.title 写回
            // 内核（见 resumeSession 分支），避免这里重复恢复/释放的重操作。
            if (typeof msg.id !== "string" || msg.id.trim() === "") {
              post({ t: "sessionRenamed", id: msg.id, ok: false, error: "invalid session id" });
              break;
            }
            const title = typeof msg.title === "string" ? msg.title.trim() : "";
            if (title === "") {
              post({ t: "sessionRenamed", id: msg.id, ok: false, error: "title must not be empty" });
              break;
            }
            updateSessionMeta(msg.id, { title });
            invalidateSessionsCache(); // 标题变更，列表需刷新
            // 当前 live 会话：顺带写回内核标题快照
            if (agent !== undefined && agent.session.id === msg.id) {
              try {
                const titleSvc = ctx.get("sessionTitle");
                if (titleSvc !== undefined && typeof titleSvc.rename === "function") {
                  await titleSvc.rename(agent.session, title);
                }
              } catch (error) {
                log("warn", "session title write failed", error instanceof Error ? error.message : String(error));
              }
            }
            post({ t: "sessionRenamed", id: msg.id, ok: true, title });
            break;
          }
          case "deleteSession": {
            pendingSessionId = null; // 删除会话：作废轮转预建的下一会话 id
            const result = await deleteSession(ctx, msg.id);
            if (result.ok) invalidateSessionsCache(); // 会话删除，列表需刷新
            if (result.ok && agent !== undefined && agent.session.id === msg.id) {
              // 删除的是当前会话：重置为"待开始"状态（惰性）——
              // 不立即创建新会话，等用户发出第一条消息才真正创建，
              // 避免产生无对话的空会话。
              clearOwnLock(); // 锁文件随会话目录删除；此处清宿主持有指针
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
          case "rotateConfirm": {
            // 用户在前端确认框的选择：确认→继续轮转；拒绝→当天不再检测
            rotateConfirmOk = msg.ok === true;
            rotateConfirmResolve?.();
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
              // let：一致性防御在 provider 无可用模型/查询失败时会回退到 base.provider
              let provider = typeof msg.provider === "string" && msg.provider !== "" ? msg.provider : base.provider;
              let model = typeof msg.model === "string" && msg.model !== "" ? msg.model : base.model;
              // provider/model 一致性防御：model 必须属于该 provider（前端切提供商时
              // 默认选中该 provider 第一模型；此处兜底——若传入的 model 不是该 provider
              // 的模型，自动改用该 provider 模型列表第一项，避免 zai-free+deepseek-v4-flash
              // 这类错配导致"无法查询模型能力"报错）。
              if (model !== "") {
                try {
                  const llm = ctx.get("llm");
                  if (llm !== undefined && typeof llm.listModels === "function") {
                    const listed = await llm.listModels(provider);
                    const ids = listed.map((m) => m.id);
                    if (!ids.includes(model)) {
                      const first = ids[0];
                      if (first !== undefined && first !== "") {
                        log(
                          "warn",
                          L(
                            `模型 ${provider}/${model} 不属于该提供商，已自动改用 ${provider}/${first}`,
                            `model ${provider}/${model} does not belong to provider; auto-switched to ${provider}/${first}`
                          )
                        );
                        model = first;
                      } else {
                        // 该 provider 无任何可用模型：回退到当前默认选择，绝不持久化
                        // 错配组合（如 zai-free+deepseek-v4-flash）。
                        log(
                          "warn",
                          L(
                            `提供商 ${provider} 无可用模型，已回退到 ${base.provider}/${base.model}`,
                            `provider ${provider} has no usable model; reverted to ${base.provider}/${base.model}`
                          )
                        );
                        provider = base.provider;
                        model = base.model;
                      }
                    }
                  }
                } catch (error) {
                  // 能力查询失败：保守回退到当前默认选择（同上方空列表分支）
                  log(
                    "warn",
                    L(
                      `无法校验 ${provider}/${model} 的归属，已回退到 ${base.provider}/${base.model}`,
                      `cannot verify ${provider}/${model}; reverted to ${base.provider}/${base.model}`
                    ),
                    error instanceof Error ? error.message : String(error)
                  );
                  provider = base.provider;
                  model = base.model;
                }
              }
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
              // 记录到当前会话 meta（恢复历史时还原模型/思考级别）
              if (agent !== undefined) {
                updateSessionMeta(agent.session.id, { provider, model, reasoningEffort });
              }
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
            // 记录到当前会话 meta（恢复历史时还原工作模式）
            if (agent !== undefined) {
              updateSessionMeta(agent.session.id, { workMode: mode });
            }
            log("info", `work mode → ${mode}`);
            post({ t: "workModeChanged", mode });
            break;
          }
          case "getModelInfo": {
            try {
              const llm = ctx.get("llm");
              const defaultModel = ctx.get("agentDefaultModel");
              // 可选项 = 配置结果（dshProviders）：提供商与模型都必须先在配置页
              // "已接入 + 已勾选"，才会出现在对话面板；内核目录只用于补元数据（名称/模态），
              // 绝不新增或扩大可选项。
              let providers = dshProviders.map((p) => ({ id: p.id, name: p.name }));
              const providerModels = {};
              let models = [];
              if (dshProviders.length > 0) {
                const merged = new Set();
                for (const p of dshProviders) {
                  // 元数据补齐：仅按**已选中的 id**匹配内核目录，目录里多出来的模型一概忽略。
                  const metaById = new Map();
                  try {
                    if (llm !== undefined && typeof llm.listModels === "function") {
                      const listed = await llm.listModels(p.id);
                      for (const m of Array.isArray(listed) ? listed : []) {
                        if (m && typeof m.id === "string" && m.id !== "") metaById.set(m.id, m);
                      }
                    }
                  } catch {
                    /* 目录不可用：元数据留空，不影响可选集合 */
                  }
                  const entries = (p.models ?? [])
                    .filter((m) => m && typeof m.id === "string" && m.id !== "")
                    .map((m) => {
                      const info = metaById.get(m.id);
                      const e = { id: m.id, name: m.displayName || m.name || info?.name || m.id };
                      // 模态信息：配置里编辑过的值优先，未编辑则取内核目录的元数据
                      const mods = Array.isArray(m.inputModalities) ? m.inputModalities : info?.inputModalities;
                      if (Array.isArray(mods) && mods.length > 0) e.inputModalities = mods;
                      return e;
                    });
                  providerModels[p.id] = entries;
                  for (const e of entries) merged.add(e.id);
                }
                models = [...merged];
              } else {
                // 配置尚未同步到宿主（刚启动 / ready 竞态）：回退到内核已注册路由，
                // 保证面板不空；扩展侧在 ready 后会立刻重新同步 dshProviders。
                if (llm !== undefined && typeof llm.listProviders === "function") {
                  providers = llm
                    .listProviders()
                    .map((p) => ({ id: p.id, name: p.id === "deepseek-official" ? "DeepSeek (Official)" : (p.name ?? p.id) }));
                }
                if (llm !== undefined && typeof llm.listModels === "function" && providers.length > 0) {
                  const merged = new Set();
                  for (const p of providers) {
                    try {
                      const listed = await llm.listModels(p.id);
                      const entries = listed.map((m) => {
                        const e = { id: m.id, name: m.name || m.id };
                        if (Array.isArray(m.inputModalities)) e.inputModalities = m.inputModalities;
                        return e;
                      });
                      providerModels[p.id] = entries;
                      for (const e of entries) merged.add(e.id);
                    } catch {
                      providerModels[p.id] = [];
                    }
                  }
                  models = [...merged];
                }
              }
              if (models.length === 0 && dshProviders.length === 0) {
                // 末级兜底：**只**在"配置尚未同步到宿主"时生效，保证下拉能选回当前模型；
                // 配置已存在时严格以 dshProviders 为准（未配置 = 不可选）。
                const cur = defaultModel?.currentSelection?.();
                const extra = new Set(cur?.model ? [cur.model] : []);
                if (extra.size > 0) models = [...extra];
                if (providers.length === 0 && extra.size > 0) {
                  providers = [{ id: cur.provider || "deepseek-official", name: cur.provider === "deepseek-official" ? "DeepSeek (Official)" : (cur.provider || "deepseek-official") }];
                  providerModels[providers[0].id] = [...extra].map((id) => ({ id, name: id }));
                }
              }
              // 当前选择：优先取当前 agent 的会话级选择（恢复历史会话后应反映
              // 该会话记忆的模型/思考级别），未创建 agent 时才回退全局默认。
              const current =
                selection !== null && selection.provider && selection.model
                  ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
                  : (defaultModel?.currentSelection?.() ?? { provider: "", model: "" });
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
                providerModels,
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
          case "llmProviders": {
            // 配置面板：提供商目录 = llm-pi-ai 的注册/可配置目录 ∪ 已注册路由（含
            // llm-deepseek 的 deepseek-official），供 Provider ID 下拉。两个并列路由的
            // 提供商都进候选：pi-ai 的 `deepseek`（OpenAI 兼容知名条目）与官方路由
            // `deepseek-official` 同时出现，靠显示名区分（后者统一显示 DeepSeek (Official)）；
            // "已接入的 id 不再出现在候选"由面板侧过滤（config-panel.js applyCatalogRef）。
            try {
              const llm = ctx.get("llm");
              const skip = () => false;
              // pi-ai 内置目录：提供真实提供商名称与公开 baseUrl（供面板自动填写）
              const catalogNames = new Map();
              const catalogBaseUrls = new Map();
              try {
                for (const p of builtinProviders()) {
                  if (p.name) catalogNames.set(p.id, p.name);
                  if (p.baseUrl) catalogBaseUrls.set(p.id, p.baseUrl);
                }
              } catch {
                // catalog 读取失败不影响目录（名称/地址回退到 id/手填）
              }
              const providers = [];
              if (llm && typeof llm.listProviders === "function") {
                for (const p of llm.listProviders()) {
                  if (!skip(p.id)) providers.push({ id: p.id, name: p.id === "deepseek-official" ? "DeepSeek (Official)" : (p.name ?? p.id), baseUrl: catalogBaseUrls.get(p.id) });
                }
              }
              if (llm && typeof llm.listConfigurableProviders === "function") {
                for (const p of llm.listConfigurableProviders()) {
                  if (p && p.provider && !skip(p.provider) && !providers.some((x) => x.id === p.provider)) {
                    providers.push({
                      id: p.provider,
                      name: catalogNames.get(p.provider) || p.displayName || p.provider,
                      baseUrl: catalogBaseUrls.get(p.provider),
                    });
                  }
                }
              }
              // Ollama 与 DeepSeek (Official) 同规则：两者都是**默认已配置的种子项**，
              // 默认被面板的"已接入跳过"挡在候选之外；**删除后**才会回到候选列表供重新
              // 选中与配置。区别只在数据来源——official 由内核路由目录提供，Ollama 是本地
              // 提供商，内核目录通常没有它，故在此补齐候选条目（保证删除后仍能加回）。
              if (!providers.some((x) => x.id === "ollama")) {
                providers.push({ id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1" });
              }
              post({ t: "llmProviders", id: msg.id, providers });
            } catch (error) {
              log("error", "listProviders failed", error instanceof Error ? error.message : String(error));
              post({ t: "llmProviders", id: msg.id, providers: [] });
            }
            break;
          }
          case "discoverModels": {
            // 模型发现：优先走 llm-pi-ai 的注册发现——catalog 提供商免网络返回模型+元数据
            // （contextWindow/maxTokens）；未知提供商用 baseURL/apiKey 探活端点。
            // 失败回退扩展侧 OpenAI /models 查询（仅 id）。
            try {
              const llm = ctx.get("llm");
              // 官方路由（llm-deepseek）的模型目录只在内核里，且它刻意不写入 llm-pi-ai
              // （双注册会冲突），因此不能用 pi-ai 发现——必须直接读内核目录。
              // 0.1.5 起该目录新增 `deepseek-flash`（唯一默认声明 systemPromptUpdate:
              // in-history 的条目），旧版只有 v4 系列；一律以内核返回为准，不写死清单。
              if (msg.provider === "deepseek-official" && llm && typeof llm.listModels === "function") {
                // 单模型默认容量（**按需查询**）：配置页只在"打开尚未配置过的模型编辑窗口"
                // 时才带 model 调用——列表查询保持轻量，避免对整份目录做无用功。
                if (typeof msg.model === "string" && msg.model !== "") {
                  let contextWindow;
                  let maxTokens;
                  if (typeof llm.resolveModelInfo === "function") {
                    try {
                      const info = await llm.resolveModelInfo(msg.provider, msg.model, undefined);
                      const ctxWin = info?.context?.contextWindow;
                      if (typeof ctxWin === "number") contextWindow = ctxWin;
                      if (typeof info?.defaultMaxTokens === "number") maxTokens = info.defaultMaxTokens;
                    } catch {
                      /* 该模型无精确元数据：留空，由配置页按"可选"处理 */
                    }
                  }
                  post({ t: "discoveredModels", id: msg.id, models: [{ id: msg.model, contextWindow, maxTokens }] });
                  break;
                }
                const listed = await llm.listModels(msg.provider);
                // 列表只回目录事实（id/name/模态）：容量不在此处逐个查询。
                const models = (Array.isArray(listed) ? listed : [])
                  .filter((m) => m && typeof m.id === "string" && m.id !== "")
                  .map((m) => {
                    const entry = { id: m.id, name: m.name || m.id };
                    if (Array.isArray(m.inputModalities)) entry.inputModalities = m.inputModalities;
                    if (typeof m.contextWindow === "number") entry.contextWindow = m.contextWindow;
                    if (typeof m.maxTokens === "number") entry.maxTokens = m.maxTokens;
                    return entry;
                  });
                post({ t: "discoveredModels", id: msg.id, models });
                break;
              }
              if (llm && typeof llm.discoverModels === "function") {
                const models = await llm.discoverModels("llm-pi-ai", {
                  provider: typeof msg.provider === "string" ? msg.provider : undefined,
                  baseURL: typeof msg.baseURL === "string" && msg.baseURL !== "" ? msg.baseURL : undefined,
                  api: typeof msg.api === "string" && msg.api !== "" ? msg.api : undefined,
                  apiKey: typeof msg.apiKey === "string" && msg.apiKey !== "" ? msg.apiKey : undefined,
                });
                post({ t: "discoveredModels", id: msg.id, models });
              } else {
                post({ t: "discoveredModels", id: msg.id, models: [], error: "llm service unavailable" });
              }
            } catch (error) {
              log("warn", "discoverModels failed", error instanceof Error ? error.message : String(error));
              post({ t: "discoveredModels", id: msg.id, models: [], error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "readAttachment": {
            // 读历史图片附件：attachment ref → base64 图片（本地附件库，不费网络/token）
            try {
              const attach = ctx.get("attachments");
              const ref = msg.ref;
              if (!attach || !ref) {
                post({ t: "attachmentResult", id: msg.id, ok: false, error: "attachment service unavailable" });
                break;
              }
              const stored = await attach.readImage({
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: typeof ref.bytes === "number" ? ref.bytes : 0,
                width: typeof ref.width === "number" ? ref.width : 0,
                height: typeof ref.height === "number" ? ref.height : 0,
              });
              post({
                t: "attachmentResult",
                id: msg.id,
                ok: true,
                mediaType: stored.ref.mediaType,
                data: Buffer.from(stored.data).toString("base64"),
              });
            } catch (error) {
              log("warn", "readAttachment failed", error instanceof Error ? error.message : String(error));
              post({ t: "attachmentResult", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "toolCatalog": {
            // 供配置页"添加规则"：当前可见（经裁剪后）的工具 schema 及其参数字段名。
            // ctx.tools.schemas() 由 dsh-tools 提供（注册表投影出的模型可见工具集）。
            try {
              const tools = ctx.get("tools");
              let schemas = [];
              if (tools && typeof tools.schemas === "function") {
                try {
                  schemas = tools.schemas(agent ?? undefined) ?? [];
                } catch {
                  schemas = [];
                }
              }
              const list = (Array.isArray(schemas) ? schemas : [])
                .map((s) => ({
                  name: typeof s?.name === "string" ? s.name : "",
                  description: typeof s?.description === "string" ? s.description : "",
                  fields:
                    s && s.parameters && typeof s.parameters === "object" && s.parameters.properties && typeof s.parameters.properties === "object"
                      ? Object.keys(s.parameters.properties)
                      : [],
                }))
                .filter((s) => s.name !== "");
              post({ t: "toolCatalog", id: msg.id, tools: list });
            } catch (error) {
              post({ t: "toolCatalog", id: msg.id, tools: [], error: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case "providersApply": {
            // 配置面板保存/删除提供商后，把整套提供商配置同步进 DSH：
            // 1) llm-pi-ai settings（providers dict）→ 适配器目录与路由热更新；
            // 2) API Key 写入 credentials（ref = dsh-vscode:<id>），profile.apiKeyEnv 指向它。
            try {
              const list = Array.isArray(msg.providers) ? msg.providers : [];
              // 配置真源（dshProviders）：含自定义提供商及其"已选中"模型，
              // 也含官方路由 deepseek-official（它不写入 llm-pi-ai，但仍是配置项）。
              // 每次同步都整体替换，保证与配置面板的持久化结果一致。
              dshProviders = list
                .filter((p) => p && typeof p.id === "string" && p.id !== "")
                .map((p) => ({
                  id: p.id,
                  name: p.name || p.id,
                  models: Array.isArray(p.models)
                    ? p.models.map((m) => (typeof m === "string" ? { id: m } : { ...m })).filter((m) => m && m.id)
                    : [],
                }));
              const settings = ctx.get("settings");
              const credentials = ctx.get("credentials");
              const section = { providers: {} };
              const parseTokens = (v) => {
                if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
                const m = String(v ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
                if (!m) return undefined;
                const mult = m[2].toLowerCase() === "k" ? 1024 : m[2].toLowerCase() === "m" ? 1024 * 1024 : 1;
                return Math.round(parseFloat(m[1]) * mult);
              };
              for (const p of list) {
                if (!p || !p.id) continue;
                // deepseek-official 是 llm-deepseek 的官方路由（双注册会冲突），不写入 llm-pi-ai；
                // 其余提供商（含 deepseek——pi-ai 目录的 OpenAI 兼容知名条目）统一走 llm-pi-ai。
                if (p.id === "deepseek-official") continue;
                // credentials ref 必须匹配 /^[A-Za-z_][A-Za-z0-9_]*$/（连字符/冒号非法），
                // 且 provider id 可能含 "-"（zai-free、amazon-bedrock），统一清洗。
                const ref = `dshVscode_${p.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
                const profile = {
                  displayName: p.name || p.id,
                  api: p.protocol || "openai-completions",
                  baseURL: p.baseUrl || undefined,
                };
                // models 只承载"用户选定的模型"：省略该键 = 使用该提供商的完整目录
                // （pi-ai catalog / 探活发现）；显式空数组会被理解为"没有可用模型"，
                // 反而误伤路由，故未选择时不写入。
                if (Array.isArray(p.models) && p.models.length > 0) {
                  profile.models = p.models
                    .map((m) => {
                      const mid = typeof m === "string" ? m : m?.id;
                      if (!mid) return undefined;
                      const out = { id: mid };
                      if (m && typeof m === "object") {
                        if (m.displayName) out.name = m.displayName;
                        const ctxWin = parseTokens(m.contextWindow);
                        if (ctxWin !== undefined) out.contextWindow = ctxWin;
                        const maxTok = parseTokens(m.maxOutput);
                        if (maxTok !== undefined) out.maxTokens = maxTok;
                      }
                      return out;
                    })
                    .filter(Boolean);
                }
                if (typeof p.apiKey === "string" && p.apiKey !== "") {
                  profile.apiKeyEnv = ref;
                  if (credentials) await credentials.set(credentialRef(ref), p.apiKey);
                } else if (credentials) {
                  await credentials.unset(credentialRef(ref));
                }
                section.providers[p.id] = profile;
              }
              if (settings && typeof settings.replace === "function") {
                await settings.replace("llm-pi-ai", section, undefined);
              }
              // 配置变更：模型能力可能变化，清空思考级别适配缓存（下次请求重新查询/适配）
              effortCapabilityCache.clear();
              effortAdaptedCache.clear();
              // info 级、默认可见：清空缓存是"配置变更"语义，**必须可观测**（不做掩盖）。
              log("info", "[adapt] effort caches cleared (providersApply)");
              post({ t: "providersApplied", id: msg.id, ok: true });
            } catch (error) {
              log("error", "providersApply failed", error instanceof Error ? error.message : String(error));
              post({ t: "providersApplied", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
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
                // 压缩完成：只更新**上下文占比**并推送前端（token/轮次是历史
                // 累计，压缩不触碰）；**不读写 meta.stats 的迁移/落盘**——stats
                // 的持久化由加载/恢复机制负责，压缩无需关心；若无现有累计
                // （新会话未迁移）则跳过推送，下次真实请求自动刷新占比。
                try {
                  const currentStats = getSessionMeta(agent.session.id).stats;
                  if (currentStats && Number.isFinite(currentStats.lastSeq)) {
                    const adjusted = { ...currentStats };
                    if (Number.isFinite(adjusted.lastRequestInput) && adjusted.lastRequestInput > 0 && result.shadowedTokenCount > 0) {
                      adjusted.lastRequestInput = Math.max(0, adjusted.lastRequestInput - result.shadowedTokenCount);
                    }
                    post({ t: "stats", stats: adjusted });
                  }
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
            pendingSessionId = null;
            await shutdown(0);
            break;
          }
          default:
            log("warn", "unknown frame type", msg.t);
        }
      } catch (error) {
        log("error", "frame handling failed", error instanceof Error ? error.stack ?? error.message : String(error));
        const message = error instanceof Error ? error.message : String(error);
        // 按帧类型补发**对应**失败 ack（否则扩展/UI 会等错类型或永久等待）
        const id = msg.id;
        switch (msg.t) {
          case "resumeSession":
            post({ t: "sessionResumed", id, ok: false, error: message });
            break;
          case "deleteSession":
            post({ t: "sessionDeleted", id, ok: false, error: message });
            break;
          case "renameSession":
            post({ t: "sessionRenamed", id, ok: false, error: message });
            break;
          case "exportSession":
            post({ t: "sessionExported", id, ok: false, error: message });
            break;
          case "compact":
            post({ t: "compactDone", id, ok: false, error: message });
            break;
          case "loadMoreHistory":
            post({ t: "historyMore", sessionId: typeof msg.sessionId === "string" ? msg.sessionId : "", events: [], hasMore: false });
            break;
          case "restorePreview":
          case "viewSession":
            post({ t: "viewSessionFailed", id: msg.id, error: message });
            break;
          case "chat":
            post({ t: "chatDone", id, ok: false, error: message });
            break;
          case "readAttachment":
            post({ t: "attachmentResult", id, ok: false });
            break;
          case "discoverModels":
            post({ t: "discoveredModels", id, models: [], error: message });
            break;
          case "llmProviders":
            post({ t: "llmProviders", id, providers: [] });
            break;
          case "toolCatalog":
            post({ t: "toolCatalog", id, tools: [], error: message });
            break;
          case "providersApply":
            post({ t: "providersApplied", id, ok: false, error: message });
            break;
          default:
            // 无明确 ack 的帧（newSession/stop/setModel 等）：不补发，避免错帧
            break;
        }
      }
  }

  rl.on("close", () => void shutdown(0));
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
