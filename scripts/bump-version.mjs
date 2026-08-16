#!/usr/bin/env node
/**
 * bump-version.mjs — 版本号自动递增（semver）并同步 CHANGELOG。
 *
 * 同步三处版本号：
 *   1. package.json 的 version（VSIX 打包/市场版本）
 *   2. host/agent-host.mjs 的 CORE_VERSION（宿主上报 UI 的版本，曾与 package.json
 *      不一致，必须同步）
 *   3. CHANGELOG.md 顶部追加一条版本记录（不存在则创建）
 *
 * 用法：
 *   node scripts/bump-version.mjs [patch|minor|major] [--message "变更1；变更2"]
 *   node scripts/bump-version.mjs --dry-run ...   # 只打印将写入的内容，不写文件
 *
 * 说明：摘要默认取 --message；未提供时使用通用文案（建议发布前用 --message 补充）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const hostPath = join(root, "host", "agent-host.mjs");
const changelogPath = join(root, "CHANGELOG.md");

const args = process.argv.slice(2);
const level = (args.find((a) => ["patch", "minor", "major"].includes(a)) ?? "patch");
const dryRun = args.includes("--dry-run");
const messageArg = args[args.indexOf("--message") + 1];

function bumpSemver(v, lvl) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (lvl === "major") { major += 1; minor = 0; patch = 0; }
  else if (lvl === "minor") { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${major}.${minor}.${patch}`;
}

function now() {
  return new Date().toISOString().slice(0, 10);
}

// ---- 读取 ----
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const oldVersion = pkg.version;
const newVersion = bumpSemver(oldVersion, level);
const date = now();

// ---- 组装摘要 ----
const summaryLines = (messageArg ?? "常规更新（bug 修复与体验改进）")
  .split(/[；;]/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => `- ${s}`);

// ---- CHANGELOG 条目 ----
const entry =
  `## [${newVersion}] - ${date}\n\n` +
  `${summaryLines.join("\n")}\n\n`;

// ---- 准备写入 ----
const hostSrc = readFileSync(hostPath, "utf8");
const hostNext = hostSrc.replace(
  /(const CORE_VERSION = ")[^"]*(")/,
  `$1${newVersion}$2`
);
if (!hostNext.includes(`"${newVersion}"`)) {
  throw new Error(`host/agent-host.mjs 中未找到 CORE_VERSION 常量，无法同步版本`);
}

let changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
if (!changelog.startsWith("# Changelog")) {
  changelog = "# Changelog\n\n本文件由 scripts/bump-version.mjs 维护。\n\n" + changelog;
}
const changelogNext = changelog.replace(
  /(# Changelog[^\n]*\n\n)/,
  `$1${entry}`
);

if (dryRun) {
  console.log(`[dry-run] package.json  version: ${oldVersion} -> ${newVersion}`);
  console.log(`[dry-run] agent-host.mjs CORE_VERSION: ${oldVersion} -> ${newVersion}`);
  console.log(`[dry-run] CHANGELOG.md 新增条目:\n${entry.trim()}`);
  console.log("[dry-run] 未写入任何文件");
  process.exit(0);
}

// ---- 写入 ----
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
writeFileSync(hostPath, hostNext, "utf8");
writeFileSync(changelogPath, changelogNext, "utf8");

console.log(`✅ 版本 ${oldVersion} -> ${newVersion}（${level}）`);
console.log(`   已同步：package.json / host/agent-host.mjs (CORE_VERSION) / CHANGELOG.md`);
