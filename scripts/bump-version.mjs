#!/usr/bin/env node
/**
 * bump-version.mjs — 版本号自动递增（semver）并同步 CHANGELOG（中英双语文件）。
 *
 * 同步三处版本号 + 两个 CHANGELOG：
 *   1. package.json 的 version（VSIX 打包/市场版本）
 *   2. host/agent-host.mjs 的 CORE_VERSION（宿主上报 UI 的版本，必须同步）
 *   3. CHANGELOG.md（英文版，对外默认）
 *   4. CHANGELOG.zh-CN.md（中文版，按用户本地语言引用展示）
 *
 * 用法：
 *   node scripts/bump-version.mjs [patch|minor|major] \
 *     --message-en "change1; change2" --message-zh "变更1；变更2"
 *   node scripts/bump-version.mjs --dry-run ...   # 只打印，不写文件
 *
 * 说明：--message-en / --message-zh 分别提供英文、中文摘要；未提供某一语言时
 *   使用该语言的通用文案（建议发布前都补充）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const hostPath = join(root, "host", "agent-host.mjs");
const changelogPath = join(root, "CHANGELOG.md");
const changelogZhPath = join(root, "CHANGELOG.zh-CN.md");

const args = process.argv.slice(2);
const level = (args.find((a) => ["patch", "minor", "major"].includes(a)) ?? "patch");
const dryRun = args.includes("--dry-run");
const enArg = args[args.indexOf("--message-en") + 1];
const zhArg = args[args.indexOf("--message-zh") + 1];

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

// ---- 组装双语摘要 ----
const enLines = (enArg ?? "Routine update (bug fixes and experience improvements)")
  .split(/[;；]/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => `- ${s}`);
const zhLines = (zhArg ?? "常规更新（bug 修复与体验改进）")
  .split(/[;；]/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => `- ${s}`);

// ---- 双语 CHANGELOG 条目 ----
const entryEn =
  `## [${newVersion}] - ${date}\n\n` +
  `${enLines.join("\n")}\n\n`;
const entryZh =
  `## [${newVersion}] - ${date}\n\n` +
  `${zhLines.join("\n")}\n\n`;

// ---- 准备写入 ----
const hostSrc = readFileSync(hostPath, "utf8");
const hostNext = hostSrc.replace(
  /(const CORE_VERSION = ")[^"]*(")/,
  `$1${newVersion}$2`
);
if (!hostNext.includes(`"${newVersion}"`)) {
  throw new Error(`host/agent-host.mjs 中未找到 CORE_VERSION 常量，无法同步版本`);
}

/** 更新一个 CHANGELOG 文件：不存在则创建（含标题/维护注释），在标题后插入新条目。 */
function writeChangelog(path, title, note, entry) {
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!content.startsWith(title)) {
    content = `${title}\n\n${note}\n\n` + content;
  }
  const next = content.replace(
    new RegExp(`(${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n\\n)`),
    `$1${entry}`
  );
  writeFileSync(path, next, "utf8");
}

if (dryRun) {
  console.log(`[dry-run] package.json  version: ${oldVersion} -> ${newVersion}`);
  console.log(`[dry-run] agent-host.mjs CORE_VERSION: ${oldVersion} -> ${newVersion}`);
  console.log(`[dry-run] CHANGELOG.md 新增条目 (EN):\n${entryEn.trim()}`);
  console.log(`[dry-run] CHANGELOG.zh-CN.md 新增条目 (ZH):\n${entryZh.trim()}`);
  console.log("[dry-run] 未写入任何文件");
  process.exit(0);
}

// ---- 写入 ----
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
writeFileSync(hostPath, hostNext, "utf8");
writeChangelog(changelogPath, "# Changelog", "Maintained by scripts/bump-version.mjs.", entryEn);
writeChangelog(
  changelogZhPath,
  "# 更新日志",
  "本文件由 scripts/bump-version.mjs 维护；按用户本地语言（zh-CN）引用展示。",
  entryZh
);

console.log(`✅ 版本 ${oldVersion} -> ${newVersion}（${level}）`);
console.log(`   已同步：package.json / host/agent-host.mjs (CORE_VERSION) / CHANGELOG.md (EN) / CHANGELOG.zh-CN.md (ZH)`);
