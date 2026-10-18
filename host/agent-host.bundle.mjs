#!/usr/bin/env node

// host/agent-host.mjs
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
for (const ev of ["end", "close"]) process.stdin.on(ev, () => process.exit(0));
process.on("disconnect", () => process.exit(0));
function envFlag(name) {
  return String(process.env[name] ?? "0") !== "0";
}
var NAME = "dsh-vscode-host";
var CORE_VERSION = "0.6.0";
var SESSION_PREFIX = "dsh-vscode-";
var workMode = "single";
var defaultSelection;
var hostDefaultSelection = () => defaultSelection;
var dshProviders = [];
var getWorkMode = () => workMode;
function post(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}
function log(level, message, extra) {
  const line = extra === void 0 ? message : `${message} ${JSON.stringify(extra)}`;
  process.stderr.write(`[${level}] ${line}
`);
}
function bundlePatchFile(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}
function personaPrefixSince(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!m) return false;
  const ma = Number(m[1]);
  const mi = Number(m[2]);
  const pa = Number(m[3]);
  if (ma > 0) return true;
  if (mi > 1) return true;
  if (mi < 1) return false;
  return pa >= 5;
}
function detectPersonaPrefixField() {
  try {
    const pkgPath = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-system-prompt/package.json"));
    const ver = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (typeof ver === "string" && /^(\d+)\.(\d+)\.(\d+)/.test(ver)) {
      return personaPrefixSince(ver);
    }
  } catch {
  }
  for (const spec of [
    "@deepseek-ai/dsh-system-prompt/lib/index.js",
    "@deepseek-ai/dsh-system-prompt/package.json"
  ]) {
    let resolved;
    try {
      resolved = fileURLToPath(import.meta.resolve(spec));
    } catch {
      continue;
    }
    try {
      if (spec.endsWith("package.json")) {
        const dir = dirname(resolved);
        for (const rel of ["lib/index.js", "dist/index.js", "lib/types/index.js"]) {
          const f = join(dir, rel);
          if (existsSync(f) && readFileSync(f, "utf8").includes("personaPrefix")) return true;
        }
        continue;
      }
      if (readFileSync(resolved, "utf8").includes("personaPrefix")) return true;
    } catch {
    }
  }
  return false;
}
var DSH_PERSONA_PREFIX_SUPPORTED = detectPersonaPrefixField();
function composePatches(env) {
  const envValue = (name) => typeof env?.get === "function" ? env.get(name)?.value : env?.[name];
  const base = loadOverlayPatches(NAME, bundlePatchFile("@deepseek-ai/dsh-base/cordis.patch.yml"));
  const headless = loadOverlayPatches(NAME, bundlePatchFile("@deepseek-ai/dsh-headless/cordis.patch.yml"));
  const filteredHeadless = [];
  for (const entry of headless) {
    if (entry.id === "system-prompt" || entry.id === "tools" || entry.id === "hmr") {
      filteredHeadless.push(entry);
      continue;
    }
    if (entry.insert !== void 0) {
      const kept = entry.insert.filter(
        (row) => row.id !== "headless-startup" && row.id !== "headless-runner"
      );
      if (kept.length > 0) filteredHeadless.push({ insert: kept });
      continue;
    }
  }
  const currentCwd = process.cwd();
  const personaText = `You are a coding agent powered by the {{model}} model, running inside the DeepSeek Harness VS Code extension. Your working directory is ${currentCwd} \u2014 the user's current workspace. Use this directory for all file operations and command workdirs. Help with coding tasks: read and edit files, run commands, search the web, and orchestrate subagents and workflows. File edits you make appear live in the editor. Plan before large changes; prefer the plan-mode workflow for ambiguous or big tasks. Work is driven turn by turn by the user: a long-running task that cannot be finished within one turn must end with a clear summary of progress and next steps, waiting for the user's next instruction. Tool calls, approvals, and todos are shown to the user in real time; keep them informed and concise. Permissions: operations outside the workspace are denied by the sandbox by default. When a task genuinely needs wider access (e.g. reading or writing files outside the workspace, or system-level commands), you may request a one-time escalation by passing \`sandbox_permissions\` (the narrowest wider mode that suffices, e.g. "danger-full-access") together with a clear \`justification\` to the file/command tools and parameters in detail \u2014 the user is then prompted to approve or deny in the UI. Do not request escalation casually; prefer working inside the workspace. Encoding: on Windows, command output (PowerShell 5.1 / Python) defaults to the system code page, which garbles non-ASCII text (any language) when captured. When running a command whose output may contain non-ASCII characters, force UTF-8 output: prefix PowerShell commands with \`[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8;\` or run \`chcp 65001 >nul\` first, and for Python set \`$env:PYTHONIOENCODING='utf-8'\` \u2014 otherwise the captured output will be garbled.`;
  let personaSuffixText = "";
  if (DSH_PERSONA_PREFIX_SUPPORTED && envFlag("DSH_ENABLE_CUSTOM")) {
    try {
      personaSuffixText = readFileSync(join(resolveDshHome(), "ay-dsh-custom.md"), "utf8").trim();
    } catch {
    }
  }
  const overlay = [
    {
      id: "system-prompt",
      // 内核字段名适配（patch 为整行替换 config 语义：只提供内核实际支持的键，
      // 误用旧键会被新版 schema 丢弃 → 人设静默失效）。
      config: DSH_PERSONA_PREFIX_SUPPORTED ? { personaPrefix: personaText, ...personaSuffixText ? { personaSuffix: personaSuffixText } : {} } : { persona: personaText }
    },
    { id: "hmr", disabled: true },
    {
      id: "sandbox-policy",
      config: {
        mode: envValue("DSH_PERMISSION_MODE") ?? "workspace-write",
        workspaceRoot: process.cwd()
      }
    },
    // 子代理工具配置（借鉴 dsh web）：整行替换语义，必须携带完整 config。
    // maxDepth = 子代理递归深度上限（内核默认 3）；插件可配置。
    {
      id: "tool-subagent",
      config: {
        provider: "spawn",
        toolName: "subagent",
        backgroundMode: "continuable",
        maxDepth: Number(envValue("DSH_SUBAGENT_MAX_DEPTH")) || 3
      }
    },
    // 独立会话存储：插件会话与 dsh CLI / dsh web 等官方应用的会话完全隔离，
    // 插件的历史列表只包含插件自己的会话。
    {
      id: "session-persistence-jsonl",
      config: {
        root: dshHomePath("sessions-ay-dsh")
      }
    },
    // 上下文自动压缩（compaction-basic）：把扩展侧 VS Code 设置注入内核配置。
    // auto=是否启用，thresholdRatio=触发比例（contextWindow 占比），maxTokens=摘要 token 上限。
    // 值来自 host.ts spawn 时设置的环境变量；配置面板"控制参数"区保存后重启宿主生效。
    {
      id: "compaction-basic",
      config: {
        auto: envValue("DSH_COMPACTION_AUTO") !== "false",
        thresholdRatio: Number(envValue("DSH_COMPACTION_THRESHOLD_RATIO")) || 0.8,
        maxTokens: Number(envValue("DSH_COMPACTION_MAX_TOKENS")) || 8192
      }
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
    // 0.2.x 新增的**独立**遥测行（base 补丁注释明载"config 无法禁用该行；由 launcher
    // patch disabled"）。插件自己组装 patch、不经 launcher ⇒ 必须在此显式禁用，
    // 否则新版遥测默认挂载。旧行 session-telemetry-otel 与它并存，故两者都禁。
    { id: "otel", disabled: true }
    // tool-ralph 决策（owner，2026-10）：**跟随上游消除，不装配**。
    //   0.1.5：base 启用（subagentProvider=spawn, maxRounds=64）；
    //   0.2.0：base 改为 disabled:true；0.2.1：**移出 base**（包仅在 packages/experimental）。
    // 理由：ralph 是"前台 fresh-agent 长跑循环"（一次调用可起数十个子代理、阻塞到结束），
    // 与插件"人工在环、单轮预算、达限即总结等待指令"的定位正面冲突（同 goal 三件套）。
    // 若将来确实需要无人值守长跑，在此追加一行即可恢复：
    //   { id: "tool-ralph", name: "@deepseek-ai/dsh-tool-ralph", config: { subagentProvider: "spawn", maxRounds: 64 } }
  ];
  if (envValue("DSH_ENABLE_GOAL_ROUNDS") !== "1") {
    overlay.push({ id: "goal-round-driver", disabled: true });
    overlay.push({ id: "tool-goal", disabled: true });
    overlay.push({ id: "command-goal", disabled: true });
  }
  const effortDefault = envValue("DSH_REASONING_EFFORT");
  if (effortDefault) {
    overlay.push({
      id: "agent-default-model",
      config: {
        provider: "deepseek-official",
        model: envValue("DSH_VSCODE_MODEL") || "deepseek-flash",
        reasoningEffort: effortDefault
      }
    });
  }
  try {
    const mcpConfigPath = dshHomePath("mcp-servers.json");
    if (existsSync(mcpConfigPath)) {
      const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
      for (const server of servers) {
        if (!server || typeof server !== "object") continue;
        const serverName = typeof server.serverName === "string" ? server.serverName.trim() : "";
        const transport = server.transport;
        if (!serverName || transport !== "stdio" && transport !== "streamable-http") {
          log("warn", "mcp-servers.json: skipped an entry without usable serverName/transport");
          continue;
        }
        overlay.push({
          id: `mcp-client-${serverName}`,
          name: "@deepseek-ai/dsh-mcp-client",
          config: { ...server }
        });
        log("info", `mcp server assembled: ${serverName} (${transport})`);
      }
    }
  } catch (error) {
    log("warn", "mcp-servers.json ignored", error instanceof Error ? error.message : String(error));
  }
  return [...base, ...filteredHeadless, ...overlay];
}
async function currentSessionTitle(ctx, agent) {
  try {
    if (agent === void 0) return void 0;
    const query = ctx.get("sessionQuery");
    if (query === void 0 || typeof query.readTitle !== "function") return void 0;
    const title = await query.readTitle(SessionId(agent.session.id));
    return title?.title ?? void 0;
  } catch {
    return void 0;
  }
}
var HOST_INSTALL_BASE_URL = new URL("../", import.meta.url).href;
function reportKernelSource() {
  let file;
  try {
    file = bundlePatchFile("@deepseek-ai/dsh-base/cordis.patch.yml");
  } catch (error) {
    log("warn", "kernel source probe failed", error instanceof Error ? error.message : String(error));
    return;
  }
  const lower = file.toLowerCase();
  const fromExt = lower.startsWith(fileURLToPath(new URL("../", import.meta.url)).toLowerCase());
  const runtime = (process.env.DSH_RUNTIME_NODE_MODULES || "").replace(/[\\/]+$/, "");
  const fromRuntime = runtime !== "" && lower.startsWith(runtime.toLowerCase());
  const label = fromRuntime ? "adopted runtime closure" : fromExt ? "bundled (VSIX)" : "unexpected location";
  log("info", `kernel source: ${label} \u2014 ${file}`);
  if (!fromExt && !fromRuntime) {
    log(
      "warn",
      "kernel resolved outside the plugin and the adopted runtime: kernel rows will fail to import (boot() anchor not honoured by this dsh-app-boot build?)"
    );
  }
}
async function bootTree() {
  const home = resolveDshHome();
  const profileDir = join(home, "profiles", "dsh-vscode");
  mkdirSync(profileDir, { recursive: true });
  const rootConfig = join(profileDir, "cordis.yml");
  writeFileSync(rootConfig, "# dsh-vscode root \u2014 empty entry list; composed from bundle patches\n[]\n");
  const environment = loadLayeredEnv(NAME);
  reportKernelSource();
  const patches = composePatches(environment);
  const profileContext = {
    name: "dsh-vscode",
    dir: profileDir,
    patchPath: join(profileDir, "cordis.patch.yml"),
    // 本插件不通过 pnpm 安装 profile 插件（闭包随 VSIX 打包），该字段仅作诊断定位。
    installAnchor: process.cwd(),
    cwd: process.cwd(),
    home,
    startedBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED
  };
  const ctx = await boot(NAME, rootConfig, patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    hostCtx.provide("profileContext", profileContext);
  }, HOST_INSTALL_BASE_URL);
  return ctx;
}
var EventPump = class {
  constructor(sizeProvider) {
    this.queue = [];
    this.timer = void 0;
    this.sizeProvider = sizeProvider;
  }
  push(event) {
    this.queue.push(event);
    if (this.timer === void 0) {
      this.timer = setTimeout(() => this.flush(), 16);
    }
  }
  flush() {
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    let sessionBytes;
    try {
      sessionBytes = this.sizeProvider?.();
    } catch {
    }
    post(
      sessionBytes === void 0 ? { t: "events", events: batch } : { t: "events", events: batch, sessionBytes }
    );
  }
};
async function createAgent(ctx, options, pump, approvals) {
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === void 0 || defaultModel === void 0) {
    throw new Error("dsh-vscode-host: core services unavailable (agents/agentDefaultModel)");
  }
  const base = hostDefaultSelection() ?? defaultModel.currentSelection();
  const provider = options.provider ?? base.provider;
  const model = options.model ?? base.model;
  const selection = { provider, model, reasoningEffort: base.reasoningEffort };
  const sessionId = options?.sessionId ?? `dsh-vscode-${randomUUID()}`;
  const handle = await agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd: process.cwd() },
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
    }
  });
  const attached = attachAgent(ctx, handle, pump);
  await handle.agent.whenIdle();
  return { handle, agent: handle.agent, selection, resetStepBudget: attached.resetStepBudget };
}
function reconcilePermissionMode(ctx, session) {
  try {
    const presets = ctx.get("permissionPresets");
    if (presets === void 0 || typeof presets.set !== "function") return;
    const target = presets.defaultPreset;
    if (typeof target !== "string" || target === "" || target === "custom") return;
    const before = typeof presets.current === "function" ? presets.current(session) : void 0;
    presets.set(session, target);
    if (before !== target) {
      log("info", `permission preset reconciled: ${before ?? "?"} \u2192 ${target} (from dshVscode.permissionMode)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "permission preset reconcile failed", message);
    post({
      t: "hint",
      text: L(`\u6743\u9650\u6863\u4F4D\u540C\u6B65\u5931\u8D25\uFF08\u8BBE\u7F6E\u503C\u672A\u751F\u6548\uFF09\uFF1A${message}`, `Failed to apply the configured permission mode: ${message}`)
    });
  }
}
async function resumeAgent(ctx, resumeSessionId, options, pump, approvals) {
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === void 0 || defaultModel === void 0) {
    throw new Error("dsh-vscode-host: core services unavailable (agents/agentDefaultModel)");
  }
  const base = hostDefaultSelection() ?? defaultModel.currentSelection();
  const provider = options.provider ?? base.provider;
  const model = options.model ?? base.model;
  const reasoningEffort = normalizeEffort(typeof options.reasoningEffort === "string" ? options.reasoningEffort : "") ?? base.reasoningEffort;
  const selection = { provider, model, reasoningEffort };
  const handle = await agents.resume({
    resumeSessionId: SessionId(resumeSessionId),
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
    }
  });
  const sessionCwd = handle.agent.session.header?.cwd;
  const currentCwd = process.cwd();
  if (typeof sessionCwd === "string" && sessionCwd !== currentCwd) {
    const note = `[Working directory correction] This session was originally created in "${sessionCwd}", but the current VS Code workspace has changed to "${currentCwd}". From now on, all file operations and command working directories must use "${currentCwd}". Do not keep reading/writing under "${sessionCwd}" unless the user explicitly asks.`;
    handle.agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembled = await next();
      return {
        ...assembled,
        sections: [
          ...assembled.sections ?? [],
          { name: "cwd-correction", text: note }
        ]
      };
    });
    log("info", `session cwd ${sessionCwd} != workspace ${currentCwd}; injected cwd correction`);
  }
  reconcilePermissionMode(ctx, handle.agent.session);
  const attached = attachAgent(ctx, handle, pump);
  await handle.agent.whenIdle();
  return { handle, agent: handle.agent, selection, resetStepBudget: attached.resetStepBudget };
}
function multiAgentSection(env) {
  const maxParallel = Number(env.DSH_MAX_PARALLEL_SUBAGENTS) || 5;
  return {
    name: "work-mode",
    text: `Current work mode: MULTI-AGENT ORCHESTRATION.
For the task at hand: (1) decompose it into independent subtasks; (2) run them in PARALLEL by dispatching subagents with the subagent tools (spawn multiple agents concurrently \u2014 at most ${maxParallel} in parallel, one per subtask, giving each a self-contained prompt); (3) collect their results and synthesize a final answer yourself. Use parallel dispatch whenever subtasks do not depend on each other. Keep the user informed: show each dispatched subagent as it starts and when it returns.`
  };
}
function normalizeEffort(value) {
  if (value === "off" || value === "high" || value === "max") return value;
  if (value === "low") return "high";
  return void 0;
}
var EFFORT_STRENGTH = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
var PANEL_EFFORTS = ["off", "low", "high", "max"];
function adaptEffort(requested, supported) {
  if (!requested) return { value: void 0, adapted: false };
  const list = Array.isArray(supported) ? supported : [];
  if (requested === "off") {
    return list.includes("off") ? { value: "off", adapted: false } : { value: void 0, adapted: true };
  }
  const seq = [...list].filter(Boolean).sort((a, b) => (EFFORT_STRENGTH[a] ?? 0) - (EFFORT_STRENGTH[b] ?? 0));
  if (seq.length === 0) return { value: void 0, adapted: true };
  const pi = PANEL_EFFORTS.indexOf(requested);
  if (pi < 0) return { value: void 0, adapted: true };
  const ti = Math.round(pi * (seq.length - 1) / (PANEL_EFFORTS.length - 1));
  const value = seq[ti];
  return { value, adapted: value !== requested };
}
function applyEffort(request, effort) {
  if (effort === void 0) {
    const { reasoningEffort: _drop, ...rest } = request;
    return rest;
  }
  return { ...request, reasoningEffort: effort };
}
var EFFORT_CACHE_SLOT = "__ayDshVscodeEffortCaches";
var effortCaches = globalThis[EFFORT_CACHE_SLOT] ??= { capability: /* @__PURE__ */ new Map(), adapted: /* @__PURE__ */ new Map() };
var effortCapabilityCache = effortCaches.capability;
var effortAdaptedCache = effortCaches.adapted;
var DEBUG_ADAPT = process.env.DSH_DEBUG_ADAPT === "1";
var UI_LANG = process.env.DSH_LOCALE === "zh" ? "zh" : "en";
var L = (zh, en) => UI_LANG === "zh" ? zh : en;
var userEffortChanged = false;
function languageDirectiveSection() {
  if (UI_LANG === "zh") {
    return {
      name: "language",
      text: "\u3010\u8BED\u8A00\u89C4\u5219\u3011\uFF1A\u8BF7\u59CB\u7EC8\u4F7F\u7528\u7B80\u4F53\u4E2D\u6587\u56DE\u590D\u7528\u6237\uFF0C\u601D\u8003\u8FC7\u7A0B\uFF08reasoning\uFF09\u540C\u6837\u4F7F\u7528\u7B80\u4F53\u4E2D\u6587\u3002\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\u4F7F\u7528\u5176\u4ED6\u8BED\u8A00\u3002"
    };
  }
  return {
    name: "language",
    text: "[Language rule]: Always reply in English, including your reasoning. Use English unless the user explicitly asks for another language."
  };
}
function fmtTitleTime(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function genSubsessionTitle(sessionId) {
  return `subsession_${fmtTitleTime(Date.now())}_${sessionId}`;
}
function genTempTitle(firstInstruction) {
  const head = String(firstInstruction ?? "").trim().replace(/\s+/g, " ").slice(0, 10);
  return `newsession_${fmtTitleTime(Date.now())}_${head}`;
}
function toolBoundarySection() {
  if (UI_LANG === "zh") {
    return {
      name: "tool-boundary",
      text: "\u3010\u5DE5\u5177\u8C03\u7528\u8FB9\u754C\u89C4\u5219\u3011\uFF1A\u5DE5\u5177\u8C03\u7528\u4EC5\u7528\u4E8E**\u6A21\u578B\u63A8\u7406\u6240\u5FC5\u9700**\u7684\u4FE1\u606F\u6536\u96C6\u4E0E\u5206\u6790\uFF08\u8BFB\u6587\u4EF6\u3001\u641C\u7D22\u3001\u6267\u884C\u80FD\u76F4\u63A5\u4EA7\u751F\u63A8\u7406\u4F9D\u636E\u7684\u547D\u4EE4\uFF09\uFF0C\u4E14\u4F18\u5148\u8C03\u7528\u6C99\u7BB1\u5185\u5DE5\u5177\u3002**\u66FF\u7528\u6237\u5B8C\u6210\u7684\u5DE5\u4F5C\u4E0D\u8981\u8C03\u7528\u5DE5\u5177**\u2014\u2014\u4F8B\u5982\u7F16\u8BD1\u3001\u6253\u5305\u3001\u90E8\u7F72\u3001\u6BCF\u8F6E\u7ED3\u5C3E\u7684\u5168\u9762\u5B89\u5168\u68C0\u67E5\u7B49\u91CD\u590D\u6027\u9A8C\u8BC1\u52A8\u4F5C\uFF0C\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\uFF0C\u5426\u5219\u4E0D\u4E3B\u52A8\u6267\u884C\uFF1A\u6539\u4E3A\u5728\u6700\u7EC8\u7B54\u590D\u4E2D\u7ED9\u51FA\u6E05\u6670\u7684\u64CD\u4F5C\u6B65\u9AA4/\u547D\u4EE4\u6E05\u5355\uFF0C\u7531\u7528\u6237\u81EA\u884C\u6267\u884C\uFF1B\u4E5F\u4E0D\u8981\u53D1\u8D77\u4E0D\u5FC5\u8981\u7684\u6743\u9650\u6388\u6743\u8BF7\u6C42\u3002"
    };
  }
  return {
    name: "tool-boundary",
    text: "[Tool-use boundary rule]: use tools ONLY for information gathering and analysis your reasoning requires (reading files, searching, running commands that directly produce reasoning evidence), and prefer in-sandbox tools.Do NOT call tools to do the user's work for them \u2014 e.g. compiling, packaging, deploying, or full security sweeps at the end of every turn. Unless the user explicitly asks, don't perform these yourself: instead give a clear step-by-step command list in your final answer for the user to run. Don't raise unnecessary approval requests either."
  };
}
function stepBudgetSection(limit) {
  if (UI_LANG === "zh") {
    return {
      name: "step-budget",
      text: `\u3010\u6BCF\u8F6E\u5BF9\u8BDD\u601D\u8003\u9884\u7B97\u89C4\u5219\u3011: \u6BCF\u8F6E\u5BF9\u8BDD\uFF08\u4E00\u6761\u7528\u6237\u6D88\u606F\uFF09\u7684\u601D\u8003\u6B65\u6570\u9884\u7B97\u4E3A ${limit} \u6B65\uFF0C\u8BF7\u5728\u6B64\u9884\u7B97\u5185\u89C4\u5212\u5DE5\u4F5C\u8282\u594F\u3002\u8BF7\u5168\u529B\u53D1\u6325\u80FD\u529B\uFF0C\u4EE5**\u6700\u5C11\u7684\u6B65\u6570**\u5B9E\u73B0\u6700\u597D\u7684\u89E3\u51B3\u6548\u679C\uFF0C\u63D0\u9AD8\u6548\u7387\u3001\u8282\u7701 tokens\u3002\u6548\u7387\u8981\u70B9\uFF1A\u52A8\u624B\u524D\u5148\u7B80\u8FF0\u4F60\u7684\u8BA1\u5212\u4E0E\u9884\u4F30\u6B65\u6570\uFF08\u5199\u5728\u56DE\u590D\u6587\u672C\u4E2D\uFF0C\u4E0D\u6D88\u8017\u5DE5\u5177\u6B65\u6570\uFF09\uFF0C\u6309\u8BA1\u5212\u6267\u884C\u51CF\u5C11\u7ED5\u8DEF\uFF1B\u9700\u8981\u6536\u96C6\u591A\u9879\u4FE1\u606F\u65F6\uFF0C\u5728\u540C\u4E00\u7B54\u590D\u4E2D**\u4E00\u6B21\u53D1\u8D77\u591A\u4E2A\u5DE5\u5177\u8C03\u7528**\uFF08\u5E76\u884C\u6279\u91CF\u6536\u96C6\uFF09\uFF0C\u4E00\u6B21\u6027\u62FF\u56DE\u6240\u6709\u9700\u8981\u7684\u4FE1\u606F\u540E\u518D\u5206\u6790\uFF1B\u4EC5\u5F53\u8C03\u7528\u4E4B\u95F4**\u5B58\u5728\u4F9D\u8D56**\u65F6\u624D\u9010\u4E2A\u8FDB\u884C\u3002\u9884\u7B97\u7528\u5C3D\u540E\u5DE5\u5177\u8C03\u7528\u5C06\u88AB\u7981\u7528\uFF0C\u4F60\u5FC5\u987B\u7ACB\u5373\u6536\u5C3E\u603B\u7ED3\uFF08\u8BF4\u660E\u5DF2\u5B8C\u6210/\u672A\u5B8C\u6210/\u4E0B\u4E00\u6B65\u547D\u4EE4\uFF09\uFF0C\u53D1\u51FA\u5E94\u7B54\u5E76\u505C\u6B62\u5DE5\u4F5C\u3002\u672C\u8F6E\u5B9E\u65F6\u8FDB\u5EA6\u7531\u7CFB\u7EDF\u6BCF\u6B65\u901A\u8FC7 [\u672C\u6B65\u6307\u5F15] \u63D0\u4F9B\uFF08\u4E13\u7528\u5B57\u6BB5 STEPS_USED/STEPS_REMAIN/TOOLS_USED/ELAPSED_SEC\uFF09\uFF0C\u8BF7\u5F15\u7528\u5176\u6570\u503C\u3002`
    };
  }
  return {
    name: "step-budget",
    text: `[Per-turn thinking budget rule]: Each turn (one user message) has a thinking-step budget of ${limit} steps. Plan your work to finish within it. Do your best to achieve the best outcome in the FEWEST steps \u2014 be efficient and save tokens. Efficiency guidance: before acting, briefly state your plan and estimated steps in your reply text (costs no tool steps) and follow it to avoid detours; when you need several pieces of information, issue MULTIPLE tool calls in a single reply (parallel batch collection), then analyze once all results are back; go step-by-step only when calls DEPEND on each other. When the budget is exhausted, tool calls are disabled and you must wrap up immediately: deliver a concise final answer (accomplished / unfinished / next command), and then stop working immediately. Real-time progress is provided each step via [Step guide] (named fields STEPS_USED/STEPS_REMAIN/TOOLS_USED/ELAPSED_SEC); quote those values.`
  };
}
function wrapUpReportSection() {
  if (UI_LANG === "zh") {
    return {
      name: "wrap-up-report",
      text: "\u3010\u6536\u5C3E\u62A5\u544A\u89C4\u5219\u3011\uFF08**\u5F3A\u5236\uFF0C\u975E\u53EF\u9009\u9879**\uFF09\uFF1A\u6BCF\u8F6E\u5BF9\u8BDD\uFF08\u5BF9\u5E94\u7528\u6237\u7684\u4E00\u6B21\u8F93\u5165\uFF09\u7684\u6700\u7EC8\u7B54\u590D\u7684**\u7B2C\u4E00\u884C**\u5FC5\u987B\u4EE5\u5982\u4E0B\u683C\u5F0F\u5F00\u5934\uFF1A`\u23F1 \u672C\u8F6E\u7EDF\u8BA1\uFF1ASTEPS_USED \u6B65\u601D\u8003 / TOOLS_USED \u6B21\u5DE5\u5177\u8C03\u7528 / \u8017\u65F6 ELAPSED_SEC \u79D2`\u2014\u2014**STEPS_USED / TOOLS_USED / ELAPSED_SEC \u53D6\u672C\u6B65 [\u672C\u6B65\u6307\u5F15] \u4E2D\u540C\u540D\u4E13\u7528\u5B57\u6BB5\u7684\u503C**\uFF1B\u5982\u679C\u4F60\u672C\u6B65\u8FD8\u8FDB\u884C\u4E86\u5DE5\u5177\u8C03\u7528\uFF0C\u5219 TOOLS_USED \u8FD8\u5FC5\u987B\u52A0\u4E0A\u4F60\u672C\u6B65\u8C03\u7528\u5DE5\u5177\u7684\u6B21\u6570\uFF0CELAPSED_SEC \u5FC5\u987B\u52A0\u4E0A\u4F60\u672C\u6B65\u7684\u8017\u65F6\uFF0C\u968F\u540E\u518D\u5199\u603B\u7ED3\u6B63\u6587\uFF08\u5DF2\u5B8C\u6210/\u672A\u5B8C\u6210/\u4E0B\u4E00\u6B65\u547D\u4EE4\uFF09\u3002"
    };
  }
  return {
    name: "wrap-up-report",
    text: "[Wrap-up report rule] (MANDATORY, not optional): Per turn (one user input) your final answer's FIRST LINE must open with `\u23F1 Stats this turn: STEPS_USED steps / TOOLS_USED tool calls / ELAPSED_SECs elapsed` \u2014 STEPS_USED / TOOLS_USED / ELAPSED_SEC are the values of the SAME NAMED FIELDS in THIS step's [Step guide]; if you issue additional tool calls in this step, ADD them to TOOLS_USED and ADD this step's elapsed time to ELAPSED_SEC, then write the summary body (accomplished / unfinished / next command)."
  };
}
function roundGuideText(perfNoteText) {
  if (UI_LANG === "zh") {
    return `[\u672C\u8F6E\u6307\u5F15] \u5FC5\u987B\u4E25\u683C\u9075\u5B88\u3010\u8BED\u8A00\u89C4\u5219\u3011\u3001\u3010\u5DE5\u5177\u8C03\u7528\u8FB9\u754C\u89C4\u5219\u3011\u3001\u3010\u6BCF\u8F6E\u5BF9\u8BDD\u601D\u8003\u9884\u7B97\u89C4\u5219\u3011\u548C\u3010\u6536\u5C3E\u62A5\u544A\u89C4\u5219\u3011\u3002 ${perfNoteText || "\u672C\u8F6E\u8BF7\u4EE5\u6700\u5C11\u6B65\u6570\u9AD8\u6548\u5B8C\u6210\u4EFB\u52A1\u3002"}`;
  }
  return `[Round guide] Must strictly comply with the [Language rule], [Tool-use boundary rule], [Per-turn thinking budget rule], and [Wrap-up report rule]. ${perfNoteText || "Complete this round efficiently in as few steps as possible."}`;
}
function stepGuideText(limit, steps, tools, elapsed) {
  const remaining = Math.max(0, limit - steps);
  if (UI_LANG === "zh") {
    return `[\u672C\u6B65\u6307\u5F15] STEPS_USED=${steps} / STEPS_REMAIN=${remaining} / TOOLS_USED=${tools} / ELAPSED_SEC=${elapsed}`;
  }
  return `[Step guide] STEPS_USED=${steps} / STEPS_REMAIN=${remaining} / TOOLS_USED=${tools} / ELAPSED_SEC=${elapsed}`;
}
function stepGuidePoints(limit) {
  return new Set(
    [1, Math.ceil(limit / 2), Math.ceil(limit * 3 / 4), limit - 2, limit - 1, limit].filter(
      (point) => point >= 1
    )
  );
}
function shouldInjectStepGuide(limit, stepNumber) {
  return limit > 0 && stepNumber >= 1 && stepGuidePoints(limit).has(stepNumber);
}
function stepLimitDenyReason(count, limit) {
  return UI_LANG === "zh" ? `\u5DE5\u5177\u8C03\u7528\u5DF2\u7981\u7528\u2014\u2014\u672C\u8F6E\u5DF2\u8FBE\u601D\u8003\u6B65\u6570\u4E0A\u9650\uFF08${count}/${limit}\uFF09\u3002\u8BF7\u7ACB\u5373\u505C\u6B62\u5DE5\u4F5C\u5E76\u7ED9\u51FA\u6700\u7EC8\u7B54\u590D\u3002` : `Tool calls are disabled \u2014 this turn reached its step limit (${count}/${limit}). Stop working and deliver your final summary now.`;
}
function stepLimitWrapUpMessage(limit, steps, tools, elapsedSec) {
  if (UI_LANG === "zh") {
    return `[\u8FBE\u9650\u8B66\u793A] \u672C\u8F6E\u601D\u8003\u6B65\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF08${steps}/${limit}\uFF09\uFF0C\u5DF2\u53D1\u8D77 ${tools} \u6B21\u5DE5\u5177\u8C03\u7528\uFF0C\u672C\u8F6E\u8017\u65F6 ${elapsedSec} \u79D2\uFF0C\u6240\u6709\u5DE5\u5177\u8C03\u7528\u5DF2\u88AB\u7981\u7528\u3002\u5355\u8F6E\u6B65\u6570\u4E0A\u9650\u7528\u4E8E\u63A7\u5236\u5355\u6B21\u8BF7\u6C42\u89C4\u6A21\u3001\u9632\u6B62\u5DE5\u5177\u5FAA\u73AF\u5931\u63A7\uFF0C\u56E0\u6B64\u672C\u8F6E\u5DE5\u4F5C\u5230\u6B64\u4E3A\u6B62\u3002\u8BF7\u7ACB\u5373\u505C\u6B62\u8FDB\u4E00\u6B65\u63A8\u7406\uFF0C\u5728\u672C\u56DE\u590D\u4E2D\u7ED9\u51FA\u6700\u7EC8\u7B54\u590D\uFF0C**\u7B2C\u4E00\u884C**\u5FC5\u987B\u4EE5\u5982\u4E0B\u683C\u5F0F\u5F00\u5934\uFF1A\`\u23F1 \u672C\u8F6E\u7EDF\u8BA1\uFF1ASTEPS_USED \u6B65\u601D\u8003 / TOOLS_USED \u6B21\u5DE5\u5177\u8C03\u7528 / \u8017\u65F6 ELAPSED_SEC \u79D2\`\uFF08\u5176\u4E2D STEPS_USED=${steps}\u3001TOOLS_USED=${tools}\u3001ELAPSED_SEC=${elapsedSec}\uFF0C\u82E5\u672C\u7B54\u590D\u4E2D\u8FD8\u6709\u65B0\u7684\u5DE5\u5177\u8C03\u7528\u548C\u8017\u65F6\u8BF7\u4E00\u5E76\u8BA1\u5165\uFF09\uFF0C\u968F\u540E\u5199\u603B\u7ED3\u6B63\u6587\uFF08\u5DF2\u5B8C\u6210/\u672A\u5B8C\u6210/\u4E0B\u4E00\u6B65\u547D\u4EE4\uFF09\u3002\u8BF7\u52A1\u5FC5\u4E25\u683C\u9075\u5B88\u6B64\u89C4\u5219\uFF01\u9884\u7B97\u5DF2\u8017\u5C3D\uFF0C\u5B8C\u6210\u6536\u5C3E\u603B\u7ED3\u540E\u52A1\u5FC5\u7ACB\u5373\u505C\u6B62\u5DE5\u4F5C\uFF01`;
  }
  return `[Limit warning] This turn's step limit is reached: ${steps}/${limit} steps used, ${tools} tool calls issued, ${elapsedSec}s elapsed \u2014 the thinking budget is exhausted and all tool calls are now disabled. The per-turn step limit keeps each request bounded and prevents runaway tool loops, so continuing further work is not permitted. Stop further reasoning and deliver your final answer in this reply, opening with a first line in this exact format: \`\u23F1 Stats this turn: STEPS_USED steps / TOOLS_USED tool calls / ELAPSED_SECs elapsed\` (STEPS_USED=${steps}, TOOLS_USED=${tools}, ELAPSED_SEC=${elapsedSec}; count any NEW tool calls and time used in this reply too), then the summary body (accomplished / unfinished / next command). Please strictly comply with this rule! Stop working immediately after deliver this response!`;
}
function attachAgent(ctx, handle, pump) {
  const agent = handle.agent;
  pump.sizeProvider = () => agent === void 0 || agent.session === void 0 ? void 0 : sessionFileSize(String(agent.session.id));
  const maxSteps = Number(process.env.DSH_MAX_STEPS);
  const stepLimit = Number.isFinite(maxSteps) ? maxSteps : 100;
  const LIMIT_GRACE_ATTEMPTS = 3;
  let stepCount = 0;
  let stepLimitHit = false;
  let limitDeniedCount = 0;
  let limitAborted = false;
  const abortTurnAfterLimit = (detail) => {
    if (limitAborted) return;
    limitAborted = true;
    log("warn", `turn force-aborted after step limit: ${detail} (${stepCount}/${stepLimit})`);
    post({
      t: "hint",
      text: L(
        `\u5DF2\u8FBE\u6B65\u6570\u4E0A\u9650\uFF08${stepLimit} \u6B65\uFF09\u540E\u6A21\u578B\u4ECD\u672A\u6536\u5C3E\uFF08${detail}\uFF09\uFF0C\u5DF2\u5F3A\u5236\u7EC8\u6B62\u672C\u8F6E\uFF1B\u7ED3\u679C\u53EF\u80FD\u4E0D\u5B8C\u6574\uFF0C\u53EF\u76F4\u63A5\u7EE7\u7EED\u4E0B\u4E00\u8F6E\u3002`,
        `The step limit (${stepLimit}) was reached and the model still would not wrap up (${detail}); the turn was force-stopped. Results may be partial \u2014 just continue in the next turn.`
      )
    });
    try {
      agent.cancel({ kind: "hook", reason: `step limit reached and the turn would not wrap up: ${detail}` });
    } catch (error) {
      log("warn", "force abort failed", error instanceof Error ? error.message : String(error));
    }
  };
  let wrapUpInjected = false;
  let roundGuideInjected = false;
  let toolCallCount = 0;
  let turnStartAt = Date.now();
  const elapsedSec = () => Math.round((Date.now() - turnStartAt) / 1e3);
  const PERF_KEEP = 5;
  const PERF_META_KEY = "perf";
  let perfQueue = [];
  try {
    const saved = getSessionMeta(agent.session.id)[PERF_META_KEY];
    if (Array.isArray(saved)) perfQueue = saved.slice(-PERF_KEEP);
  } catch {
    perfQueue = [];
  }
  const perfNote = () => {
    if (perfQueue.length === 0) return "";
    const rows = perfQueue.map((p, i) => {
      const tools = p.tools ?? 0;
      const batchHint = tools > p.steps ? UI_LANG === "zh" ? "\uFF08\u542B\u5E76\u53D1\u6279\u91CF\uFF09" : " (with parallel batching)" : "";
      return UI_LANG === "zh" ? `\u7B2C${i + 1}\u8F6E\u7528\u4E86 ${p.steps} \u6B65 / ${tools} \u6B21\u5DE5\u5177\u8C03\u7528${batchHint}${p.hitLimit ? "\uFF08\u8FBE\u9650\u672A\u5B8C\u6210\uFF09" : "\uFF08\u9884\u7B97\u5185\u5B8C\u6210\uFF09"}` : `Round ${i + 1}: ${p.steps} steps / ${tools} tool calls${batchHint}${p.hitLimit ? " (hit limit, unfinished)" : " (finished within budget)"}`;
    });
    return UI_LANG === "zh" ? `\u7EE9\u6548\u53C2\u8003\uFF1A\u4F60\u6700\u8FD1\u5B8C\u6210\u7684\u8F6E\u6B21\uFF1A${rows.join("\uFF1B")}\u3002\u9AD8\u6548\u6A21\u5F0F\u901A\u5E38\u5305\u62EC\uFF1A\u4E00\u6B65\u5185\u5E76\u53D1\u591A\u4E2A\u5DE5\u5177\u8C03\u7528\u3001\u51CF\u5C11\u91CD\u590D\u641C\u7D22\u4E0E\u5197\u4F59\u64CD\u4F5C\u3001\u5148\u89C4\u5212\u518D\u52A8\u624B\uFF08\u7B80\u8FF0\u8BA1\u5212\u4E0E\u9884\u4F30\u6B65\u6570\uFF09\u3002\u8BF7\u5EF6\u7EED\u9AD8\u6548\u6A21\u5F0F\uFF0C\u5728\u672C\u8F6E\u9884\u7B97\u5185\u4EE5\u6700\u5C11\u6B65\u6570\u5706\u6EE1\u5B8C\u6210\u4EFB\u52A1\u3002` : `Performance reference: recent rounds: ${rows.join("; ")}. Efficient patterns usually include: batching multiple tool calls in one step, avoiding repeated searches and redundant operations, and planning before acting (state your plan and estimated steps). Keep the efficient patterns and complete this round within budget in as few steps as possible.`;
  };
  let lastLoggedEffort;
  let turnPerfRecorded = false;
  const recordTurnPerf = () => {
    if (turnPerfRecorded) return;
    turnPerfRecorded = true;
    if (!(stepLimit > 0 && stepCount > 0)) return;
    perfQueue.push({ steps: stepCount, tools: toolCallCount, hitLimit: stepLimitHit });
    if (perfQueue.length > PERF_KEEP) perfQueue.shift();
    updateSessionMeta(agent.session.id, { [PERF_META_KEY]: [...perfQueue].slice(-PERF_KEEP) });
  };
  const resetStepBudget = () => {
    recordTurnPerf();
    stepCount = 0;
    stepLimitHit = false;
    limitDeniedCount = 0;
    limitAborted = false;
    wrapUpInjected = false;
    roundGuideInjected = false;
    toolCallCount = 0;
    turnStartAt = Date.now();
    turnPerfRecorded = false;
  };
  agent.ctx.on("agent/turn-stopping", ({ turn }) => {
    try {
      recordTurnPerf();
      const sid = agent.session.id;
      const prev = getSessionMeta(sid).stats;
      const base = prev && Number.isFinite(prev.lastSeq) ? prev : void 0;
      const delta = sessionEventsSince(agent.session, base === void 0 ? 0 : base.lastSeq + 1).filter(
        (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
      );
      const stats = delta.length === 0 && base !== void 0 ? base : computeSessionStats(delta, base);
      post({ t: "stats", stats });
      if (DEBUG_ADAPT) log("info", `turn ${turn} stopped; final stats pushed (lastSeq=${stats.lastSeq ?? 0})`);
    } catch (error) {
      log("warn", "turn-stopping handling failed", error instanceof Error ? error.message : String(error));
    }
  });
  agent.ctx.on("session/event", (_session, event) => {
    if (event.type === "step/start") {
      stepCount++;
      if (!stepLimitHit && stepLimit > 0 && stepCount >= stepLimit) {
        stepLimitHit = true;
        post({ t: "stepLimit", maxSteps: stepLimit, steps: stepCount });
      }
      if (stepLimit > 0 && stepLimitHit && stepCount >= stepLimit + LIMIT_GRACE_ATTEMPTS) {
        abortTurnAfterLimit(`${stepCount - stepLimit} steps past the limit`);
      }
    }
    if (event.type === "plan/mode") {
      post({ t: "planMode", active: event.data?.active === true });
    }
    if (event.type === "session/title" && event.data && typeof event.data.title === "string" && event.data.title.trim() !== "") {
      try {
        const title = event.data.title.trim();
        updateSessionMeta(agent.session.id, { title });
        invalidateSessionsCache();
        post({ t: "sessionTitleSynced", id: agent.session.id, title });
      } catch (error) {
        log("warn", "session title sync to meta failed", error instanceof Error ? error.message : String(error));
      }
    }
    pump.push(event);
  });
  let streamTurn;
  let streamStep;
  agent.ctx.on("agent/assistant-stream", (payload) => {
    try {
      const subject = payload?.agent;
      if (subject !== void 0 && subject !== agent) return;
      const frame = payload?.frame;
      if (frame === void 0 || frame === null) return;
      if (frame.type === "start") {
        streamTurn = frame.turn;
        streamStep = frame.step;
        return;
      }
      if (frame.type !== "chunk") return;
      if (streamTurn === void 0) return;
      pump.push({
        type: "assistant/chunk",
        seq: frame.index ?? 0,
        time: frame.time ?? Date.now(),
        data: { turn: streamTurn, step: streamStep, chunk: frame.chunk }
      });
    } catch (error) {
      log("warn", "assistant stream bridge failed", error instanceof Error ? error.message : String(error));
    }
  });
  agent.ctx.on("session/flush", () => {
    try {
      const sid = agent.session.id;
      const meta = loadSessionMeta();
      const prev = meta[sid]?.stats;
      const base = prev && Number.isFinite(prev.lastSeq) ? prev : void 0;
      const delta = sessionEventsSince(agent.session, base === void 0 ? 0 : base.lastSeq + 1).filter(
        (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
      );
      if (delta.length === 0) return;
      const stats = computeSessionStats(delta, base);
      meta[sid] = { ...meta[sid] ?? {}, stats: { ...stats } };
      saveSessionMeta(meta);
    } catch (error) {
      log("warn", "session stats flush failed", error instanceof Error ? error.message : String(error));
    }
  });
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const sections = [...assembled.sections ?? []];
    sections.push(languageDirectiveSection());
    sections.push(toolBoundarySection());
    if (stepLimit > 0) sections.push(stepBudgetSection(stepLimit));
    sections.push(wrapUpReportSection());
    return { ...assembled, sections };
  });
  agent.ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    let messages = decision.messages ?? [];
    let changed = false;
    const add = (text) => {
      messages = [...messages, createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })];
      changed = true;
    };
    if (stepLimit > 0 && stepLimitHit && !wrapUpInjected) {
      wrapUpInjected = true;
      add(stepLimitWrapUpMessage(stepLimit, stepCount, toolCallCount, elapsedSec()));
      return { ...decision, messages };
    }
    if (!roundGuideInjected) {
      roundGuideInjected = true;
      if (reiterationText) {
        add(`${UI_LANG === "zh" ? "[\u91CD\u7533\u7EAA\u5F8B]" : "[Reiterate rules]"}
${reiterationText}`);
      }
      add(roundGuideText(perfNote()));
    }
    const proposedStep = Number.isFinite(payload?.step) && payload.step >= 1 ? payload.step : stepCount + 1;
    if (shouldInjectStepGuide(stepLimit, proposedStep)) {
      add(stepGuideText(stepLimit, stepCount, toolCallCount, elapsedSec()));
    }
    return changed ? { ...decision, messages } : decision;
  });
  agent.ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec && typeof exec.name === "string" && exec.callId !== void 0 && toolNeedsApprovalArgs(exec.name)) {
      if (pendingApprovalArgs.size >= APPROVE_ARG_CALLID_LIMIT) {
        const oldest = pendingApprovalArgs.keys().next().value;
        if (oldest !== void 0) pendingApprovalArgs.delete(oldest);
      }
      pendingApprovalArgs.set(exec.callId, exec.arguments);
    }
    const gate = await next();
    if (gate.kind === "allow") toolCallCount++;
    if (exec && typeof exec.name === "string") {
      const rule = findAutoApproveRule(exec.name, exec.callId);
      if (rule && rule.action === "deny") {
        log("info", `auto-deny ${exec.name} at pre-execute (${ruleLabel(rule)})`);
        return { kind: "deny", reason: autoApproveDenyReason(exec.name) };
      }
    }
    if (stepLimit > 0 && stepLimitHit && gate.kind === "allow") {
      limitDeniedCount += 1;
      if (limitDeniedCount >= LIMIT_GRACE_ATTEMPTS) {
        abortTurnAfterLimit(`${limitDeniedCount} tool calls attempted past the limit`);
      }
      return {
        kind: "deny",
        reason: stepLimitDenyReason(stepCount, stepLimit)
      };
    }
    return gate;
  });
  agent.ctx.on("tools/result", (exec) => {
    if (exec && exec.callId !== void 0) pendingApprovalArgs.delete(exec.callId);
  });
  agent.ctx.on(
    "agent/request",
    async (_payload, next) => {
      let request = await next();
      if (request && request.provider && request.model && request.reasoningEffort) {
        const cacheKey = `${request.provider}|${request.model}|${request.reasoningEffort}`;
        const cacheHit = effortAdaptedCache.has(cacheKey);
        if (!cacheHit) {
          if (DEBUG_ADAPT) log("debug", `[adapt] ${request.provider}/${request.model} effort=${request.reasoningEffort} cacheHit=false`);
        }
        if (cacheHit) {
          const cached = effortAdaptedCache.get(cacheKey);
          if (cached !== request.reasoningEffort) request = applyEffort(request, cached);
        } else {
          try {
            const llm = ctx.get("llm");
            if (llm !== void 0 && typeof llm.resolveModelInfo === "function") {
              const capKey = `${request.provider}|${request.model}`;
              let supported = effortCapabilityCache.get(capKey);
              if (supported === void 0) {
                const info = await llm.resolveModelInfo(request.provider, request.model);
                supported = (info?.reasoning?.efforts ?? []).map((e) => typeof e === "string" ? e : e?.id).filter(Boolean);
                effortCapabilityCache.set(capKey, supported);
                if (DEBUG_ADAPT) log("debug", `[adapt] capability ${capKey} \u2192 supported=[${supported.join(", ")}]`);
              }
              const from = request.reasoningEffort;
              const { value, adapted } = adaptEffort(from, supported);
              effortAdaptedCache.set(cacheKey, value);
              if (adapted) {
                request = applyEffort(request, value);
                log(
                  "info",
                  L(
                    `\u601D\u8003\u7EA7\u522B\u6309\u8BED\u4E49\u5F3A\u5EA6\u6620\u5C04\uFF1A${request.provider}/${request.model} ${from} \u2192 ${value === void 0 ? "\u4E0D\u4F20\uFF08\u6A21\u578B\u9ED8\u8BA4\uFF09" : value}`,
                    `effort mapped by semantic strength: ${request.provider}/${request.model} ${from} \u2192 ${value === void 0 ? "(omit, model default)" : value}`
                  )
                );
                post({
                  t: "modelAdapted",
                  provider: request.provider,
                  model: request.model,
                  from,
                  to: value ?? ""
                });
              }
            }
          } catch (error) {
            log(
              "warn",
              L(
                `\u53C2\u6570\u9002\u914D\uFF1A\u65E0\u6CD5\u67E5\u8BE2\u6A21\u578B ${request.provider}/${request.model} \u7684\u601D\u8003\u7EA7\u522B\u80FD\u529B\uFF0C\u5DF2\u79FB\u9664\u601D\u8003\u7EA7\u522B\u53C2\u6570\uFF08\u8D70\u6A21\u578B\u9ED8\u8BA4\uFF09`,
                `param adapt: cannot probe effort capability of model ${request.provider}/${request.model}; removed effort (model default)`
              )
            );
            const from = request.reasoningEffort;
            request = applyEffort(request, void 0);
            effortAdaptedCache.set(cacheKey, void 0);
            post({ t: "modelAdapted", provider: request.provider, model: request.model, from, to: "" });
          }
        }
      }
      const actual = request?.reasoningEffort;
      if (actual !== lastLoggedEffort || userEffortChanged) {
        lastLoggedEffort = actual;
        userEffortChanged = false;
        log("info", L(`AI \u5B9E\u9645\u601D\u8003\u7EA7\u522B: ${actual ?? "\uFF08\u672A\u6307\u5B9A\uFF09"}`, `AI actual reasoning effort: ${actual ?? "(unset)"}`));
      }
      return request;
    },
    // prepend：见上方注释——必须排在内核 installModelSelection 之前（外层）
    { prepend: true }
  );
  agent.ctx.on("agent/status", ({ agent: a, status }) => {
    post({ t: "status", status });
  });
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    if (getWorkMode() !== "multi") return assembled;
    return {
      ...assembled,
      sections: [...assembled.sections ?? [], multiAgentSection(process.env)]
    };
  });
  const enableCustom = envFlag("DSH_ENABLE_CUSTOM");
  const enableLearning = envFlag("DSH_ENABLE_LEARNING");
  const enableReiteration = envFlag("DSH_ENABLE_REITERATION");
  const customPrompt = enableCustom ? readTextFile(CUSTOM_PROMPT_FILE) : "";
  const learningText = enableLearning ? readTextFile(LEARNING_FILE) : "";
  const reiterationText = enableReiteration ? readTextFile(REITERATION_FILE) : "";
  agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const sections = [...assembled.sections ?? []];
    const customHandledByPersonaSuffix = DSH_PERSONA_PREFIX_SUPPORTED && customPrompt !== "";
    if (customPrompt && !customHandledByPersonaSuffix) sections.push({ name: "user-custom-prompt", text: customPrompt });
    if (learningText) sections.push({ name: "user-learning", text: `\u4EE5\u4E0B\u662F\u4ECE\u65E2\u5F80\u5BF9\u8BDD\u6C89\u6DC0\u7684\u5DE5\u4F5C\u7ECF\u9A8C\uFF0C\u8BF7\u81EA\u89C9\u9075\u5B88\uFF1A
${learningText}` });
    if (sections.length === (assembled.sections ?? []).length) return assembled;
    return { ...assembled, sections };
  });
  return { resetStepBudget };
}
var SHELL_COMPOSITE_RE = /(&&|\|\||;|\||>|<|`|\$\()/;
var COMMAND_PREFIX_MAX = 200;
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
function normalizeCommandPrefix(raw) {
  const text = String(raw ?? "").trim();
  if (text === "" || text.length > COMMAND_PREFIX_MAX) return void 0;
  if (SHELL_COMPOSITE_RE.test(text)) return void 0;
  const body = text.endsWith("*") ? text.slice(0, -1) : text;
  if (body === "" || body.includes("*")) return void 0;
  return body;
}
function normalizeAutoApproveRules(input) {
  const out = [];
  for (const r of Array.isArray(input) ? input : []) {
    const action = r?.action === "deny" ? "deny" : r?.action === "allow" ? "allow" : void 0;
    if (action === void 0) continue;
    const match = String(r?.match ?? "").trim();
    if (match === "") continue;
    const rule = { match, action };
    if (Array.isArray(r?.commands) && r.commands.length > 0) {
      const prefixes = [];
      for (const c of r.commands) {
        const p = normalizeCommandPrefix(c);
        if (p === void 0) {
          log("warn", `auto-approve rule: illegal command prefix dropped: ${JSON.stringify(c)} (rule ${match})`);
          continue;
        }
        if (!prefixes.includes(p)) prefixes.push(p);
      }
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
var autoApproveRules = loadAutoApproveRules();
function toolNeedsApprovalArgs(toolName) {
  return autoApproveRules.some((r) => r.commands !== void 0 && toolNameMatches(r.match, toolName));
}
var pendingApprovalArgs = /* @__PURE__ */ new Map();
var APPROVE_ARG_CALLID_LIMIT = 512;
function commandOfArgs(args) {
  if (args === null || typeof args !== "object") return void 0;
  const c = args.command;
  return typeof c === "string" ? c : void 0;
}
function ruleMatchesCall(rule, toolName, args) {
  if (!toolNameMatches(rule.match, toolName)) return false;
  if (rule.commands === void 0) return true;
  const command = commandOfArgs(args);
  if (command === void 0) return false;
  if (rule.action === "allow" && SHELL_COMPOSITE_RE.test(command)) return false;
  return rule.commands.some((p) => command.startsWith(p));
}
function findAutoApproveRule(toolName, callId) {
  const args = callId !== void 0 ? pendingApprovalArgs.get(callId) : void 0;
  for (const r of autoApproveRules) {
    if (r.commands !== void 0 && args === void 0) continue;
    if (ruleMatchesCall(r, toolName, args)) return r;
  }
  return void 0;
}
function ruleLabel(rule) {
  return rule.commands === void 0 ? "tool-level" : `commands=[${rule.commands.join(", ")}]`;
}
function autoApproveDenyReason(toolName) {
  return UI_LANG === "zh" ? `\u5DE5\u5177 ${toolName} \u88AB\u6388\u6743\u89C4\u5219\u62D2\u7EDD\uFF08\u914D\u7F6E\u9879 dshVscode.autoApproveRules\uFF09\u3002` : `Tool ${toolName} was denied by an approval rule (dshVscode.autoApproveRules).`;
}
function installApprovalListener(ctx, approvals) {
  ctx.on("approval/request", async (req) => {
    const rule = findAutoApproveRule(req.toolName, req.callId);
    if (rule && rule.action === "allow") {
      log("info", `auto-approve ${req.toolName} (${ruleLabel(rule)})`);
      if (req.callId !== void 0) pendingApprovalArgs.delete(req.callId);
      return "allowed-once";
    }
    if (rule && rule.action === "deny") {
      log("info", `auto-deny ${req.toolName} (${ruleLabel(rule)})`);
      if (req.callId !== void 0) pendingApprovalArgs.delete(req.callId);
      return "rejected";
    }
    const id = approvals.nextId();
    const agent = req.agent;
    const agentId = agent?.session?.id ? String(agent.session.id).slice(-8) : void 0;
    log(
      "info",
      `approval #${id} requested: ${req.toolName}${agentId ? ` (agent \u2026${agentId})` : ""}${req.reason ? ` \u2014 ${req.reason}` : ""}`,
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
        agentId
      });
      entry.timer = setTimeout(() => {
        if (approvals.pending.get(id) === entry) {
          approvals.pending.delete(id);
          resolve("cancelled");
          post({ t: "approvalGone", id });
          log("warn", `approval #${id} timed out (${req.toolName})`);
        }
      }, 12e4);
      if (req.signal !== void 0 && !req.signal.aborted) {
        req.signal.addEventListener(
          "abort",
          () => {
            const pending = approvals.pending.get(id);
            if (pending !== void 0) {
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
var QUESTION_TIMEOUT_MS = 6e5;
function questionError(code, message) {
  return Object.assign(new Error(message), { name: "UserQuestionError", code });
}
function questionView(q) {
  const options = Array.isArray(q?.options) ? q.options.map((o) => ({
    label: String(o?.label ?? ""),
    ...typeof o?.description === "string" ? { description: o.description } : {}
  })).filter((o) => o.label !== "") : void 0;
  const intent = q?.intent && q.intent.kind === "plan-review" && typeof q.intent.approve === "string" ? { kind: "plan-review", approve: q.intent.approve } : void 0;
  return {
    id: String(q?.id ?? ""),
    question: String(q?.question ?? ""),
    ...typeof q?.detail === "string" ? { detail: q.detail } : {},
    ...typeof q?.header === "string" ? { header: q.header } : {},
    ...options !== void 0 && options.length > 0 ? { options } : {},
    ...q?.multiSelect === true ? { multiSelect: true } : {},
    ...intent !== void 0 ? { intent } : {}
  };
}
function normalizeQuestionAnswers(questions, raw) {
  const items = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const q of questions) {
    const hit = items.find((a) => a && String(a.id) === q.id);
    if (hit === void 0) return void 0;
    const allowed = new Set((q.options ?? []).map((o) => o.label));
    const selected = (Array.isArray(hit.selected) ? hit.selected : []).map((s) => String(s)).filter((s) => allowed.has(s));
    const custom = typeof hit.custom === "string" && hit.custom.trim() !== "" ? hit.custom : void 0;
    if (selected.length === 0 && custom === void 0) return void 0;
    if (q.multiSelect !== true && selected.length > 1) return void 0;
    out.push({ id: q.id, selected, ...custom !== void 0 ? { custom } : {} });
  }
  return out;
}
function installQuestionListener(ctx, questions) {
  ctx.on("user-questions/request", async (req) => {
    const items = (Array.isArray(req?.questions) ? req.questions : []).map(questionView).filter((q) => q.id !== "" && q.question !== "");
    if (items.length === 0) throw questionError("ASK_ABORTED", "no answerable question");
    if (req?.signal?.aborted) throw questionError("ASK_ABORTED", "question aborted before it was asked");
    const id = questions.nextId();
    const agent = req?.agent;
    const agentId = agent?.session?.id ? String(agent.session.id).slice(-8) : void 0;
    log("info", `question #${id}: ${items.length} item(s)${items[0]?.intent ? ` intent=${items[0].intent.kind}` : ""}`);
    const outcome = await new Promise((resolve) => {
      const entry = {};
      entry.resolve = resolve;
      entry.settle = (value) => {
        if (questions.pending.get(id) !== entry) return false;
        questions.pending.delete(id);
        clearTimeout(entry.timer);
        resolve(value);
        return true;
      };
      questions.pending.set(id, entry);
      entry.timer = setTimeout(() => {
        if (!entry.settle({ kind: "cancel", code: "ASK_ABORTED", message: "the question timed out with no answer" })) return;
        post({ t: "questionGone", id });
        log("warn", `question #${id} timed out`);
      }, QUESTION_TIMEOUT_MS);
      if (req?.signal !== void 0) {
        req.signal.addEventListener(
          "abort",
          () => {
            if (!entry.settle({ kind: "cancel", code: "ASK_ABORTED", message: "the question was aborted (turn cancelled)" })) return;
            post({ t: "questionGone", id });
          },
          { once: true }
        );
      }
      post({ t: "question", id, questions: items, ...agentId !== void 0 ? { agentId } : {} });
    });
    if (outcome.kind === "cancel") {
      log("info", `question #${id} cancelled (${outcome.code})`);
      throw questionError(outcome.code, outcome.message);
    }
    const answers = normalizeQuestionAnswers(items, outcome.answers);
    if (answers === void 0) {
      log("warn", `question #${id} rejected: malformed or incomplete answer payload`);
      throw questionError("ASK_ABORTED", "the answer did not cover every question with a valid option");
    }
    log("info", `question #${id} answered`);
    return { answers };
  });
}
function jobView(s) {
  return {
    id: String(s?.id ?? ""),
    kind: String(s?.kind ?? ""),
    label: String(s?.label ?? ""),
    status: typeof s?.status === "string" ? s.status : "running",
    ...typeof s?.detail === "string" ? { detail: s.detail } : {},
    startedAt: Number(s?.startedAt) || 0,
    ...Number.isFinite(s?.finishedAt) ? { finishedAt: Number(s.finishedAt) } : {}
  };
}
function migrateLegacySessions() {
  const newRoot = dshHomePath("sessions-ay-dsh");
  mkdirSync(newRoot, { recursive: true });
  const legacyHome = process.env.DSH_LEGACY_HOME || join(osHomedir(), ".dsh");
  const currentHome = resolveDshHome();
  const sources = [];
  if (legacyHome !== currentHome) {
    sources.push(join(legacyHome, "sessions"), join(legacyHome, "sessions-ay-dsh"));
  } else {
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
        if (!sessionName.startsWith(SESSION_PREFIX)) continue;
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
          if (existsSync(to)) continue;
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
var SESSION_META_FILE = "session-meta.json";
function sessionMetaPath() {
  return join(dshHomePath("sessions-ay-dsh"), SESSION_META_FILE);
}
var sessionMetaCache = null;
var sessionMetaCacheAt = 0;
var SESSION_META_CACHE_TTL = 1500;
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
function getSessionMeta(sessionId) {
  return loadSessionMeta()[sessionId] ?? {};
}
function updateSessionMeta(sessionId, patch) {
  if (!sessionId) return;
  const meta = loadSessionMeta();
  meta[sessionId] = { ...meta[sessionId] ?? {}, ...patch };
  saveSessionMeta(meta);
}
function removeSessionMeta(sessionId) {
  const meta = loadSessionMeta();
  if (sessionId in meta) {
    delete meta[sessionId];
    saveSessionMeta(meta);
  }
}
var sessionEventsCache = /* @__PURE__ */ new WeakMap();
function sessionEventReader(session) {
  if (session === void 0 || session === null) return null;
  if (Array.isArray(session.events)) return { kind: "array", events: session.events };
  if (typeof session.snapshotEvents === "function") return { kind: "snapshot" };
  if (typeof session.ownEvents === "function") return { kind: "own" };
  return null;
}
function sessionEventsOf(session) {
  const reader = sessionEventReader(session);
  if (reader === null) return [];
  if (reader.kind === "array") return reader.events;
  if (reader.kind === "own") return session.ownEvents();
  const hit = sessionEventsCache.get(session);
  const now = Date.now();
  if (hit !== void 0 && now - hit.at < 250) return hit.list;
  const list = session.snapshotEvents();
  sessionEventsCache.set(session, { at: now, list });
  return list;
}
async function inspectStoredSession(ctx, sessionId) {
  const id = SessionId(sessionId);
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== void 0 && typeof persistence.inspect === "function") {
    const inspected = await persistence.inspect(id);
    return { meta: inspected.meta, events: inspected.events ?? [] };
  }
  if (persistence !== void 0 && typeof persistence.open === "function") {
    const handle = await persistence.open(id, "read");
    try {
      const result = await handle.read(0);
      return { meta: handle.header, events: result?.events ?? [] };
    } finally {
      try {
        await handle.close();
      } catch {
      }
    }
  }
  const query = ctx.get("sessionQuery");
  if (query !== void 0 && typeof query.readSession === "function") {
    const snapshot = await query.readSession(id);
    return { meta: snapshot.session, events: snapshot.events ?? [] };
  }
  throw new Error("dsh-vscode-host: no session read API available (sessionPersistence.inspect/open, sessionQuery.readSession)");
}
var SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd?)?$/;
function sessionEventsSince(session, fromSeq) {
  const from = Number.isFinite(fromSeq) && fromSeq > 0 ? Math.floor(fromSeq) : 0;
  const reader = sessionEventReader(session);
  if (reader === null) return [];
  if (reader.kind === "array") return from === 0 ? reader.events : reader.events.slice(from);
  if (reader.kind === "own") return session.ownEvents();
  return from === 0 ? session.snapshotEvents() : session.snapshotEvents(from);
}
function olderSessionEvents(events, beforeSeq, limit) {
  const older = [];
  let hasMore = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "assistant/chunk" || e.type === "session/end-seed") continue;
    if ((e.seq ?? 0) >= beforeSeq) continue;
    if (older.length < limit) older.push(e);
    else {
      hasMore = true;
      break;
    }
  }
  older.reverse();
  return { older, hasMore };
}
function sessionLogGeneration(name) {
  const m = SESSION_LOG_RE.exec(name);
  if (m === null) return -1;
  return m[1] === void 0 ? 0 : Number(m[1]);
}
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
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = st.mtimeMs;
      if (mtime > bestMtime || mtime === bestMtime && gen > bestGen) {
        bestMtime = mtime;
        bestGen = gen;
        best = join(dir, name);
      }
    }
  } catch {
  }
  return best;
}
var sessionSizeCache = /* @__PURE__ */ new Map();
var SESSION_SIZE_CACHE_TTL = 1e3;
function sessionFileSize(sessionId) {
  try {
    const key = String(sessionId);
    const now = Date.now();
    const hit = sessionSizeCache.get(key);
    if (hit !== void 0 && now - hit.at < SESSION_SIZE_CACHE_TTL) return hit.size;
    const root = dshHomePath("sessions-ay-dsh");
    let dir = null;
    for (const entry of scanSessionDirs()) {
      if (entry.id === key) {
        dir = dirname(entry.logPath);
        break;
      }
    }
    if (dir === null) dir = join(root, projectKey(process.cwd()), encodeSegment(key));
    let size;
    const logPath = pickSessionLog(dir);
    if (logPath !== null) size = statSync(logPath).size;
    sessionSizeCache.set(key, { at: now, size });
    return size;
  } catch {
  }
  return void 0;
}
function tailConversationText(events, lastUserCount) {
  const userSeqs = [];
  const msgs = [];
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "user/message" && d.source?.kind === "user") userSeqs.push(e.seq);
    if (e.type === "user/message" || e.type === "assistant/message") {
      const content = e.type === "user/message" ? d.content : d.message?.content ?? d.content;
      const text = (content ?? []).map((b) => b.type === "text" ? b.text : "").join("").trim();
      if (text !== "") {
        msgs.push({ seq: e.seq, text: `${e.type === "user/message" ? "\u7528\u6237" : "AI"}\uFF1A${text}` });
      }
    }
  }
  if (userSeqs.length === 0) return "";
  const startSeq = userSeqs[Math.max(0, userSeqs.length - lastUserCount)];
  return msgs.filter((m) => m.seq >= startSeq).map((m) => m.text).join("\n\n");
}
async function summarizeUserMessages(ctx, agent, texts, signal) {
  const llm = ctx.get("llm");
  if (llm === void 0 || typeof llm.stream !== "function" || texts.length === 0) return "";
  const latest = agent.session.requestHeader?.()?.config;
  const target = agent.options?.provider && agent.options?.model ? { provider: agent.options.provider, model: agent.options.model } : latest;
  if (target === void 0) return "";
  const joined = texts.slice(-15e4);
  if (joined.length === 0) return "";
  const instruction = "\u4F60\u662F\u5BF9\u8BDD\u6458\u8981\u52A9\u624B\u3002\u8BF7\u901A\u8BFB\u4EE5\u4E0B\u4F1A\u8BDD\u5185\u5BB9\uFF08\u53EF\u80FD\u662F\u5F88\u957F\u5BF9\u8BDD\u7684\u6700\u8FD1\u90E8\u5206\uFF09\uFF0C\u8F93\u51FA\u8BE5\u4F1A\u8BDD\u7684\u7B80\u660E\u6458\u8981\uFF0C\u8986\u76D6\uFF1A\u6574\u4F53\u4EFB\u52A1\u76EE\u6807\u3001\u5DF2\u5B8C\u6210\u7684\u91CD\u70B9\u5DE5\u4F5C\u3001\u5173\u952E\u51B3\u7B56\u4E0E\u7ED3\u8BBA\u3001\u5F53\u524D\u8FDB\u5EA6\u3001\u5F85\u529E\u4E8B\u9879\u3002\u4E0D\u8981\u590D\u8FF0\u5BF9\u8BDD\u8FC7\u7A0B\uFF0C\u53EA\u8F93\u51FA\u6458\u8981\u6B63\u6587\uFF0C\u63A7\u5236\u5728 500 \u5B57\u4EE5\u5185\u3002\n\n";
  const messages = [
    createUserMessage({
      content: [{ type: "text", text: instruction + joined }],
      source: { kind: "user" }
    })
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
      signal
    })) {
      assembler.push(chunk);
    }
    const text = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
    return text;
  } catch (e) {
    log("warn", "rotate summary llm failed", e instanceof Error ? e.message : String(e));
    return "";
  }
}
var CUSTOM_PROMPT_FILE = join(resolveDshHome(), "ay-dsh-custom.md");
var LEARNING_FILE = join(resolveDshHome(), "ay-dsh-learning.md");
var REITERATION_FILE = join(resolveDshHome(), "ay-dsh-reiteration.md");
function readTextFile(p) {
  try {
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8").trim();
  } catch {
  }
  return "";
}
var LEARNING_SIGNAL_RE = /记住|教训|经验|以后|规则|禁止|不要|千万别|务必|必须|always|never|remember|rule|lesson|do not|don't/i;
var INJECTION_SIGNAL_RE = /忽略|无视|系统提示|system\s*prompt|system\s*message|外泄|泄露|泄漏|leak|exfiltrat|密钥|api\s*key|credential|secret|password/i;
async function maybeLearnFromTurn(ctx, agent, userText) {
  if (String(process.env.DSH_ENABLE_LEARN ?? "0") === "0") return;
  if (typeof userText !== "string" || userText.trim() === "") return;
  if (!LEARNING_SIGNAL_RE.test(userText)) return;
  const llm = ctx.get("llm");
  if (llm === void 0 || typeof llm.stream !== "function") return;
  const latest = agent.session.requestHeader?.()?.config;
  const target = agent.options?.provider && agent.options?.model ? { provider: agent.options.provider, model: agent.options.model } : latest;
  if (target === void 0) return;
  const input = userText.trim().slice(0, 4e3);
  const instruction = "\u4F60\u662F\u7ECF\u9A8C\u63D0\u70BC\u52A9\u624B\u3002\u4E0B\u9762\u662F\u4E00\u8F6E\u5BF9\u8BDD\u4E2D\u7528\u6237\u7684\u53D1\u8A00\uFF08\u53EF\u80FD\u542B\u5C11\u91CF AI \u56DE\u590D\uFF09\u3002\u8BF7\u63D0\u53D6\u7528\u6237**\u660E\u786E\u63D0\u51FA**\u7684\u5DE5\u4F5C\u89C4\u5219\u3001\u504F\u597D\u6216\u5BF9 AI \u884C\u4E3A\u7684\u80AF\u5B9A/\u7EA0\u6B63\uFF0C\u5199\u6210\u4E00\u6761\u7B80\u6D01\u7ECF\u9A8C\u3002\u8981\u6C42\uFF1A1) \u4E00\u6761\u4E00\u884C\uFF0C20~80 \u5B57\uFF0C\u9648\u8FF0\u53E5\uFF1B2) \u53EA\u63D0\u53D6\u660E\u786E\u9648\u8FF0\u7684\u89C4\u5219/\u7ECF\u9A8C\uFF0C\u5FFD\u7565\u95F2\u804A\u4E0E\u4E8B\u5B9E\u95EE\u7B54\uFF1B3) \u82E5\u6CA1\u6709\u4EFB\u4F55\u660E\u786E\u7684\u89C4\u5219\u6216\u7ECF\u9A8C\uFF0C\u53EA\u8F93\u51FA\u7A7A\u5B57\u7B26\u4E32\uFF0C\u4E0D\u8981\u7F16\u9020\u3002\n\n";
  const messages = [
    createUserMessage({
      content: [{ type: "text", text: instruction + input }],
      source: { kind: "user" }
    })
  ];
  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      maxTokens: 200,
      sessionId: agent.session.id,
      signal: new AbortController().signal
    })) {
      assembler.push(chunk);
    }
    const text = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
    if (text.length === 0) return;
    const collapsed = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_>`~|]/g, " ").replace(/\s+/g, " ").trim();
    if (collapsed.length < 20 || collapsed.length > 200) return;
    if (INJECTION_SIGNAL_RE.test(collapsed)) return;
    const clean = collapsed;
    const file = LEARNING_FILE;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (existing.includes(clean)) return;
    if (existing.length > 64 * 1024) return;
    const next = existing.trim() ? `${existing.trim()}

- ${clean}` : `- ${clean}`;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, file);
    log("info", `learned rule: ${clean}`);
  } catch (e) {
    log("warn", "auto-learn llm failed", e instanceof Error ? e.message : String(e));
  }
}
function genOldSessionTitle(mtime, sessionId) {
  return `oldsession_${fmtTitleTime(mtime || Date.now())}_${sessionId}`;
}
function scanSessionDirs() {
  const root = dshHomePath("sessions-ay-dsh");
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
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
      const logPath = pickSessionLog(join(root, p.name, s.name));
      if (logPath === null) continue;
      out.push({ id: s.name, logPath, project: p.name });
    }
  }
  return out;
}
var SESSIONS_CACHE_TTL = 3e3;
var sessionsCache = null;
var sessionsCacheAt = 0;
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
  const currentProject = projectKey(process.cwd());
  const sameProject = process.platform === "win32" ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
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
      }
      title = genOldSessionTitle(mtime, e.id);
      patch[e.id] = { ...meta, title };
    }
    let updatedAt = 0;
    try {
      const st = statSync(e.logPath);
      if (st.mtimeMs > 0) updatedAt = st.mtimeMs;
    } catch {
    }
    result.push({
      id: e.id,
      cwd: e.project,
      // 展示用（projectKey 目录名；不反解，恢复/删除走内核不受影响）
      createdAt: updatedAt || now,
      title,
      updatedAt: updatedAt || now,
      live: false,
      // 调用方按当前 agent 补标
      // 会话类型：主代理（dsh-vscode- 前缀）或子代理（subagent 工具，裸 UUID）
      kind: String(e.id).startsWith(SESSION_PREFIX) ? "main" : "sub",
      // 会话级模型/思考级别/workMode（恢复时还原用；前端可展示）
      provider: meta.provider,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      workMode: meta.workMode
    });
  }
  if (Object.keys(patch).length > 0) {
    for (const [id, v] of Object.entries(patch)) allMeta[id] = v;
    saveSessionMeta(allMeta);
    invalidateSessionsCache();
  }
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  sessionsCache = result;
  sessionsCacheAt = Date.now();
  return result;
}
function computeSessionStats(events, base) {
  const stats = {
    inputTokens: base?.inputTokens ?? 0,
    cacheReadTokens: base?.cacheReadTokens ?? 0,
    outputTokens: base?.outputTokens ?? 0,
    steps: base?.steps ?? 0,
    lastSeq: base?.lastSeq ?? 0
  };
  if (base?.title) stats.title = base.title;
  if (base?.contextWindow) stats.contextWindow = base.contextWindow;
  if (base?.model) stats.model = base.model;
  if (base?.lastRequestInput) stats.lastRequestInput = base.lastRequestInput;
  for (const e of events) {
    if (base !== void 0 && (e.seq ?? 0) <= base.lastSeq) continue;
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
function resolveSessionStats(metaStats, events, sessionId, persist = true) {
  const maxSeq = events.length > 0 ? events[events.length - 1].seq ?? 0 : 0;
  if (metaStats && Number.isFinite(metaStats.lastSeq) && metaStats.lastSeq <= maxSeq) {
    if (metaStats.lastSeq === maxSeq) return metaStats;
    const stats2 = computeSessionStats(events, metaStats);
    if (persist) try {
      const meta = loadSessionMeta();
      meta[sessionId] = { ...meta[sessionId] ?? {}, stats: { ...stats2 } };
      saveSessionMeta(meta);
    } catch (error) {
      log("warn", "session stats persist failed", error instanceof Error ? error.message : String(error));
    }
    return stats2;
  }
  const stats = computeSessionStats(events);
  if (persist) try {
    const meta = loadSessionMeta();
    meta[sessionId] = { ...meta[sessionId] ?? {}, stats: { ...stats } };
    saveSessionMeta(meta);
  } catch (error) {
    log("warn", "session stats persist failed", error instanceof Error ? error.message : String(error));
  }
  return stats;
}
var SESSION_LOCK_NAME = ".host-lock.json";
var currentSessionLock = null;
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
function clearOwnLock() {
  if (currentSessionLock === null) return;
  try {
    rmSync(currentSessionLock.file, { force: true });
  } catch {
  }
  currentSessionLock = null;
}
function acquireSessionLock(sessionId) {
  let dir = null;
  try {
    for (const entry of scanSessionDirs()) {
      if (entry.id === sessionId) {
        dir = dirname(entry.logPath);
        break;
      }
    }
  } catch {
  }
  if (dir === null) dir = sessionDirFor(sessionId);
  const file = join(dir, SESSION_LOCK_NAME);
  if (currentSessionLock !== null && currentSessionLock.file === file) {
    return { ok: true };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
  }
  const payload = JSON.stringify({
    pid: process.pid,
    project: projectKey(process.cwd()),
    acquiredAt: Date.now()
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, payload, { flag: "wx" });
      clearOwnLock();
      currentSessionLock = { file };
      return { ok: true };
    } catch (err) {
      if (err !== null && typeof err === "object" && err.code === "EEXIST") {
        let holder = null;
        try {
          holder = JSON.parse(readFileSync(file, "utf8"));
        } catch {
        }
        if (holder !== null && Number.isInteger(holder.pid) && processAlive(holder.pid)) {
          return { ok: false, busy: true, holderPid: holder.pid };
        }
        try {
          rmSync(file, { force: true });
        } catch {
        }
        continue;
      }
      log("warn", "session lock acquire degraded", err instanceof Error ? err.message : String(err));
      clearOwnLock();
      return { ok: true, degraded: true };
    }
  }
  clearOwnLock();
  return { ok: true, degraded: true };
}
async function pauseLegacyActiveGoal(ctx, agent) {
  try {
    const goals = ctx.get("goals");
    if (goals === void 0 || typeof goals.get !== "function") return;
    const goal = goals.get(agent);
    if (goal === void 0 || goal.phase !== "active") return;
    if (typeof goals.pause !== "function") return;
    const result = goals.pause(agent, { id: goal.id, revision: goal.revision });
    if (result !== void 0 && typeof result.then === "function") await result;
    log("info", `paused legacy active goal (id=${goal.id} rev=${goal.revision}) after session resume`);
    post({
      t: "hint",
      text: L("\u5DF2\u6682\u505C\u8BE5\u4F1A\u8BDD\u9057\u7559\u7684\u81EA\u52A8\u7EED\u8DD1\u76EE\u6807\uFF0C\u53EF\u5B89\u5168\u7EE7\u7EED\u5BF9\u8BDD\u3002", "Paused a legacy auto-continuation goal for this session; safe to continue.")
    });
  } catch (error) {
    log("warn", "pause legacy goal failed", error instanceof Error ? error.message : String(error));
  }
}
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
function isSessionLockedByOther(dir) {
  try {
    const holder = JSON.parse(readFileSync(join(dir, SESSION_LOCK_NAME), "utf8"));
    if (holder !== null && Number.isInteger(holder.pid) && holder.pid !== process.pid && processAlive(holder.pid)) {
      return true;
    }
  } catch {
  }
  return false;
}
async function deleteSession(ctx, sessionId) {
  try {
    let dir = null;
    for (const entry of scanSessionDirs()) {
      if (entry.id === sessionId) {
        dir = dirname(entry.logPath);
        break;
      }
    }
    if (dir === null) {
      const query = ctx.get("sessionQuery");
      const cwd = query !== void 0 ? (await query.readSession(SessionId(sessionId))).session.cwd ?? process.cwd() : process.cwd();
      dir = join(dshHomePath("sessions-ay-dsh"), projectKey(cwd), encodeSegment(sessionId));
    }
    const lockFile = join(dir, SESSION_LOCK_NAME);
    if (currentSessionLock !== null && currentSessionLock.file === lockFile) {
      return { ok: false, error: "\u6B63\u5728\u4F7F\u7528\u7684\u4F1A\u8BDD\u65E0\u6CD5\u5220\u9664\uFF0C\u8BF7\u5148\u5207\u6362\u5230\u5176\u5B83\u4F1A\u8BDD\u6216\u65B0\u5EFA\u4F1A\u8BDD" };
    }
    if (isSessionLockedByOther(dir)) {
      return { ok: false, error: "\u4F1A\u8BDD\u6B63\u88AB\u53E6\u4E00 VS Code \u5B9E\u4F8B\u4F7F\u7528\u4E2D\uFF0C\u65E0\u6CD5\u5220\u9664" };
    }
    if (pickSessionLog(dir) === null) {
      return { ok: false, error: `\u4F1A\u8BDD\u6587\u4EF6\u4E0D\u5B58\u5728: ${dir}` };
    }
    rmSync(dir, { recursive: true, force: true });
    removeSessionMeta(sessionId);
    invalidateSessionsCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function blocksText(content, type = "text") {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && typeof b === "object" && b.type === type).map((b) => b.text ?? "").join("");
}
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
async function exportSession(ctx, sessionId) {
  try {
    const query = ctx.get("sessionQuery");
    if (query === void 0) return { ok: false, error: "sessionQuery unavailable" };
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
  // \u5BFC\u51FA\u9875\u8BED\u8A00\u81EA\u9002\u5E94\uFF08\u6D4F\u89C8\u5668\u8BED\u8A00\uFF09\uFF1Azh \u663E\u793A\u4E2D\u6587\u6807\u7B7E\uFF0C\u5176\u4F59\u663E\u793A\u82F1\u6587
  const zh = (navigator.language || "").toLowerCase().startsWith("zh");
  const L = {
    user: zh ? "\u7528\u6237" : "User",
    assistant: zh ? "\u52A9\u624B" : "Assistant",
    session: zh ? "\u4F1A\u8BDD" : "Session",
    sessionId: zh ? "\u4F1A\u8BDD ID" : "Session ID",
    created: zh ? "\u521B\u5EFA\u65F6\u95F4" : "Created",
    workdir: zh ? "\u5DE5\u4F5C\u76EE\u5F55" : "Working directory",
    thinking: (n) => zh ? "\u601D\u8003\u8FC7\u7A0B\uFF08" + n + " \u5B57\uFF0C\u70B9\u51FB\u5C55\u5F00\uFF09" : "Thinking (" + n + " chars, click to expand)",
    result: zh ? "\u7ED3\u679C" : "Result",
    failed: zh ? "\uFF08\u5931\u8D25\uFF09" : " (failed)",
  };
  document.documentElement.lang = zh ? "zh-CN" : "en";
  document.getElementById("h1").textContent = L.session + "\uFF1A" + document.getElementById("h1").textContent;
  document.querySelectorAll(".role-user").forEach((e) => e.textContent = "\u{1F464} " + L.user);
  document.querySelectorAll(".role-assistant").forEach((e) => e.textContent = "\u{1F916} " + L.assistant);
  document.querySelectorAll(".reasoning summary").forEach((e) => {
    const n = e.getAttribute("data-len") || "";
    e.textContent = L.thinking(n);
  });
  document.querySelectorAll(".tool-result-label").forEach((e) => {
    e.textContent = L.result + (e.getAttribute("data-error") === "1" ? L.failed : "") + "\uFF1A";
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
<div id="meta" class="meta">SESSION_ID\uFF1A${escHtml(sessionId)}<br>CREATED\uFF1A${escHtml(created)}<br>WORKDIR\uFF1A${escHtml(snap.session.cwd ?? "")}</div>`);
    const body = [];
    const pendingCalls = /* @__PURE__ */ new Map();
    for (const e of events) {
      const d = e.data ?? {};
      if (e.type === "user/message") {
        const t = blocksText(d.content);
        if (t) {
          body.push(`<div class="msg user"><div class="role role-user">\u{1F464} \u7528\u6237</div><pre class="msg-text">${escHtml(t)}</pre></div>`);
        }
      } else if (e.type === "assistant/message") {
        const t = blocksText(d.message?.content);
        const r = blocksText(d.message?.content, "reasoning");
        if (t || r) {
          let html = `<div class="msg assistant"><div class="role role-assistant">\u{1F916} \u52A9\u624B</div>`;
          if (r) {
            html += `<details class="reasoning"><summary data-len="${r.length}">\u601D\u8003\u8FC7\u7A0B\uFF08${r.length} \u5B57\uFF0C\u70B9\u51FB\u5C55\u5F00\uFF09</summary>${escHtml(r)}</details>`;
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
  <div class="tool-head">\u2699 ${escHtml(call.name)}</div>
  <div class="tool-body">${escHtml(call.args)}</div>
  <div class="tool-body tool-result ${isError ? "error" : ""}"><b class="tool-result-label" data-error="${isError ? "1" : "0"}">\u7ED3\u679C${isError ? "\uFF08\u5931\u8D25\uFF09" : ""}\uFF1A</b>${escHtml(resultText)}</div>
</div>`);
        }
      }
    }
    parts.push(...body);
    parts.push(`</body></html>`);
    const exportDir = join(process.cwd(), "exports");
    mkdirSync(exportDir, { recursive: true });
    const safeId = /^[A-Za-z0-9._-]+$/.test(String(sessionId)) ? sessionId : "session";
    const outPath = join(exportDir, `${safeId}.html`);
    writeFileSync(outPath, parts.join("\n"), "utf8");
    return { ok: true, path: outPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function applyPiAiProviders(ctx, providers) {
  const loader = ctx.get("loader");
  if (loader === void 0) throw new Error("loader service unavailable");
  const entry = [...loader.entries()].find((row) => row.options.id === "llm-pi-ai");
  if (entry === void 0) throw new Error('entry "llm-pi-ai" is not mounted');
  const config = { ...entry.options.config ?? {}, providers };
  await entry.update({ ...entry.options, config });
  await loader.await();
}
async function applyOfficialDeepSeekRoute(ctx, profile) {
  const loader = ctx.get("loader");
  if (loader === void 0) throw new Error("loader service unavailable");
  const entry = [...loader.entries()].find((row) => row.options.id === "llm-deepseek");
  if (entry === void 0) throw new Error('entry "llm-deepseek" is not mounted');
  const credentials = ctx.get("credentials");
  const current = entry.options.config ?? {};
  const ref = `dshVscode_${"deepseek-official".replace(/[^A-Za-z0-9_]/g, "_")}`;
  const config = { ...current };
  if (typeof profile.apiKey === "string" && profile.apiKey !== "") {
    if (credentials) await credentials.set(credentialRef(ref), profile.apiKey);
    config.apiKeyEnv = ref;
  } else if (profile.apiKey === "") {
    if (credentials) await credentials.unset(credentialRef(ref));
    delete config.apiKeyEnv;
  }
  if (typeof profile.baseUrl === "string") {
    const trimmed = profile.baseUrl.trim();
    if (trimmed !== "") config.baseURL = trimmed;
    else delete config.baseURL;
  }
  const changed = config.apiKeyEnv !== current.apiKeyEnv || config.baseURL !== current.baseURL;
  if (changed) {
    await entry.update({ ...entry.options, config });
    await loader.await();
  }
}
async function main() {
  const env = { ...process.env };
  const pump = new EventPump(
    () => agent === void 0 || agent.session === void 0 ? void 0 : sessionFileSize(String(agent.session.id))
  );
  const approvals = { nextId: /* @__PURE__ */ (() => {
    let n = 0;
    return () => ++n;
  })(), pending: /* @__PURE__ */ new Map() };
  const questions = { nextId: /* @__PURE__ */ (() => {
    let n = 0;
    return () => ++n;
  })(), pending: /* @__PURE__ */ new Map() };
  let ctx;
  let handle;
  let agent;
  let pendingPlanMode = null;
  let selection = null;
  let resetStepBudget = null;
  let shuttingDown = false;
  let rotateRetryTimer = null;
  let agentBusy = false;
  let pendingSessionId = null;
  let rotateRejectedDate = "";
  let rotateConfirmResolve = null;
  let rotateConfirmOk = false;
  let rotating = false;
  try {
    ctx = await bootTree();
    log("info", "DSH tree booted");
    ctx.on("agent/status", ({ agent: a, status }) => {
      if (agent !== void 0 && a === agent) agentBusy = status === "running";
    });
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
      if (agent === void 0 || pendingSessionId !== null || shuttingDown) return;
      if (agentBusy) {
        if (rotateRetryTimer === null) {
          rotateRetryTimer = setTimeout(() => {
            rotateRetryTimer = null;
            void maybeRotateSession();
          }, 3e4);
        }
        return;
      }
      if (rotateRejectedDate === (/* @__PURE__ */ new Date()).toDateString()) return;
      try {
        const size = sessionFileSize(agent.session.id);
        if (size === void 0 || size <= ROTATE_BYTES) return;
        if (rotateConfirmResolve !== null) return;
        const oldTitle = await currentSessionTitle(ctx, agent) || "\u4F1A\u8BDD";
        post({ t: "rotateRequest", oldTitle, sessionBytes: size });
        rotateConfirmOk = false;
        await new Promise((resolve) => {
          rotateConfirmResolve = resolve;
        });
        rotateConfirmResolve = null;
        if (!rotateConfirmOk) {
          rotateRejectedDate = (/* @__PURE__ */ new Date()).toDateString();
          return;
        }
        rotating = true;
        post({ t: "rotateWorking" });
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
          summary = tailConversationText(sessionEventsOf(agent.session), ROTATE_FALLBACK_MSGS);
        }
        const newId = `dsh-vscode-${randomUUID()}`;
        const seq = nextSessionSeq(oldTitle);
        const newTitle = `${stripSeqSuffix(oldTitle)}_${seq}`;
        updateSessionMeta(newId, { title: newTitle, seedSummary: void 0, rotated: true });
        invalidateSessionsCache();
        if (handle !== void 0) {
          await handle.dispose();
          handle = void 0;
          agent = void 0;
          resetStepBudget = null;
        }
        let seedEvents = [];
        try {
          const created = await createAgent(ctx, { sessionId: newId }, pump, approvals);
          handle = created.handle;
          agent = created.agent;
          selection = created.selection;
          resetStepBudget = created.resetStepBudget;
          if (summary !== "") {
            agent.inject(createUserMessage({
              content: [{ type: "text", text: `\u3010\u4E0A\u4E00\u4F1A\u8BDD\u6458\u8981\u3011
${summary}` }],
              source: { kind: "user" }
            }));
            seedEvents = [{
              type: "user/message",
              seq: 1,
              time: Date.now(),
              data: { content: [{ type: "text", text: `\u3010\u4E0A\u4E00\u4F1A\u8BDD\u6458\u8981\u3011
${summary}` }] }
            }];
          }
          log("info", `rotated session created with seed summary (${summary.length} chars)`);
        } catch (e) {
          log("warn", "rotate new agent create failed, deferring to lazy create", e instanceof Error ? e.message : String(e));
          pendingSessionId = newId;
          updateSessionMeta(newId, { seedSummary: summary });
        }
        post({
          t: "ready",
          sessionId: newId,
          cwd: process.cwd(),
          provider: selection?.provider ?? "",
          model: selection?.model ?? env.DSH_VSCODE_MODEL ?? "",
          version: CORE_VERSION,
          sessionTitle: newTitle,
          sessionBytes: sessionFileSize(newId)
        });
        post({ t: "history", sessionId: newId, events: seedEvents, hasMore: false, nextSeq: void 0, sessionBytes: sessionFileSize(newId) });
        post({ t: "sessionRotated", oldTitle, newTitle, sessionBytes: sessionFileSize(newId) });
        log("info", `session rotated: ${oldTitle} -> ${newTitle} (file ${size} bytes, summary ${summary.length} chars)`);
      } catch (e) {
        log("warn", "session rotation failed", e instanceof Error ? e.message : String(e));
      } finally {
        rotating = false;
      }
    }
    setTimeout(() => {
      void maybeRotateSession();
    }, 5 * 60 * 1e3);
    setInterval(() => {
      void maybeRotateSession();
    }, 60 * 60 * 1e3);
    installApprovalListener(ctx, approvals);
    log("info", "approval listener installed (root scope, covers all agents)");
    installQuestionListener(ctx, questions);
    log("info", "user-questions answerer installed (root scope, covers all agents)");
    if (ctx.get("settings") === void 0) {
      log("warn", "settings service unavailable \u2014 profileContext missing? (config-editor / plugin-manager rows are gated by it)");
    } else {
      log("info", "settings service available");
    }
    try {
      const jobs = ctx.get("jobs");
      if (jobs !== void 0 && jobs.events !== void 0 && typeof jobs.events.subscribe === "function") {
        const dispose = jobs.events.subscribe({ owners: "all" }, () => {
          try {
            post({ t: "jobsChanged" });
          } catch {
          }
        });
        if (typeof dispose === "function") ctx.effect(() => () => dispose());
        log("info", "jobs change observer installed (events.subscribe owners=all)");
      } else {
        log("warn", "jobs service unavailable; the background-job panel stays empty");
      }
    } catch (error) {
      log("warn", "jobs observer install failed", error instanceof Error ? error.message : String(error));
    }
    ctx.on("agent/created", ({ agent: createdAgent }) => {
      try {
        const sid = createdAgent.session.id;
        if (String(sid).startsWith(SESSION_PREFIX)) return;
        const meta = getSessionMeta(sid);
        if (typeof meta.title === "string" && meta.title.trim() !== "") return;
        updateSessionMeta(sid, { title: genSubsessionTitle(sid) });
        invalidateSessionsCache();
      } catch (error) {
        log("warn", "subagent title init failed", error instanceof Error ? error.message : String(error));
      }
    });
    log("info", "subagent title listener installed (agent/created)");
    migrateLegacySessions();
    handle = void 0;
    agent = void 0;
    post({
      t: "ready",
      sessionId: "",
      cwd: process.cwd(),
      provider: "",
      model: env.DSH_VSCODE_MODEL ?? "",
      version: CORE_VERSION
    });
    log("info", "host ready (lazy session)");
    if (typeof process.env.DSH_SELF_TEST === "string" && process.env.DSH_SELF_TEST !== "" && process.env.DSH_SELF_TEST !== "0") {
      process.stdout.write(`${process.env.DSH_SELF_TEST}
`);
      log("info", "self-test ok \u2014 exiting");
      process.exit(0);
    }
  } catch (error) {
    log("error", "host boot failed", error instanceof Error ? error.stack ?? error.message : String(error));
    const details = [];
    let cur = error;
    for (let depth = 0; cur && depth < 6; depth++) {
      if (Array.isArray(cur.errors)) {
        for (const e of cur.errors) {
          details.push(e instanceof Error ? e.stack ?? e.message : String(e));
        }
      } else if (cur.cause !== void 0 && cur.cause !== null) {
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
  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      pump.flush();
      if (handle !== void 0) await handle.dispose();
      if (ctx !== void 0) await ctx.fiber.dispose();
    } catch (error) {
      log("error", "shutdown error", error instanceof Error ? error.message : String(error));
    }
    clearOwnLock();
    process.exit(code);
  }
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let criticalQueue = Promise.resolve();
  const CRITICAL_FRAMES = /* @__PURE__ */ new Set(["chat", "newSession", "resumeSession", "restorePreview", "deleteSession", "compact"]);
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
      criticalQueue = criticalQueue.then(() => handleFrame(msg)).catch((error) => {
        log("error", "critical frame chain failure", error instanceof Error ? error.message : String(error));
      });
    } else {
      void handleFrame(msg);
    }
  });
  function postPlanMode(extra) {
    let active = false;
    let pending;
    try {
      const planMode = ctx?.get?.("planMode");
      if (planMode !== void 0 && typeof planMode.get === "function" && agent !== void 0) {
        const state = planMode.get(agent);
        active = state?.active === true;
        pending = state?.pending === true ? true : void 0;
      } else if (pendingPlanMode !== null) {
        active = pendingPlanMode;
        pending = true;
      }
    } catch {
    }
    post({ t: "planMode", active, ...pending !== void 0 ? { pending } : {}, ...extra ?? {} });
  }
  async function handleFrame(msg) {
    try {
      switch (msg.t) {
        case "chat": {
          const text = typeof msg.text === "string" ? msg.text : "";
          if (text.trim() === "") {
            post({ t: "chatDone", id: msg.id, ok: false, error: "empty message" });
            return;
          }
          if (rotating) {
            post({ t: "chatDone", id: msg.id, ok: false, error: "rotation in progress" });
            return;
          }
          if (agent === void 0) {
            const created = await createAgent(ctx, { model: msg.model, sessionId: pendingSessionId ?? void 0 }, pump, approvals);
            pendingSessionId = null;
            handle = created.handle;
            agent = created.agent;
            selection = created.selection;
            resetStepBudget = created.resetStepBudget;
            acquireSessionLock(agent.session.id);
            if (pendingPlanMode !== null) {
              const wanted = pendingPlanMode;
              pendingPlanMode = null;
              try {
                const planMode = ctx.get("planMode");
                if (planMode !== void 0 && typeof planMode.set === "function") {
                  log("info", `plan mode deferred selection applied(${wanted}) \u2192 ${planMode.set(agent, wanted)}`);
                }
              } catch (error) {
                log("warn", "deferred plan mode apply failed", error instanceof Error ? error.message : String(error));
              }
            }
            if (!getSessionMeta(agent.session.id).title) {
              updateSessionMeta(agent.session.id, { title: genTempTitle(text) });
            }
            invalidateSessionsCache();
          }
          const meta = getSessionMeta(agent.session.id);
          if (meta?.rotated === true && typeof meta.title === "string" && meta.title.trim() !== "") {
            const titleSvc = ctx.get("sessionTitle");
            if (titleSvc !== void 0 && typeof titleSvc.rename === "function") {
              Promise.resolve().then(() => titleSvc.rename(agent.session, meta.title)).catch((error) => {
                log("warn", "rotate session title pin failed", error instanceof Error ? error.message : String(error));
              });
            }
          }
          if (meta?.seedSummary) {
            try {
              agent.inject(createUserMessage({
                content: [{ type: "text", text: `\u3010\u4E0A\u4E00\u4F1A\u8BDD\u6458\u8981\u3011
${meta.seedSummary}` }],
                source: { kind: "user" }
              }));
              updateSessionMeta(agent.session.id, { seedSummary: void 0 });
              log("info", `rotated session seed summary injected (${meta.seedSummary.length} chars)`);
            } catch (e) {
              log("warn", "rotate seed summary inject failed", e instanceof Error ? e.message : String(e));
            }
          }
          resetStepBudget?.();
          post({
            t: "ready",
            sessionId: agent.session.id,
            cwd: process.cwd(),
            provider: agent.options.provider,
            model: agent.options.model,
            version: CORE_VERSION,
            sessionTitle: await currentSessionTitle(ctx, agent)
          });
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
                    name: img?.name
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
              source: { kind: "user" }
            })
          );
          await agent.whenIdle();
          void maybeLearnFromTurn(ctx, agent, text).catch(() => {
          });
          pump.flush();
          post({ t: "chatDone", id: msg.id, ok: true });
          break;
        }
        case "stop": {
          if (agent !== void 0) agent.cancel({ kind: "user" });
          post({ t: "stopAck", id: msg.id });
          break;
        }
        case "approval:resolve": {
          const entry = approvals.pending.get(msg.id);
          if (entry === void 0) break;
          approvals.pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg.approve === true ? "allowed-once" : "rejected");
          break;
        }
        case "question:resolve": {
          const entry = questions.pending.get(msg.id);
          if (entry === void 0) break;
          if (msg.outcome === "cancel") {
            entry.settle({ kind: "cancel", code: "ASK_CANCELLED", message: "the user dismissed the question to speak instead" });
          } else {
            entry.settle({ kind: "answer", answers: msg.answers });
          }
          break;
        }
        case "getPlanMode": {
          postPlanMode();
          break;
        }
        case "setPlanMode": {
          const planMode = ctx.get("planMode");
          if (planMode === void 0) {
            postPlanMode({ error: "plan mode service unavailable" });
            break;
          }
          if (agent === void 0) {
            pendingPlanMode = msg.active === true;
            log("info", `plan mode deferred(${pendingPlanMode}) until the session is created`);
            postPlanMode({ result: "deferred" });
            break;
          }
          try {
            const result = planMode.set(agent, msg.active === true);
            log("info", `plan mode set(${msg.active === true}) \u2192 ${result}`);
            postPlanMode({ result });
          } catch (error) {
            log("warn", "plan mode switch failed", error instanceof Error ? error.message : String(error));
            postPlanMode({ error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "listJobs": {
          try {
            const jobs = ctx.get("jobs");
            if (jobs === void 0) {
              post({ t: "jobs", jobs: [], error: "jobs service unavailable" });
              break;
            }
            post({ t: "jobs", jobs: jobs.list(agent.session.id).map(jobView) });
          } catch (error) {
            post({ t: "jobs", jobs: [], error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "jobKill": {
          try {
            const jobs = ctx.get("jobs");
            if (jobs === void 0) throw new Error("jobs service unavailable");
            const result = jobs.kill(msg.jobId, agent.session.id, "cancelled from the VS Code panel");
            log("info", `job ${msg.jobId} kill \u2192 ${result}`);
            post({ t: "jobKilled", ok: true, result });
          } catch (error) {
            post({ t: "jobKilled", ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "jobOutput": {
          try {
            const jobs = ctx.get("jobs");
            if (jobs === void 0) throw new Error("jobs service unavailable");
            const snapshot = jobs.get(msg.jobId, agent.session.id);
            if (snapshot.status === "running" || snapshot.status === "stopping") {
              post({
                t: "jobOutput",
                ok: false,
                error: L(
                  "\u4F5C\u4E1A\u4ECD\u5728\u8FD0\u884C\uFF1A\u8F93\u51FA\u8BFB\u53D6\u4F1A\u5360\u7528\u6A21\u578B\u7684\u8BFB\u53D6\u6E38\u6807\uFF0C\u8BF7\u7B49\u5B83\u7ED3\u675F\u540E\u518D\u770B\u3002",
                  "Job still running: reading output would consume the model's read cursor \u2014 wait until it settles."
                )
              });
              break;
            }
            const read = jobs.read(msg.jobId, agent.session.id);
            post({ t: "jobOutput", ok: true, text: read.text });
          } catch (error) {
            post({ t: "jobOutput", ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "newSession": {
          pendingSessionId = null;
          pendingPlanMode = null;
          clearOwnLock();
          if (handle !== void 0) {
            await handle.dispose();
            handle = void 0;
            agent = void 0;
            resetStepBudget = null;
          }
          selection = null;
          post({
            t: "ready",
            sessionId: "",
            cwd: process.cwd(),
            provider: "",
            model: env.DSH_VSCODE_MODEL ?? "",
            version: CORE_VERSION
          });
          break;
        }
        case "listSessions": {
          try {
            const list = await listSessions(ctx);
            if (agent !== void 0) {
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
          if (typeof msg.id !== "string" || msg.id.trim() === "") break;
          try {
            const inspected = await inspectStoredSession(ctx, msg.id);
            const events = (inspected.events ?? []).filter(
              (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
            );
            const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
            const tail = events.slice(-limit);
            const hasMore = events.length > tail.length;
            const nextSeq = hasMore ? tail[0].seq : void 0;
            const stats = resolveSessionStats(getSessionMeta(msg.id).stats, events, msg.id);
            post({ t: "history", sessionId: msg.id, events: tail, hasMore, nextSeq, stats, sessionBytes: sessionFileSize(msg.id) });
          } catch (error) {
            log("warn", "restorePreview preview failed", error instanceof Error ? error.message : String(error));
            post({ t: "viewSessionFailed", id: msg.id, error: error instanceof Error ? error.message : String(error) });
            break;
          }
          try {
            const lock = acquireSessionLock(msg.id);
            if (!lock.ok && lock.busy) {
              log("warn", `restorePreview denied: session busy by pid ${lock.holderPid}`);
              post({
                t: "hint",
                text: L(
                  `\u8BE5\u4F1A\u8BDD\u6B63\u88AB\u53E6\u4E00 VS Code \u5B9E\u4F8B\uFF08\u8FDB\u7A0B ${lock.holderPid}\uFF09\u4F7F\u7528\u4E2D\uFF0C\u672A\u81EA\u52A8\u6062\u590D\u3002`,
                  `This session is in use by another VS Code instance (pid ${lock.holderPid}); not auto-resumed.`
                )
              });
              post({ t: "sessionResumed", id: msg.id, ok: false, error: "session busy" });
              break;
            }
            const meta = getSessionMeta(msg.id);
            if (handle !== void 0) await handle.dispose();
            const resumed = await resumeAgent(
              ctx,
              msg.id,
              {
                provider: meta.provider || void 0,
                // 不把 env.DSH_VSCODE_MODEL 作为 options.model 传入：meta 缺失
                // 时由 resumeAgent 内部回退到 agentDefaultModel 的持久化默认，
                // 保证 provider/model 同源（避免 meta.provider=zai-free 却拼上
                // 扩展配置固定 model 的错配）。
                model: meta.model || void 0,
                reasoningEffort: meta.reasoningEffort || void 0
              },
              pump,
              approvals
            );
            handle = resumed.handle;
            agent = resumed.agent;
            selection = resumed.selection;
            resetStepBudget = resumed.resetStepBudget;
            await pauseLegacyActiveGoal(ctx, agent);
            if (meta.workMode === "multi" || meta.workMode === "single") {
              workMode = meta.workMode;
              post({ t: "workModeChanged", mode: workMode });
            }
            if (typeof meta.title === "string" && meta.title.trim() !== "") {
              const titleSvc = ctx.get("sessionTitle");
              if (titleSvc !== void 0 && typeof titleSvc.rename === "function") {
                Promise.resolve().then(() => titleSvc.rename(agent.session, meta.title)).catch((error) => {
                  log("warn", "session title restore failed", error instanceof Error ? error.message : String(error));
                });
              }
            }
            post({
              t: "ready",
              sessionId: agent.session.id,
              cwd: process.cwd(),
              provider: agent.options.provider,
              model: agent.options.model,
              version: CORE_VERSION,
              sessionTitle: await currentSessionTitle(ctx, agent)
            });
          } catch (error) {
            log("warn", "restorePreview resume failed", error instanceof Error ? error.message : String(error));
            post({ t: "sessionResumed", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "resumeSession": {
          pendingSessionId = null;
          if (typeof msg.id !== "string" || msg.id.trim() === "") {
            post({ t: "sessionResumed", id: msg.id, ok: false, error: "invalid session id" });
            break;
          }
          const lock = acquireSessionLock(msg.id);
          if (!lock.ok && lock.busy) {
            log("warn", `resumeSession denied: session busy by pid ${lock.holderPid}`);
            post({
              t: "sessionResumed",
              id: msg.id,
              ok: false,
              error: L(
                `\u8BE5\u4F1A\u8BDD\u6B63\u88AB\u53E6\u4E00 VS Code \u5B9E\u4F8B\uFF08\u8FDB\u7A0B ${lock.holderPid}\uFF09\u4F7F\u7528\u4E2D\uFF0C\u8BF7\u5148\u5173\u95ED\u90A3\u8FB9\u7684\u7A97\u53E3\u6216\u7A0D\u540E\u518D\u8BD5\u3002`,
                `This session is in use by another VS Code instance (pid ${lock.holderPid}). Close that window or retry later.`
              )
            });
            break;
          }
          const meta = getSessionMeta(msg.id);
          if (handle !== void 0) await handle.dispose();
          const tResume0 = Date.now();
          log("info", `resumeSession start: ${msg.id}`);
          const resumed = await resumeAgent(
            ctx,
            msg.id,
            {
              provider: meta.provider || void 0,
              model: meta.model || msg.model || void 0,
              reasoningEffort: meta.reasoningEffort || void 0
            },
            pump,
            approvals
          );
          handle = resumed.handle;
          agent = resumed.agent;
          selection = resumed.selection;
          resetStepBudget = resumed.resetStepBudget;
          await pauseLegacyActiveGoal(ctx, agent);
          if (meta.workMode === "multi" || meta.workMode === "single") {
            workMode = meta.workMode;
            post({ t: "workModeChanged", mode: workMode });
          }
          if (typeof meta.title === "string" && meta.title.trim() !== "") {
            const titleSvc = ctx.get("sessionTitle");
            if (titleSvc !== void 0 && typeof titleSvc.rename === "function") {
              Promise.resolve().then(() => titleSvc.rename(agent.session, meta.title)).catch((error) => {
                log("warn", "session title restore failed", error instanceof Error ? error.message : String(error));
              });
            }
          }
          const allEvents = sessionEventsOf(agent.session).filter(
            (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
          );
          const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
          const tail = allEvents.slice(-limit);
          const hasMore = allEvents.length > tail.length;
          const nextSeq = hasMore ? tail[0].seq : void 0;
          const stats = resolveSessionStats(meta.stats, allEvents, agent.session.id);
          post({ t: "history", sessionId: agent.session.id, events: tail, hasMore, nextSeq, stats });
          post({
            t: "ready",
            sessionId: agent.session.id,
            cwd: process.cwd(),
            provider: agent.options.provider,
            model: agent.options.model,
            version: CORE_VERSION,
            sessionTitle: await currentSessionTitle(ctx, agent)
          });
          post({ t: "sessionResumed", id: msg.id, ok: true });
          log(
            "info",
            `resumeSession done: ${msg.id} in ${Date.now() - tResume0}ms (${allEvents.length} events)`
          );
          break;
        }
        case "viewSession": {
          if (typeof msg.id !== "string" || msg.id.trim() === "") {
            post({ t: "viewSessionFailed", id: msg.id, error: "invalid session id" });
            break;
          }
          try {
            const inspected = await inspectStoredSession(ctx, msg.id);
            const events = (inspected.events ?? []).filter(
              (e) => e.type !== "assistant/chunk" && e.type !== "session/end-seed"
            );
            const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
            const tail = events.slice(-limit);
            const hasMore = events.length > tail.length;
            const nextSeq = hasMore ? tail[0].seq : void 0;
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
          if (!Number.isFinite(msg.beforeSeq)) {
            post({ t: "historyMore", sessionId: "", events: [], hasMore: false });
            break;
          }
          const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : 200;
          if (agent !== void 0) {
            const { older, hasMore } = olderSessionEvents(sessionEventsOf(agent.session), msg.beforeSeq, limit);
            post({
              t: "historyMore",
              sessionId: agent.session.id,
              events: older,
              hasMore,
              nextSeq: hasMore && older.length > 0 ? older[0].seq : void 0
            });
          } else if (typeof msg.sessionId === "string" && msg.sessionId !== "") {
            try {
              const inspected = await inspectStoredSession(ctx, msg.sessionId);
              const { older, hasMore } = olderSessionEvents(inspected.events ?? [], msg.beforeSeq, limit);
              post({
                t: "historyMore",
                sessionId: msg.sessionId,
                events: older,
                hasMore,
                nextSeq: hasMore && older.length > 0 ? older[0].seq : void 0
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
          invalidateSessionsCache();
          if (agent !== void 0 && agent.session.id === msg.id) {
            try {
              const titleSvc = ctx.get("sessionTitle");
              if (titleSvc !== void 0 && typeof titleSvc.rename === "function") {
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
          pendingSessionId = null;
          const result = await deleteSession(ctx, msg.id);
          if (result.ok) invalidateSessionsCache();
          if (result.ok && agent !== void 0 && agent.session.id === msg.id) {
            clearOwnLock();
            if (handle !== void 0) await handle.dispose();
            handle = void 0;
            agent = void 0;
            selection = null;
            resetStepBudget = null;
            post({
              t: "ready",
              sessionId: "",
              cwd: process.cwd(),
              provider: "",
              model: env.DSH_VSCODE_MODEL ?? "",
              version: CORE_VERSION
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
          rotateConfirmOk = msg.ok === true;
          rotateConfirmResolve?.();
          break;
        }
        case "setModel": {
          try {
            const defaultModel = ctx.get("agentDefaultModel");
            if (defaultModel === void 0) {
              post({ t: "modelChanged", provider: "", model: "", error: "agentDefaultModel unavailable" });
              break;
            }
            const base = defaultModel.currentSelection();
            let provider = typeof msg.provider === "string" && msg.provider !== "" ? msg.provider : base.provider;
            let model = typeof msg.model === "string" && msg.model !== "" ? msg.model : base.model;
            if (model !== "") {
              try {
                const llm = ctx.get("llm");
                if (llm !== void 0 && typeof llm.listModels === "function") {
                  const listed = await llm.listModels(provider);
                  const ids = listed.map((m) => m.id);
                  if (!ids.includes(model)) {
                    const first = ids[0];
                    if (first !== void 0 && first !== "") {
                      log(
                        "warn",
                        L(
                          `\u6A21\u578B ${provider}/${model} \u4E0D\u5C5E\u4E8E\u8BE5\u63D0\u4F9B\u5546\uFF0C\u5DF2\u81EA\u52A8\u6539\u7528 ${provider}/${first}`,
                          `model ${provider}/${model} does not belong to provider; auto-switched to ${provider}/${first}`
                        )
                      );
                      model = first;
                    } else {
                      log(
                        "warn",
                        L(
                          `\u63D0\u4F9B\u5546 ${provider} \u65E0\u53EF\u7528\u6A21\u578B\uFF0C\u5DF2\u56DE\u9000\u5230 ${base.provider}/${base.model}`,
                          `provider ${provider} has no usable model; reverted to ${base.provider}/${base.model}`
                        )
                      );
                      provider = base.provider;
                      model = base.model;
                    }
                  }
                }
              } catch (error) {
                log(
                  "warn",
                  L(
                    `\u65E0\u6CD5\u6821\u9A8C ${provider}/${model} \u7684\u5F52\u5C5E\uFF0C\u5DF2\u56DE\u9000\u5230 ${base.provider}/${base.model}`,
                    `cannot verify ${provider}/${model}; reverted to ${base.provider}/${base.model}`
                  ),
                  error instanceof Error ? error.message : String(error)
                );
                provider = base.provider;
                model = base.model;
              }
            }
            const baseEffort = normalizeEffort(base.reasoningEffort);
            const reasoningEffort = normalizeEffort(typeof msg.reasoningEffort === "string" ? msg.reasoningEffort : "") ?? baseEffort;
            const next = { provider, model, reasoningEffort };
            defaultSelection = next;
            if (selection !== null) {
              selection.provider = provider;
              selection.model = model;
              selection.reasoningEffort = reasoningEffort;
            }
            userEffortChanged = true;
            log("info", L(`\u6A21\u578B\u9009\u62E9 \u2192 ${provider}/${model}${reasoningEffort ? `\uFF08\u601D\u8003\u7EA7\u522B=${reasoningEffort}\uFF09` : ""}`, `model selection \u2192 ${provider}/${model}${reasoningEffort ? ` (effort=${reasoningEffort})` : ""}`));
            if (agent !== void 0) {
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
          if (agent !== void 0) {
            updateSessionMeta(agent.session.id, { workMode: mode });
          }
          log("info", `work mode \u2192 ${mode}`);
          post({ t: "workModeChanged", mode });
          break;
        }
        case "getModelInfo": {
          try {
            const llm = ctx.get("llm");
            const defaultModel = ctx.get("agentDefaultModel");
            let providers = dshProviders.map((p) => ({ id: p.id, name: p.name }));
            const providerModels = {};
            let models = [];
            if (dshProviders.length > 0) {
              const merged = /* @__PURE__ */ new Set();
              for (const p of dshProviders) {
                const metaById = /* @__PURE__ */ new Map();
                try {
                  if (llm !== void 0 && typeof llm.listModels === "function") {
                    const listed = await llm.listModels(p.id);
                    for (const m of Array.isArray(listed) ? listed : []) {
                      if (m && typeof m.id === "string" && m.id !== "") metaById.set(m.id, m);
                    }
                  }
                } catch {
                }
                const entries = (p.models ?? []).filter((m) => m && typeof m.id === "string" && m.id !== "").map((m) => {
                  const info = metaById.get(m.id);
                  const e = { id: m.id, name: m.displayName || m.name || info?.name || m.id };
                  const mods = Array.isArray(m.inputModalities) ? m.inputModalities : info?.inputModalities;
                  if (Array.isArray(mods) && mods.length > 0) e.inputModalities = mods;
                  return e;
                });
                providerModels[p.id] = entries;
                for (const e of entries) merged.add(e.id);
              }
              models = [...merged];
            } else {
              if (llm !== void 0 && typeof llm.listProviders === "function") {
                providers = llm.listProviders().map((p) => ({ id: p.id, name: p.id === "deepseek-official" ? "DeepSeek (Official)" : p.name ?? p.id }));
              }
              if (llm !== void 0 && typeof llm.listModels === "function" && providers.length > 0) {
                const merged = /* @__PURE__ */ new Set();
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
              const cur = defaultModel?.currentSelection?.();
              const extra = new Set(cur?.model ? [cur.model] : []);
              if (extra.size > 0) models = [...extra];
              if (providers.length === 0 && extra.size > 0) {
                providers = [{ id: cur.provider || "deepseek-official", name: cur.provider === "deepseek-official" ? "DeepSeek (Official)" : cur.provider || "deepseek-official" }];
                providerModels[providers[0].id] = [...extra].map((id) => ({ id, name: id }));
              }
            }
            const current = selection !== null && selection.provider && selection.model ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort } : defaultModel?.currentSelection?.() ?? { provider: "", model: "" };
            let supportedEfforts = ["off", "low", "high", "max"];
            let defaultEffort = "high";
            if (llm !== void 0 && typeof llm.resolveModelInfo === "function" && current.provider && current.model) {
              try {
                const resolved = await llm.resolveModelInfo(current.provider, current.model, void 0);
                const efforts = resolved?.reasoning?.efforts;
                if (Array.isArray(efforts)) {
                  supportedEfforts = ["off", "low", "high", "max"];
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
                defaultEffort
              }
            });
          } catch (error) {
            log("error", "getModelInfo failed", error instanceof Error ? error.message : String(error));
            post({
              t: "modelInfo",
              providers: [],
              models: [],
              current: { provider: "", model: env.DSH_VSCODE_MODEL ?? "" }
            });
          }
          break;
        }
        case "llmProviders": {
          try {
            const llm = ctx.get("llm");
            const skip = () => false;
            const catalogNames = /* @__PURE__ */ new Map();
            const catalogBaseUrls = /* @__PURE__ */ new Map();
            try {
              for (const p of builtinProviders()) {
                if (p.name) catalogNames.set(p.id, p.name);
                if (p.baseUrl) catalogBaseUrls.set(p.id, p.baseUrl);
              }
            } catch {
            }
            const providers = [];
            if (llm && typeof llm.listProviders === "function") {
              for (const p of llm.listProviders()) {
                if (!skip(p.id)) providers.push({ id: p.id, name: p.id === "deepseek-official" ? "DeepSeek (Official)" : p.name ?? p.id, baseUrl: catalogBaseUrls.get(p.id) });
              }
            }
            if (llm && typeof llm.listConfigurableProviders === "function") {
              for (const p of llm.listConfigurableProviders()) {
                if (p && p.provider && !skip(p.provider) && !providers.some((x) => x.id === p.provider)) {
                  providers.push({
                    id: p.provider,
                    name: catalogNames.get(p.provider) || p.displayName || p.provider,
                    baseUrl: catalogBaseUrls.get(p.provider)
                  });
                }
              }
            }
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
          try {
            const llm = ctx.get("llm");
            if (msg.provider === "deepseek-official" && llm && typeof llm.listModels === "function") {
              if (typeof msg.model === "string" && msg.model !== "") {
                let contextWindow;
                let maxTokens;
                if (typeof llm.resolveModelInfo === "function") {
                  try {
                    const info = await llm.resolveModelInfo(msg.provider, msg.model, void 0);
                    const ctxWin = info?.context?.contextWindow;
                    if (typeof ctxWin === "number") contextWindow = ctxWin;
                    if (typeof info?.defaultMaxTokens === "number") maxTokens = info.defaultMaxTokens;
                  } catch {
                  }
                }
                post({ t: "discoveredModels", id: msg.id, models: [{ id: msg.model, contextWindow, maxTokens }] });
                break;
              }
              const listed = await llm.listModels(msg.provider);
              const models = (Array.isArray(listed) ? listed : []).filter((m) => m && typeof m.id === "string" && m.id !== "").map((m) => {
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
                provider: typeof msg.provider === "string" ? msg.provider : void 0,
                baseURL: typeof msg.baseURL === "string" && msg.baseURL !== "" ? msg.baseURL : void 0,
                api: typeof msg.api === "string" && msg.api !== "" ? msg.api : void 0,
                apiKey: typeof msg.apiKey === "string" && msg.apiKey !== "" ? msg.apiKey : void 0
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
              height: typeof ref.height === "number" ? ref.height : 0
            });
            post({
              t: "attachmentResult",
              id: msg.id,
              ok: true,
              mediaType: stored.ref.mediaType,
              data: Buffer.from(stored.data).toString("base64")
            });
          } catch (error) {
            log("warn", "readAttachment failed", error instanceof Error ? error.message : String(error));
            post({ t: "attachmentResult", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "toolCatalog": {
          try {
            const tools = ctx.get("tools");
            let schemas = [];
            if (tools && typeof tools.schemas === "function") {
              try {
                schemas = tools.schemas(agent ?? void 0) ?? [];
              } catch {
                schemas = [];
              }
            }
            const list = (Array.isArray(schemas) ? schemas : []).map((s) => ({
              name: typeof s?.name === "string" ? s.name : "",
              description: typeof s?.description === "string" ? s.description : "",
              fields: s && s.parameters && typeof s.parameters === "object" && s.parameters.properties && typeof s.parameters.properties === "object" ? Object.keys(s.parameters.properties) : []
            })).filter((s) => s.name !== "");
            post({ t: "toolCatalog", id: msg.id, tools: list });
          } catch (error) {
            post({ t: "toolCatalog", id: msg.id, tools: [], error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "providersApply": {
          try {
            const list = Array.isArray(msg.providers) ? msg.providers : [];
            dshProviders = list.filter((p) => p && typeof p.id === "string" && p.id !== "").map((p) => ({
              id: p.id,
              name: p.name || p.id,
              models: Array.isArray(p.models) ? p.models.map((m) => typeof m === "string" ? { id: m } : { ...m }).filter((m) => m && m.id) : []
            }));
            const credentials = ctx.get("credentials");
            const section = { providers: {} };
            const removedIds = Array.isArray(msg.removedIds) ? msg.removedIds : [];
            for (const removedId of removedIds) {
              if (typeof removedId !== "string" || removedId === "") continue;
              try {
                const orphanRef = `dshVscode_${removedId.replace(/[^A-Za-z0-9_]/g, "_")}`;
                if (credentials) await credentials.unset(credentialRef(orphanRef));
              } catch (error) {
                log("warn", `providersApply: \u6E05\u9664\u5DF2\u5220\u9664\u63D0\u4F9B\u5546 ${removedId} \u7684\u5B64\u513F\u51ED\u636E\u5931\u8D25`, error instanceof Error ? error.message : String(error));
              }
            }
            const parseTokens = (v) => {
              if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : void 0;
              const m = String(v ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
              if (!m) return void 0;
              const mult = m[2].toLowerCase() === "k" ? 1024 : m[2].toLowerCase() === "m" ? 1024 * 1024 : 1;
              return Math.round(parseFloat(m[1]) * mult);
            };
            for (const p of list) {
              if (!p || !p.id) continue;
              if (p.id === "deepseek-official" || p.id === "deepseek-account") continue;
              const ref = `dshVscode_${p.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
              const profile = {
                displayName: p.name || p.id,
                api: p.protocol || "openai-completions",
                baseURL: p.baseUrl || void 0
              };
              if (Array.isArray(p.models) && p.models.length > 0) {
                profile.models = p.models.map((m) => {
                  const mid = typeof m === "string" ? m : m?.id;
                  if (!mid) return void 0;
                  const out = { id: mid };
                  if (m && typeof m === "object") {
                    if (m.displayName) out.name = m.displayName;
                    const ctxWin = parseTokens(m.contextWindow);
                    if (ctxWin !== void 0) out.contextWindow = ctxWin;
                    const maxTok = parseTokens(m.maxOutput);
                    if (maxTok !== void 0) out.maxTokens = maxTok;
                    if (Array.isArray(m.inputModalities) && m.inputModalities.length > 0) {
                      const mods = m.inputModalities.filter((x) => typeof x === "string" && x !== "");
                      if (mods.length > 0) out.input = mods;
                    }
                  }
                  return out;
                }).filter(Boolean);
              }
              if (typeof p.apiKey === "string" && p.apiKey !== "") {
                profile.apiKeyEnv = ref;
                if (credentials) await credentials.set(credentialRef(ref), p.apiKey);
              } else if (p.apiKey === "") {
                if (credentials) await credentials.unset(credentialRef(ref));
              } else if (credentials) {
                const existing = await credentials.resolve(credentialRef(ref));
                if (existing && existing.value) profile.apiKeyEnv = ref;
              }
              section.providers[p.id] = profile;
            }
            await applyPiAiProviders(ctx, section.providers);
            const official = list.find((p) => p && p.id === "deepseek-official");
            if (official !== void 0) await applyOfficialDeepSeekRoute(ctx, official);
            effortCapabilityCache.clear();
            effortAdaptedCache.clear();
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
            if (compaction === void 0) {
              post({ t: "compactDone", id: msg.id, ok: false, error: "compaction service unavailable" });
              break;
            }
            if (agent === void 0) {
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
                text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`
              });
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
          break;
      }
    }
  }
  rl.on("close", () => void shutdown(0));
}
main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
  process.exit(1);
});
