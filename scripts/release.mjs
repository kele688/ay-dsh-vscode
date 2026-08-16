#!/usr/bin/env node
/**
 * release.mjs — 一键发布流水线（本地执行链）。
 *
 * 流程：版本递增（bump-version）→ 构建（build.mjs）→ 打包 VSIX（package.mjs）
 *       → 输出产物路径与 GitHub Release 发布指引。
 *
 * 用法：
 *   node scripts/release.mjs                  # 默认 patch 递增
 *   node scripts/release.mjs --bump minor --message "新增 X；修复 Y"
 *   node scripts/release.mjs --no-bump        # 不递增版本，仅构建打包
 *
 * 说明：
 *   - 子进程（build/package）在受限沙箱内需提权执行，或由用户在终端直接运行；
 *   - GitHub Release 发布需要 release 权限的 token：本脚本只生成 `gh release
 *     create` 命令（供用户确认后执行），不自动发布——发布权限与 token 归属
 *     owner 管理（见维护文档的发布路线图）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bumpLevel = args[args.indexOf("--bump") + 1] ?? "patch";
const message = args[args.indexOf("--message") + 1];
const noBump = args.includes("--no-bump");

function run(step, cmd, cmdArgs) {
  console.log(`\n=== ${step} ===`);
  const res = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`✗ ${step} 失败（exit ${res.status}）`);
    process.exit(res.status ?? 1);
  }
  console.log(`✓ ${step} 完成`);
}

try {
  if (noBump) {
    console.log("跳过版本递增（--no-bump）");
  } else {
    const bumpArgs = [join(root, "scripts", "bump-version.mjs"), bumpLevel];
    if (message) bumpArgs.push("--message", message);
    run("版本递增", process.execPath, bumpArgs);
  }
  run("构建（esbuild bundle + media）", process.execPath, [join(root, "scripts", "build.mjs")]);
  run("打包 VSIX", process.execPath, [join(root, "scripts", "package.mjs")]);

  const releaseDir = join(root, "release");
  const vsix = readdirSync(releaseDir)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => ({ f, t: statSync(join(releaseDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!vsix) throw new Error("release/ 下未找到 VSIX 产物");

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tag = `v${pkg.version}`;
  const asset = join(releaseDir, vsix.f).replace(/\\/g, "/");
  console.log(`\n========================================================`);
  console.log(`  🎉 发布准备完成：${pkg.name} v${pkg.version}`);
  console.log(`  VSIX: ${asset}`);
  console.log(`  发布为 GitHub Release（需 release 权限 token，由 owner 执行）：`);
  console.log(`    gh release create ${tag} "${asset}" --title "${tag}" --notes "见 CHANGELOG.md"`);
  console.log(`  或上传现有资产：`);
  console.log(`    gh release upload ${tag} "${asset}" --clobber`);
  console.log(`========================================================`);
} catch (error) {
  console.error("✗ 发布流程失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
