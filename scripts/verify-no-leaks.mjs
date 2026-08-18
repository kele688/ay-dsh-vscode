#!/usr/bin/env node
/**
 * verify-no-leaks.mjs — publication gate for ay-dsh-vscode.
 *
 * Scans every git-tracked file for content that must never reach the public
 * repository: internal maintenance machinery (the standalone AI maintainer),
 * machine-local absolute paths, owner identifiers, and credential patterns.
 *
 * Fails (exit 1) on any hit, so CI blocks pushes/PRs that would leak.
 * Local run:  node scripts/verify-no-leaks.mjs   (from the repo root)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* Sensitive patterns. Keywords are assembled at runtime so this very  */
/* script never triggers its own scan.                                 */
/* ------------------------------------------------------------------ */
const W = (...parts) => parts.join("");
const RE = (src) => new RegExp(src);

const FILE_PATTERNS = [
  /MAINTAINER\.md/,
  /[\\/]maintainer[\\/]/,
  /RELEASE-CHECKLIST/,
  /\.github-token/,
  /maintainer\.pid/,
  /(^|[\\/])maintainer\.mjs/,
];

const CONTENT_PATTERNS = [
  { name: "AI-maintainer mention", re: RE(W("AI ", "maintainer")) },
  { name: "start-maintainer", re: RE(W("start-", "maintainer")) },
  { name: "stop-maintainer", re: RE(W("stop-", "maintainer")) },
  { name: "launch-maintainer", re: RE(W("launch-", "maintainer")) },
  { name: "maintainer.mjs reference", re: RE(W("maintainer", "\\.mjs")) },
  { name: "MAINTAINER doc reference", re: RE(W("MAIN", "TAINER")) },
  { name: "fine-grained PAT", re: /github_pat_[A-Za-z0-9]{10,}/ },
  { name: "classic PAT", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "DeepSeek API key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Windows user path", re: /C:\\Users\\[^\\]+/ },
  { name: "D: projects path", re: /D:\\projects/ },
  { name: "VS Code install path", re: /C:\\Program Files\\Microsoft VS Code/ },
];

/* Owner username is legitimate inside the public repo URL
   (github.com/<owner>/ay-dsh-vscode) but nowhere else. */
const USER = W("kele", "688");
const USER_IN_REPO_URL = new RegExp(W("github\\.com/", "kele", "688"), "g");

const OWNER_USERNAME_EXEMPT = new Set([
  "package.json",
  "README.md",
  "README.zh-CN.md",
]);

/* Defense scripts legitimately contain the keywords above. */
const SELF_EXEMPT = new Set([
  "scripts/verify-no-leaks.mjs",
]);

/* ------------------------------------------------------------------ */

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

const violations = [];
for (const f of files) {
  if (SELF_EXEMPT.has(f)) continue;
  const hit = FILE_PATTERNS.find((re) => re.test(f));
  if (hit) {
    violations.push(`${f}: filename matches ${hit}`);
    continue;
  }
  let content;
  try {
    content = readFileSync(join(process.cwd(), f), "utf8");
  } catch {
    continue; // binary or unreadable
  }
  if (content.includes("\0")) continue; // binary asset
  const withoutRepoUrls = content.replace(USER_IN_REPO_URL, "");
  if (!OWNER_USERNAME_EXEMPT.has(f) && withoutRepoUrls.includes(USER)) {
    violations.push(`${f}: content contains owner username outside repo URLs`);
    continue;
  }
  for (const { name, re } of CONTENT_PATTERNS) {
    if (re.test(content)) {
      violations.push(`${f}: content contains ${name}`);
      break;
    }
  }
}

if (violations.length > 0) {
  console.error("✗ Leak scan FAILED — internal machinery or sensitive data would be published:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("✓ Leak scan clean: no internal machinery or sensitive content in tracked files.");
