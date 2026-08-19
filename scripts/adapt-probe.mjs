#!/usr/bin/env node
/**
 * adapt-probe.mjs — 思考级别参数自动适配链路离线探测。
 *
 * 复现用户场景：ollama/qwen2.5（自定义 OpenAI 兼容提供商，无 reasoning 元数据），
 * 验证：
 *   1) llm.resolveModelInfo(provider, model) 返回什么（efforts 元数据 / 抛错）；
 *   2) llm.resolveCallConfig 对 effort=high 是否拒绝（UNSUPPORTED_REASONING_EFFORT）；
 *   3) adaptEffort + applyEffort 逻辑在该场景下的行为（应剔除参数）。
 *
 * 运行：node scripts/adapt-probe.mjs
 *       DSH_HOME 设临时目录避免污染 ~/.dsh（默认用工作区 .probe-home）
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, loadLayeredEnv, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const NAME = "dsh-vscode-host";
const __dirname = dirname(fileURLToPath(import.meta.url));
// 探针专用 home：工作区内临时目录，避免污染用户 ~/.dsh
const PROBE_HOME = join(__dirname, ".probe-home");

function bundlePatchFile(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

/** 与 agent-host.mjs composePatches 一致，但 llm-pi-ai 保持启用（探针需要它）。 */
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
    { id: "system-prompt", config: { persona: `You are a coding agent. Working directory: ${currentCwd}.` } },
    { id: "hmr", disabled: true },
    { id: "sandbox-policy", config: { mode: "workspace-write", workspaceRoot: currentCwd } },
    { id: "session-persistence-jsonl", config: { root: join(PROBE_HOME, "sessions") } },
    { id: "session-telemetry-otel", disabled: true },
    { id: "typert-gateway", disabled: true },
  ];
  return [...base, ...filteredHeadless, ...overlay];
}

/** 与 agent-host.mjs adaptEffort / applyEffort 相同的逻辑副本（保持探测一致性）。 */
const EFFORT_ORDER = ["off", "low", "high", "max"];
function adaptEffort(requested, supported) {
  if (!requested) return { value: undefined, adapted: false };
  const list = Array.isArray(supported) ? supported : [];
  if (list.includes(requested)) return { value: requested, adapted: false };
  const idx = EFFORT_ORDER.indexOf(requested);
  for (let i = idx - 1; i >= 0; i--) {
    if (list.includes(EFFORT_ORDER[i])) return { value: EFFORT_ORDER[i], adapted: true };
  }
  return { value: undefined, adapted: true };
}
function applyEffort(request, effort) {
  if (effort === undefined) {
    const { reasoningEffort: _drop, ...rest } = request;
    return rest;
  }
  return { ...request, reasoningEffort: effort };
}

async function main() {
  rmSync(PROBE_HOME, { recursive: true, force: true });
  mkdirSync(join(PROBE_HOME, "profiles", "dsh-vscode-probe"), { recursive: true });
  writeFileSync(
    join(PROBE_HOME, "profiles", "dsh-vscode-probe", "cordis.yml"),
    "# probe — empty entry list\n[]\n"
  );
  process.env.DSH_HOME = PROBE_HOME;

  const environment = loadLayeredEnv(NAME);
  const patches = composePatches(environment);
  const ctx = await boot(NAME, join(PROBE_HOME, "profiles", "dsh-vscode-probe", "cordis.yml"), patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
  });

  try {
    const llm = ctx.get("llm");
    console.log("[probe] llm service:", llm !== undefined ? "available" : "MISSING");
    if (llm === undefined) throw new Error("llm service missing");

    // 注册一个自定义 OpenAI 兼容提供商（模拟用户面板里接入的 ollama）
    const settings = ctx.get("settings");
    if (settings !== undefined && typeof settings.replace === "function") {
      await settings.replace(
        "llm-pi-ai",
        {
          providers: {
            ollama: {
              displayName: "Ollama",
              api: "openai-completions",
              baseURL: "http://localhost:11434/v1",
              models: [{ id: "qwen2.5" }],
            },
            "zai-free": {
              displayName: "Zhipu AI Free",
              api: "openai-completions",
              baseURL: "https://open.bigmodel.cn/api/paas/v4",
              models: [{ id: "GLM-4.7-Flash" }, { id: "glm-4.7" }],
            },
          },
        },
        undefined
      );
      console.log("[probe] llm-pi-ai providers configured: ollama, zai-free");
    } else {
      console.log("[probe] settings service missing — cannot configure providers");
    }

    for (const [provider, model] of [
      ["ollama", "qwen2.5"],
      ["zai-free", "GLM-4.7-Flash"],
    ]) {
      console.log(`\n[probe] === ${provider}/${model} ===`);
      // 1) resolveModelInfo
      try {
        const info = await llm.resolveModelInfo(provider, model);
        const efforts = (info?.reasoning?.efforts ?? []).map((e) => (typeof e === "string" ? e : e?.id));
        console.log("[probe] resolveModelInfo -> reasoning.efforts =", JSON.stringify(efforts));
        // 适配模拟
        const { value, adapted } = adaptEffort("high", efforts);
        console.log(`[probe] adaptEffort(high) -> value=${JSON.stringify(value)} adapted=${adapted}`);
        const applied = applyEffort({ provider, model, reasoningEffort: "high" }, value);
        console.log("[probe] applyEffort 后 request =", JSON.stringify(applied));
      } catch (error) {
        console.log("[probe] resolveModelInfo 抛错:", error instanceof Error ? error.message : String(error));
        console.log("[probe]   (宿主 catch 分支应剔除 effort → 走模型默认)");
      }
      // 2) resolveCallConfig 实测（内核是否拒绝 high）
      try {
        const resolved = await llm.resolveCallConfig({ provider, model, reasoningEffort: "high" });
        console.log("[probe] resolveCallConfig(high) -> 接受:", JSON.stringify(resolved.reasoningEffort ?? "(默认)"));
      } catch (error) {
        console.log("[probe] resolveCallConfig(high) -> 拒绝:", error instanceof Error ? error.message : String(error));
      }
    }

    console.log("\n[probe] done");
  } finally {
    await ctx.fiber.dispose();
  }
}

main().catch((error) => {
  console.error("[probe] failed:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
