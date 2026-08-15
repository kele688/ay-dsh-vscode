/**
 * build.mjs — 构建 DSH VS Code 扩展：
 * 1. esbuild 打包 src/extension.ts → dist/extension.js（CJS，external: vscode）
 * 2. esbuild 打包 host/agent-host.mjs → host/agent-host.bundle.mjs（ESM 单文件，
 *    显著减少冷启动时 Node 解析 node_modules 数百个文件的开销；boot 所需
 *    cordis.patch.yml 等资源仍通过 import.meta.resolve 从 node_modules 解析）
 * 3. 复制 src/media/* → media/（webview 静态资源，含图标）
 * 4. 可选 --watch 增量构建
 */
import { build, context } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const extensionOptions = {
  entryPoints: [join(root, "src", "extension.ts")],
  bundle: true,
  outfile: join(root, "dist", "extension.js"),
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

const hostOptions = {
  entryPoints: [join(root, "host", "agent-host.mjs")],
  bundle: true,
  outfile: join(root, "host", "agent-host.bundle.mjs"),
  format: "esm",
  platform: "node",
  target: "node20",
  // 资源类（cordis.patch.yml 等）不在 bundle 内，运行时经 import.meta.resolve 解析
  loader: { ".yml": "empty" },
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

/** 递归复制目录。 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

async function run() {
  if (watch) {
    const ctxA = await context(extensionOptions);
    const ctxB = await context(hostOptions);
    await ctxA.watch();
    await ctxB.watch();
    console.log("[build] watching…");
  } else {
    await build(extensionOptions);
    await build(hostOptions);
    console.log("[build] host bundle → host/agent-host.bundle.mjs");
  }

  // 3. webview 静态资源
  rmSync(join(root, "media"), { recursive: true, force: true });
  copyDir(join(root, "src", "media"), join(root, "media"));
  console.log("[build] media copied → media/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
