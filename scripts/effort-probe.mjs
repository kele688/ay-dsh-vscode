#!/usr/bin/env node
/**
 * effort-probe.mjs — 思考等级（reasoning effort）能力探测（离线，无需 API key）。
 *
 * 用途：启动一条 DSH Cordis 树（与 agent-host.mjs 相同的 patches），
 *  1) llm.resolveModelInfo 打印当前默认模型声明的 reasoning efforts 元数据；
 *  2) llm.resolveCallConfig 对 off/low/high/max 逐档实测内核是否接受；
 *  3) --live 模式对 off/high/max 各发一次真实请求对比（需 DEEPSEEK_API_KEY）。
 *
 * 官方第一手资料（api-docs.deepseek.com/guides/thinking_mode）：
 *  - 思考模式默认开启，默认 effort = high；
 *  - reasoning_effort 支持 low/high/max，映射表（v4-flash/v4-pro 相同）：
 *      low→low, medium→high, high→high, xhigh→high, max→max；
 *  - 关闭思考用 thinking.type=disabled（即本插件的 off 档）。
 *
 * 备忘：deepseek-chat / deepseek-reasoner 已停止服务（旧模型下线），
 * 现役模型为 deepseek-v4-flash / deepseek-v4-pro。
 *
 * 运行：node scripts/effort-probe.mjs            （元数据 + 逐档实测）
 *       node scripts/effort-probe.mjs --live     （另发真实请求对比，需 key）
 *       DSH_HOME 可设临时目录避免污染 ~/.dsh
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, loadLayeredEnv, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome, dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const NAME = "dsh-vscode-host";

function bundlePatchFile(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

/** 与 agent-host.mjs composePatches 完全一致（保持探测结果与运行时一致）。 */
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
  }

  const currentCwd = process.cwd();
  const overlay = [
    {
      id: "system-prompt",
      config: { persona: `You are a coding agent. Working directory: ${currentCwd}.` },
    },
    { id: "hmr", disabled: true },
    {
      id: "sandbox-policy",
      config: { mode: env.DSH_PERMISSION_MODE ?? "workspace-write", workspaceRoot: currentCwd },
    },
    {
      id: "tool-subagent",
      config: {
        provider: "spawn",
        toolName: "subagent",
        backgroundMode: "continuable",
        maxDepth: Number(env.DSH_SUBAGENT_MAX_DEPTH) || 3,
      },
    },
    {
      id: "session-persistence-jsonl",
      config: { root: dshHomePath("sessions-ay-dsh") },
    },
    { id: "llm-pi-ai", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
    { id: "typert-gateway", disabled: true },
  ];

  return [...base, ...filteredHeadless, ...overlay];
}

async function main() {
  const home = resolveDshHome();
  const profileDir = join(home, "profiles", "dsh-vscode-probe");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "cordis.yml"), "# probe — empty entry list\n[]\n");

  const environment = loadLayeredEnv(NAME);
  const patches = composePatches(environment);
  const ctx = await boot(NAME, join(profileDir, "cordis.yml"), patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
  });

  try {
    const llm = ctx.get("llm");
    const defaultModel = ctx.get("agentDefaultModel");
    const current = defaultModel?.currentSelection?.() ?? {};
    console.log("[probe] DSH_HOME      =", home);
    console.log("[probe] current model =", current.provider, "/", current.model, "effort=", current.reasoningEffort ?? "(unset)");

    if (llm !== undefined && typeof llm.listProviders === "function") {
      console.log("[probe] providers     =", llm.listProviders().map((p) => p.id).join(", "));
    }

    if (llm !== undefined && typeof llm.resolveModelInfo === "function" && current.provider && current.model) {
      // 注意：llm 服务（LlmRuntime）的方法名是 resolveModelInfo（resolveModel 是 adapter 层方法）
      const resolved = await llm.resolveModelInfo(current.provider, current.model, undefined);
      const reasoning = resolved?.reasoning;
      console.log("[probe] reasoning.efforts =", JSON.stringify(reasoning?.efforts ?? null));
      console.log("[probe] reasoning.defaultEffort =", reasoning?.defaultEffort ?? "(unset)");
      console.log("[probe] reasoning.thinking =", reasoning?.thinking ?? "(unset)");
      console.log("[probe] modelInfo =", JSON.stringify(resolved?.modelInfo ?? null));
    } else {
      console.log("[probe] llm.resolveModelInfo unavailable; skipping reasoning metadata");
    }

    // 逐档内核实测：resolveCallConfig 对 off/low/high/max 的接受/拒绝行为
    // （官方文档映射表：low→low, medium→high, high→high, xhigh→high, max→max）
    if (llm !== undefined && typeof llm.resolveCallConfig === "function" && current.provider && current.model) {
      console.log("[probe] --- 逐档 resolveCallConfig 实测（内核是否接受） ---");
      for (const effort of ["off", "low", "high", "max"]) {
        try {
          const resolved = await llm.resolveCallConfig({
            provider: current.provider,
            model: current.model,
            reasoningEffort: effort,
          });
          console.log(`[probe] effort=${effort.padEnd(4)} -> 接受 (effort=${resolved.reasoningEffort ?? "(默认)"})`);
        } catch (error) {
          console.log(`[probe] effort=${effort.padEnd(4)} -> 拒绝: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (process.argv.includes("--live")) {
      await liveCompare(llm, current);
    } else {
      console.log("[probe] 提示：加 --live 参数可对 off/high/max 各发一次真实请求对比（需 DEEPSEEK_API_KEY）。");
    }

    console.log("[probe] done — 结论对照：插件 UI 四档 off/low/high/max，low 在宿主层归一为 high。");
  } finally {
    await ctx.fiber.dispose();
  }
}

/**
 * 真实请求对比（--live 模式）：同一问题分别以 off/high/max 调用一次，
 * 对比思考 token、总耗时与输出长度，验证各档的实际差异。
 * 需要凭据：环境变量 DEEPSEEK_API_KEY（或 DSH 凭据配置）。
 */
async function liveCompare(llm, current) {
  if (llm === undefined || typeof llm.stream !== "function") {
    console.log("[live] llm.stream 不可用，跳过");
    return;
  }
  if (!current.provider || !current.model) {
    console.log("[live] 当前模型未选择，跳过");
    return;
  }
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY);
  if (!hasKey) {
    console.log("[live] 未检测到 DEEPSEEK_API_KEY，跳过真实请求（设置环境变量后可测）");
    return;
  }
  const question = "请用一句话说明快速排序的平均时间复杂度，并解释为什么。";
  console.log(`[live] 模型 ${current.provider}/${current.model}，问题：${question}`);
  for (const effort of ["off", "high", "max"]) {
    const startedAt = Date.now();
    let text = "";
    let reasoning = "";
    let usage = null;
    try {
      for await (const chunk of llm.stream({
        provider: current.provider,
        model: current.model,
        reasoningEffort: effort,
        messages: [{ role: "user", content: [{ type: "text", text: question }] }],
      })) {
        if (chunk.type === "text-delta") text += chunk.text;
        else if (chunk.type === "reasoning-delta") reasoning += chunk.text;
        else if (chunk.type === "usage") usage = chunk.usage;
      }
      const ms = Date.now() - startedAt;
      const rt = usage?.reasoningTokens ?? "—";
      const ot = usage?.outputTokens ?? "—";
      console.log(
        `[live] effort=${effort.padEnd(4)} 耗时=${ms}ms 文本=${text.length}字 思考=${reasoning.length}字 ` +
        `usage=${JSON.stringify(usage ?? null)}（reasoningTokens=${rt} outputTokens=${ot}）`
      );
    } catch (error) {
      console.log(`[live] effort=${effort} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log("[live] 结论：off=关闭思考（无 reasoning）；high/max=开启思考（reasoning_tokens 越多越深）；low 由官方服务端映射为 high。");
}

main().catch((error) => {
  console.error("[probe] failed:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
