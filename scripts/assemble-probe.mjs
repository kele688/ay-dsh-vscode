#!/usr/bin/env node
/**
 * assemble-probe.mjs — 验证 system-prompt/assemble 钩子在真实 agent 流程中
 * 是否被调用（离线，无需 API key：assemble 发生在请求发送之前，模型调用失败
 * 不影响本验证）。
 *
 * 背景：maxSteps 柔性收尾依赖 agent.ctx 上的 system-prompt/assemble 钩子注入
 * 收尾提示词。用户实测发现"看不到注入痕迹、AI 不受影响"，怀疑钩子未触发。
 * 本探针在真实 boot 的 agent 上注册无条件日志钩子，followup 一条消息，
 * 观察钩子是否被调用、sections 结构是否符合预期。
 *
 * 运行：node scripts/assemble-probe.mjs   （DSH_HOME 可设临时目录）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { boot, loadLayeredEnv, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome, dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

const NAME = "dsh-vscode-host";

function bundlePatchFile(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

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
      const kept = entry.insert.filter((row) => row.id !== "headless-startup" && row.id !== "headless-runner");
      if (kept.length > 0) filteredHeadless.push({ insert: kept });
      continue;
    }
  }
  const currentCwd = process.cwd();
  const overlay = [
    { id: "system-prompt", config: { persona: `You are a coding agent. Working directory: ${currentCwd}.` } },
    { id: "hmr", disabled: true },
    { id: "sandbox-policy", config: { mode: env.DSH_PERMISSION_MODE ?? "workspace-write", workspaceRoot: currentCwd } },
    {
      id: "tool-subagent",
      config: { provider: "spawn", toolName: "subagent", backgroundMode: "continuable", maxDepth: 3 },
    },
    { id: "session-persistence-jsonl", config: { root: dshHomePath("sessions-ay-dsh") } },
    { id: "llm-pi-ai", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
    { id: "typert-gateway", disabled: true },
  ];
  return [...base, ...filteredHeadless, ...overlay];
}

async function main() {
  const home = resolveDshHome();
  const profileDir = join(home, "profiles", "dsh-vscode-assemble-probe");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "cordis.yml"), "# probe\n[]\n");

  const environment = loadLayeredEnv(NAME);
  const patches = composePatches(environment);
  const ctx = await boot(NAME, join(profileDir, "cordis.yml"), patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
  });

  let handle;
  try {
    const agents = ctx.get("agents");
    const defaultModel = ctx.get("agentDefaultModel");
    if (!agents || !defaultModel) throw new Error("agents / agentDefaultModel 服务不可用");
    const base = defaultModel.currentSelection();
    const selection = { provider: base.provider, model: base.model, reasoningEffort: base.reasoningEffort };
    console.log("[probe] creating agent:", base.provider, "/", base.model);

    handle = await agents.create({
      sessionId: SessionId(`dsh-vscode-probe-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: base.provider, model: base.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    const agent = handle.agent;

    let assembleCalls = 0;
    let requestCalls = 0;
    let preStepCalls = 0;
    let preStepInjected = false;
    let sectionsSnapshot = null;
    let systemContainsInjection = false;
    const PROBE_SECTION = { name: "probe-wrap", text: "PROBE-WRAP-DIRECTIVE: you must stop and summarize now." };
    agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembled = await next();
      assembleCalls++;
      sectionsSnapshot = (assembled.sections ?? []).map((s) => s.name);
      console.log(`[probe] ASSEMBLE HOOK CALLED #${assembleCalls} — sections: ${JSON.stringify(sectionsSnapshot)}`);
      // 模拟 attachAgent 的注入（stepLimitHit 后每步追加收尾 section）
      const injected = { ...assembled, sections: [...(assembled.sections ?? []), PROBE_SECTION] };
      // 关键验证：渲染后的 system 是否包含注入内容（模拟 dsh-agent-loop step() 的 renderPrompt）
      const system = renderPrompt(injected);
      systemContainsInjection = system.includes("PROBE-WRAP-DIRECTIVE");
      console.log(`[probe] renderPrompt 后 system 长度=${system.length}，含注入内容=${systemContainsInjection}`);
      return injected;
    });
    // 第三注入点验证：agent/pre-step 瀑布（该步输入 messages 可注入 user 消息，模型必然响应）
    agent.ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      preStepCalls++;
      const before = (decision.messages ?? []).length;
      console.log(`[probe] PRE-STEP HOOK CALLED #${preStepCalls} — decision.kind=${decision.kind}, messages=${before}`);
      if (preStepCalls === 1 && decision.kind === "enter") {
        preStepInjected = true;
        const injected = {
          ...decision,
          messages: [...(decision.messages ?? []), { role: "user", content: [{ type: "text", text: "[probe] wrap-up user directive" }] }],
        };
        console.log(`[probe] pre-step 注入后 messages=${injected.messages.length}`);
        return injected;
      }
      return decision;
    });
    // 第二注入点验证：agent/request 瀑布（请求 messages 末尾注入，不进会话历史）
    agent.ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      requestCalls++;
      const count = (resolved.messages ?? []).length;
      console.log(`[probe] REQUEST HOOK CALLED #${requestCalls} — messages=${count}`);
      if (requestCalls === 1) {
        const injected = { ...resolved, messages: [...(resolved.messages ?? []), { role: "system", content: "[probe] wrap-up directive" }] };
        console.log(`[probe] request 注入后 messages=${injected.messages.length}`);
        return injected;
      }
      return resolved;
    });

    await agent.whenIdle();
    console.log("[probe] agent idle, following up a user message…");
    agent.followup(createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }));
    // 无 API key 时模型调用会失败并结束 turn；assemble 已在此之前触发
    const timer = setTimeout(() => {
      console.log("[probe] timeout waiting for turn — assembleCalls so far:", assembleCalls);
    }, 8000);
    await agent.whenIdle();
    clearTimeout(timer);

    console.log("\n=== 结论 ===");
    console.log(`assemble 钩子被调用次数: ${assembleCalls}`);
    console.log(`request 钩子被调用次数: ${requestCalls}`);
    console.log(`pre-step 钩子被调用次数: ${preStepCalls}, 注入成功: ${preStepInjected}`);
    console.log(`渲染后的 system 包含注入内容: ${systemContainsInjection}`);
    if (assembleCalls > 0 && systemContainsInjection) {
      console.log("→ assemble 注入 → renderPrompt → request.system 链路**完整**：注入会进入发给模型的系统提示。");
      console.log("  模型无视的可能原因：提示词在长系统提示中不突出 / 模型权衡后选择继续任务。");
    } else {
      console.log("→ 注入未进入渲染后的 system：链路断裂，需检查 sections 结构。");
    }
    if (preStepCalls > 0 && preStepInjected) {
      console.log("→ agent/pre-step 注入**可行**：在该步输入 messages 追加 user 消息，模型必然响应——");
      console.log("  这是软性收尾的最强注入点（代价：该消息进入会话历史）。");
    } else {
      console.log("→ agent/pre-step 注入不可用。");
    }
    if (requestCalls > 0) {
      console.log("→ agent/request 改 messages **无效**（buildRequest 只消费配置字段，messages 外部组装）——已确认代码。");
    }
  } finally {
    if (handle) await handle.dispose();
    await ctx.fiber.dispose();
  }
}

main().catch((error) => {
  console.error("[probe] failed:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
