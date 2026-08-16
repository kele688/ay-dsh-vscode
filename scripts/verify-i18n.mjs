#!/usr/bin/env node
/**
 * verify-i18n.mjs — 国际化（i18n）一致性自动检测。
 *
 * 检测范围：
 *   1. src/media/chat.js 的 I18N.zh / I18N.en —— 两语言键集合必须完全一致
 *      （缺键 → 该语言显示 key 名；多余键 → 无意义冗余），并检查 t("key")
 *      字面量引用的键都存在；
 *   2. src/webviewPanel.ts、src/configPanel.ts、src/media/config-panel.js 的
 *      L 对象 —— 检查 ${L.key} 模板引用都存在（缺键会渲染成 undefined）。
 *
 * 用法：node scripts/verify-i18n.mjs        （问题列表 + exit 1）
 * 接入：CI（.github/workflows/ci.yml）与本地开发自验证。
 *
 * 说明：本脚本是纯文本启发式检测（不做 AST），误报时人工核对即可。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 从 openIdx（指向 '{'）取到匹配 '}' 的完整对象字面量文本。 */
function sliceObject(src, openIdx) {
  let depth = 0;
  let inS = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inS !== null) {
      if (c === "\\") { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** 提取对象字面量顶层键（按行启发式：行首（含缩进）或", "后的 `key:`，
 *  兼容一行多键；不匹配字符串/模板内容里的冒号，如 `⏳ Queue:` 前的非逗号空白）。 */
function extractKeys(block) {
  const keys = [];
  const inner = block.slice(1, -1);
  for (const line of inner.split("\n")) {
    for (const m of line.matchAll(/(?:^\s*|,\s*)([A-Za-z_$][\w$]*)\s*:/g)) {
      keys.push(m[1]);
    }
  }
  return keys;
}

function findNamedObject(src, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  return sliceObject(src, m.index + m[0].lastIndexOf("{"));
}

const problems = [];
function check(ok, file, msg) {
  if (!ok) problems.push(`${file}: ${msg}`);
}

// ---- 1. chat.js I18N.zh / I18N.en ----
{
  const file = "src/media/chat.js";
  const src = readFileSync(join(root, file), "utf8");
  const i18nBlock = findNamedObject(src, "I18N");
  if (!i18nBlock) {
    check(false, file, "未找到 I18N 对象");
  } else {
    const zhMatch = /zh\s*:\s*\{/.exec(i18nBlock);
    const enMatch = /en\s*:\s*\{/.exec(i18nBlock);
    const zhKeys = zhMatch ? extractKeys(sliceObject(i18nBlock, zhMatch.index + zhMatch[0].lastIndexOf("{"))) : [];
    const enKeys = enMatch ? extractKeys(sliceObject(i18nBlock, enMatch.index + enMatch[0].lastIndexOf("{"))) : [];
    const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
    const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
    if (onlyZh.length) check(false, file, `I18N.zh 有 en 缺失的键: ${onlyZh.join(", ")}`);
    if (onlyEn.length) check(false, file, `I18N.en 有 zh 缺失的键: ${onlyEn.join(", ")}`);
    // t("key") 引用完整性（以 zh 键集为准）
    const refs = [...src.matchAll(/\bt\("([A-Za-z_$][\w$]*)"\)/g)].map((m) => m[1]);
    const missing = [...new Set(refs)].filter((k) => !zhKeys.includes(k));
    if (missing.length) check(false, file, `t("...") 引用了不存在的键: ${missing.join(", ")}`);
    console.log(`✓ ${file}: zh ${zhKeys.length} 键 / en ${enKeys.length} 键 / ${new Set(refs).size} 处 t() 引用`);
  }
}

// ---- 2. L 对象（模板引用完整性） ----
for (const file of ["src/webviewPanel.ts", "src/configPanel.ts", "src/media/config-panel.js"]) {
  const src = readFileSync(join(root, file), "utf8");
  const block = findNamedObject(src, "L");
  if (!block) {
    check(false, file, "未找到 L 对象");
    continue;
  }
  const keys = extractKeys(block);
  // webviewPanel/configPanel 用模板引用 ${L.xxx}；config-panel.js 用拼接引用 L.xxx
  const refs = [...src.matchAll(/\$\{L\.([A-Za-z_$][\w$]*)\}|\bL\.([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1] ?? m[2]);
  const missing = [...new Set(refs)].filter((k) => !keys.includes(k));
  if (missing.length) check(false, file, `L.xxx 引用了不存在的键: ${missing.join(", ")}`);
  console.log(`✓ ${file}: L 对象 ${keys.length} 键 / ${new Set(refs).size} 处引用`);
}

// ---- 汇总 ----
if (problems.length > 0) {
  console.error("\n✗ i18n 检测发现问题：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n✓ i18n 检测通过：zh/en 键对齐，引用完整。");
