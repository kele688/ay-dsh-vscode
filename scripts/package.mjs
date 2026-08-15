/**
 * package.mjs — 打包 VSIX（含全部 node_modules 依赖，一键可安装）。
 * 产物输出到 release/ 目录。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function main() {
  // 清空旧的 release
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  // 1. 构建（确保产物最新）
  run(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root });

  // 2. vsce 打包：直接以 node 运行 vsce 的 JS 入口（避免 Windows .cmd shim 问题）。
  //    打包包含 node_modules 中的全部生产依赖（DSH 内核运行时）。
  const vsceEntry = join(root, "node_modules", "@vscode", "vsce", "vsce");
  run(
    process.execPath,
    [
      vsceEntry,
      "package",
      "--skip-license",
      "--allow-missing-repository",
      "-o",
      join(releaseDir, "ay-dsh-vscode.vsix"),
    ],
    { cwd: root }
  );

  const files = readdirSync(releaseDir).filter((f) => f.endsWith(".vsix"));
  if (files.length === 0) throw new Error("打包失败：未生成 .vsix 文件");
  const sizeMB = (statSync(join(releaseDir, files[0])).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ VSIX 打包完成: ${join(releaseDir, files[0])} (${sizeMB} MB)`);
}

main();
