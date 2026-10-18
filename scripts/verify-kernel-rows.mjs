/**
 * verify-kernel-rows.mjs — 内核装配行检查表（内核升级前必跑）。
 *
 * 背景：插件用 `composePatches()` 自组装补丁树（base + headless 裁剪 + overlay），
 * 而内核对 `cordis.patch.yml` 的行 id / 默认 disabled / 行存在性改动频繁，且漏判后果
 * 多为**静默失效**（例：`settings` 行被 `profileContext` 门控后，provider 配置写入无声失败）。
 *
 * 本脚本把"插件依赖的内核装配事实"固化为可执行检查：
 *   1. overlay 覆盖的 5 行是否仍存在；
 *   2. overlay 禁用的 6 行是否仍存在；
 *   3. headless 裁剪白名单（system-prompt/tools/hmr）是否仍在 headless 补丁；
 *   4. 与插件行为强相关的关键行状态：settings（含 profileContext 门控）、otel、
 *      llm-deepseek*、tool-ralph、mcp-client、llm-pi-ai；
 *   5. 为每项给出对应的**动作提示**（对齐升级方案 P0 项）。
 *
 * 用法：
 *   node scripts/verify-kernel-rows.mjs                 # 自动探测：--kernel → 本地 node_modules → 同级源码树 → 已装 runtime
 *   node scripts/verify-kernel-rows.mjs --kernel <dir>  # 内核源码树根（含 packages/bundle）
 *   node scripts/verify-kernel-rows.mjs --patch <dir>   # bundle 补丁目录（含 base/ 与 headless/）
 *   node scripts/verify-kernel-rows.mjs --json          # 机器可读（CI）
 *
 * 退出码：0 = 无阻断项；1 = 存在阻断项（缺行 / settings 被门控 / headless 白名单缺失）。
 *
 * 设计约束：零依赖。patch 是行式 YAML，行 id 用正则提取，不引入 YAML 解析器。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

/** overlay 覆盖的行：缺失则"整行替换"语义落空。 */
const OVERRIDE_ROWS = ["system-prompt", "sandbox-policy", "tool-subagent", "session-persistence-jsonl", "compaction-basic"];
/** overlay 禁用的行：缺失时禁用无意义（提示级）。 */
const DISABLED_ROWS = ["hmr", "session-telemetry-otel", "typert-gateway", "goal-round-driver", "tool-goal", "command-goal"];
/** headless 裁剪白名单：composePatches 只保留这些行。system-prompt/tools 缺失即裁剪退化；
 *  hmr 是 0.2.0 才新增的可选行（0.1.5 无此行，插件过滤逻辑对它只是空操作）⇒ 缺失仅提示。 */
const HEADLESS_REQUIRED = ["system-prompt", "tools"];
const HEADLESS_OPTIONAL = ["hmr"];

/**
 * 收集 patch 中的行 id。顶层行形如 `  - id: settings`；insert 子项缩进更深，单独收集。
 * @param {string} text - patch 全文。
 * @returns {{ all: Set<string>, insert: Set<string> }}
 */
function parseRowIds(text) {
  const all = new Set();
  const insert = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^(\s*)-\s+id:\s*([A-Za-z0-9._@/-]+)\s*$/);
    if (!m) continue;
    const [, indent, id] = m;
    if (indent.length >= 6) insert.add(id);
    else all.add(id);
  }
  return { all, insert };
}

/**
 * 读取某行 id 下方的 `disabled:` 表达式（用于识别 profileContext 门控）。
 * @returns {string|undefined} 表达式字符串；行存在但无 disabled 时返回 ""；行不存在返回 undefined。
 */
function disabledExprOf(text, rowId) {
  const lines = text.split(/\r?\n/);
  const escaped = rowId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^\\s*-\\s+id:\\s*${escaped}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      if (/^\s*-\s+id:/.test(lines[j])) break;
      const m = lines[j].match(/^\s*disabled:\s*(.+?)\s*$/);
      if (m) return m[1];
    }
    return "";
  }
  return undefined;
}

/** 取目录名"最大"的一个（版本号式命名，字典序即可用）。 */
function latestDir(parent) {
  try {
    const names = readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    return names.length > 0 ? join(parent, names[names.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

/** 宿主源码（静态检查的第二个对象：装配事实的满足方在宿主里）。 */
function hostSource() {
  try {
    return readFileSync(join(root, "host", "agent-host.mjs"), "utf8");
  } catch {
    return "";
  }
}

/** 宿主是否真的提供了 profileContext——settings/config-editor/plugin-manager 的门控条件。 */
function hostProvidesProfileContext() {
  return /provide\(\s*["']profileContext["']/.test(hostSource());
}

/**
 * 宿主是否给 `boot()` 传了裸包名解析锚点（bareModuleBaseUrl）。
 * 0.2.x 的 `boot()` 默认把 include 的 baseUrl 设成配置文件目录（profile，无 node_modules）；
 * 插件自身的插件集随 VSIX 打包 ⇒ 不传锚点时**所有内核行 import 失败**、宿主完全起不来。
 */
function hostPassesBareModuleBaseUrl() {
  return /boot\([\s\S]{0,600}?HOST_INSTALL_BASE_URL\s*\)/.test(hostSource());
}

/**
 * 定位 base/headless 两个 patch 文件。二者在源码树同属 packages/bundle，但在
 * node_modules / runtime 里分属 @deepseek-ai/dsh-base 与 dsh-headless 两个包目录，
 * 故不能假定同一父目录。
 * @returns {{label:string, base:string, headless?:string}|undefined}
 */
function findPatchFiles() {
  /** @type {{label:string, base:string, headless?:string}[]} */
  const cands = [];
  const kernel = argOf("--kernel");
  if (kernel) {
    const b = join(resolve(kernel), "packages", "bundle");
    cands.push({ label: "--kernel source tree", base: join(b, "base", "cordis.patch.yml"), headless: join(b, "headless", "cordis.patch.yml") });
  }
  const patch = argOf("--patch");
  if (patch) {
    const b = resolve(patch);
    cands.push({ label: "--patch bundle dir", base: join(b, "base", "cordis.patch.yml"), headless: join(b, "headless", "cordis.patch.yml") });
  }
  // 插件本地 node_modules（devDependency 已安装时）
  const nm = join(root, "node_modules", "@deepseek-ai");
  cands.push({
    label: "dsh-vscode/node_modules",
    base: join(nm, "dsh-base", "cordis.patch.yml"),
    headless: join(nm, "dsh-headless", "cordis.patch.yml"),
  });
  // 同级源码树
  const sibling = join(root, "..", "deepseek-harness", "packages", "bundle");
  cands.push({
    label: "sibling source tree",
    base: join(sibling, "base", "cordis.patch.yml"),
    headless: join(sibling, "headless", "cordis.patch.yml"),
  });
  // 已安装 runtime（最高版本目录）
  const runtimeHome = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage", "kele688.ay-dsh-vscode", "dsh-runtime");
  const latest = latestDir(runtimeHome);
  if (latest) {
    const rn = join(latest, "node_modules", "@deepseek-ai");
    cands.push({
      label: `installed runtime (${latest.split(/[\\/]/).pop()})`,
      base: join(rn, "dsh-base", "cordis.patch.yml"),
      headless: join(rn, "dsh-headless", "cordis.patch.yml"),
    });
  }
  return cands.find((c) => existsSync(c.base));
}

function main() {
  const found = findPatchFiles();
  if (!found) {
    console.error("✗ 未能定位内核补丁。请用 --kernel <内核源码树根> 或 --patch <bundle 补丁目录> 指定。");
    process.exit(1);
  }
  const baseText = readFileSync(found.base, "utf8");
  const headlessText = found.headless && existsSync(found.headless) ? readFileSync(found.headless, "utf8") : "";
  const base = parseRowIds(baseText);
  const headless = parseRowIds(headlessText);

  /** @type {{kind:"ok"|"warn"|"fail", name:string, detail:string}[]} */
  const findings = [];
  const add = (kind, name, detail) => findings.push({ kind, name, detail });

  for (const id of OVERRIDE_ROWS) {
    if (base.all.has(id)) add("ok", `override:${id}`, "行存在");
    else add("fail", `override:${id}`, "行已不存在 → overlay 整行替换落空，需按新装配调整");
  }
  for (const id of DISABLED_ROWS) {
    if (base.all.has(id)) add("ok", `disable:${id}`, "行存在");
    else add("warn", `disable:${id}`, "行已不存在（禁用变为无意义），确认是否已移除");
  }
  for (const id of HEADLESS_REQUIRED) {
    if (headless.all.has(id) || headless.insert.has(id)) add("ok", `headless:${id}`, "仍在 headless 补丁");
    else add("fail", `headless:${id}`, "headless 补丁缺失 → composePatches 裁剪结果退化");
  }
  for (const id of HEADLESS_OPTIONAL) {
    if (headless.all.has(id) || headless.insert.has(id)) add("ok", `headless:${id}`, "仍在 headless 补丁");
    else add("warn", `headless:${id}`, "headless 无此行（旧版正常；新版才有）→ 过滤逻辑按空操作处理");
  }

  if (!base.all.has("settings")) {
    add("fail", "key:settings", "行缺失 → provider 配置无法写入");
  } else {
    const expr = disabledExprOf(baseText, "settings");
    if (expr && /profileContext/.test(expr)) {
      if (hostProvidesProfileContext()) {
        add("ok", "key:settings", `行被门控（disabled: ${expr}），宿主已 provide('profileContext') → 门控解除`);
      } else {
        add("fail", "key:settings", `行存在但被门控（disabled: ${expr}）→ 必须 hostCtx.provide('profileContext', …)，否则配置静默失效`);
      }
    } else {
      add("ok", "key:settings", "行存在且未被 profileContext 门控");
    }
  }

  // 裸包名解析锚点：0.2.x 起 boot() 从配置文件目录解析裸包名（profile 内无 node_modules）⇒
  // 不传 bareModuleBaseUrl 时所有内核行 import 失败、宿主起不来（0.2.1 实测 86 行）。
  if (hostPassesBareModuleBaseUrl()) {
    add("ok", "key:resolution-anchor", "boot() 已传 HOST_INSTALL_BASE_URL → 内核行从 VSIX node_modules 解析");
  } else {
    add("fail", "key:resolution-anchor", "boot() 未传 bareModuleBaseUrl → 内核行会从 profile 目录解析并全部 ERR_MODULE_NOT_FOUND");
  }

  add(base.all.has("otel") ? "warn" : "ok", "key:otel", base.all.has("otel")
    ? "独立遥测行存在 → overlay 应显式 { id: 'otel', disabled: true }"
    : "无独立 otel 行");

  const dsRows = [...base.all].filter((id) => id.startsWith("llm-deepseek"));
  add(dsRows.length > 0 ? "ok" : "fail", "key:llm-deepseek", `相关行：${dsRows.join(", ") || "（缺失）"}`);
  if (base.all.has("llm-deepseek-account")) {
    add("warn", "key:llm-deepseek-account", "账号路由存在 → providersApply 跳过逻辑需含它，避免与 llm-pi-ai 双注册");
  }

  add(base.all.has("tool-ralph") ? "ok" : "warn", "key:tool-ralph", base.all.has("tool-ralph")
    ? "行存在（确认其默认 disabled 状态）"
    : "行未装配（实验包在 packages/experimental/tool-ralph）→ 需显式加行才启用");

  add(base.all.has("mcp-client") ? "ok" : "warn", "key:mcp-client", base.all.has("mcp-client")
    ? "已装配"
    : "未装配 → 需 MCP 时由 overlay 自加行（mcp-resources 已装配）");

  add(base.all.has("llm-pi-ai") ? "ok" : "fail", "key:llm-pi-ai", base.all.has("llm-pi-ai")
    ? "行存在（settingsNs 跟随行 id）"
    : "行缺失 → 自定义 provider 无法路由");

  const fails = findings.filter((f) => f.kind === "fail");
  const warns = findings.filter((f) => f.kind === "warn");

  if (wantJson) {
    console.log(JSON.stringify({ kernel: found, findings, fails: fails.length, warns: warns.length }, null, 2));
  } else {
    console.log(`[kernel] ${found.label}`);
    console.log(`  base     = ${found.base}`);
    console.log(`  headless = ${found.headless && existsSync(found.headless) ? found.headless : "（缺失）"}`);
    console.log("");
    const icon = { ok: "✓", warn: "!", fail: "✗" };
    for (const f of findings) console.log(`  ${icon[f.kind]} ${f.name.padEnd(32)} ${f.detail}`);
    console.log("");
    console.log(`[结论] ${fails.length} 项阻断 / ${warns.length} 项提示 / ${findings.length - fails.length - warns.length} 项通过`);
  }
  process.exit(fails.length > 0 ? 1 : 0);
}

main();
