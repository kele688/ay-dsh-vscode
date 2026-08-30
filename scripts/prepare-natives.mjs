#!/usr/bin/env node
/**
 * prepare-natives.mjs — ensure cross-platform native binaries are in place
 * before packaging (run on the packaging machine's terminal).
 *
 * Background: one VSIX must install directly on win32/linux/darwin, so
 * node_modules must contain native modules for every platform. npm only
 * installs the current platform and `npm install` prunes "extraneous"
 * packages (not in package.json), so this script deterministically fills
 * the gaps at every package run:
 *   1. koffi platform packages (@koromix/koffi-{linux,darwin}-{x64,arm64})
 *      — downloaded from the npm registry;
 *   2. node-pty linux prebuild — from scripts/.natives/ (built once on a
 *      Linux machine; win32/darwin prebuilds ship with the npm package).
 * Prints a manifest when done; exits with an error if anything is missing.
 *
 * One-time node-pty linux prebuild (needs one Linux machine):
 *   cd <extension-dir>/node_modules/node-pty
 *   npm rebuild node-pty        # requires build-essential + python3 + node-gyp
 *   cp build/Release/pty.node <repo>/scripts/.natives/node-pty-linux-x64.pty.node
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVES = join(root, "scripts", ".natives");
const TMP = join(root, "node_modules", ".prepare-natives-tmp");
const REG = "https://registry.npmjs.org";
const KOFFI_VERSION = "3.1.5";

const REQUIRED_KOFFI = [
  "koffi-linux-x64",
  "koffi-linux-arm64",
  "koffi-darwin-x64",
  "koffi-darwin-arm64",
];
const REQUIRED_PTY = ["linux-x64"]; // linux-arm64 optional (warn only if absent)

/** @vscode/ripgrep 平台包（grep/glob 工具内部 spawn 的打包 rg 二进制）。
 *  npm install 只装当前平台，跨平台 VSIX 若缺某平台包，该平台上工具执行
 *  `require.resolve("@vscode/ripgrep-<plat>/bin/rg")` 会失败 → 报
 *  "ripgrep launch failed"。版本以 node_modules/@vscode/ripgrep 主包为准（勿硬编码）。 */
const REQUIRED_RIPGREP = [
  "ripgrep-linux-x64",
  "ripgrep-linux-arm64",
  "ripgrep-linux-arm",
  "ripgrep-linux-ia32",
  "ripgrep-linux-ppc64",
  "ripgrep-linux-riscv64",
  "ripgrep-linux-s390x",
  "ripgrep-darwin-x64",
  "ripgrep-darwin-arm64",
  "ripgrep-win32-x64",
  "ripgrep-win32-arm64",
  "ripgrep-win32-ia32",
];

/** sharp 平台包（dsh-attachment-local 依赖，图片附件处理）。npm 只装当前平台，
 *  Linux 缺 @img/sharp-linux-x64 + @img/sharp-libvips-linux-x64；跨平台 WASM 兜底
 *  @img/sharp-wasm32 已由 package.json 显式声明（否则 vsce 只按依赖树打包）。
 *  各平台包版本以 sharp 主包 optionalDependencies 声明为准（libvips 与主包版本不同）。 */
const REQUIRED_SHARP = [
  "sharp-linux-x64",
  "sharp-libvips-linux-x64",
  "sharp-linux-arm64",
  "sharp-libvips-linux-arm64",
];

function log(msg) {
  console.log(`[prepare-natives] ${msg}`);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Recursively copy a directory tree (koffi packages contain dirs like linux_x64/). */
function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src)) copyTree(join(src, f), join(dest, f));
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
  }
}

/** 确保一个 scoped 平台包就位（koffi/ripgrep/sharp 通用）：
 *  优先复用本地缓存（scripts/.natives/，gitignored）——首次下载的 tgz 存入缓存，
 *  之后打包直接解压缓存，避免重复下载浪费时间/流量，也避免网络失败阻断打包。
 *  目标已存在且版本匹配时直接跳过。 */
async function ensurePlatformPackage(scope, name, version) {
  const dest = join(root, "node_modules", scope, name);
  const marker = join(dest, "package.json");
  if (existsSync(marker)) {
    let cur = "";
    try { cur = JSON.parse(readFileSync(marker, "utf8")).version || ""; } catch { /* ignore */ }
    if (cur === version) {
      log(`${name}: already present (${cur})`);
      return;
    }
    log(`${name}: version mismatch (${cur || "?"} vs ${version}) — refreshing`);
    rmSync(dest, { recursive: true, force: true });
  }
  const cacheFile = join(NATIVES, `${scope.replace(/^@/, "")}-${name}-${version}.tgz`);
  let tgz;
  if (existsSync(cacheFile)) {
    log(`${name}: using cached tgz (${cacheFile})`);
    tgz = cacheFile;
  } else {
    log(`${name}: downloading ${version}…`);
    const url = `${REG}/${scope}/${name}/-/${name}-${version}.tgz`;
    const res = await fetch(url);
    if (!res.ok) fail(`failed to download ${scope}/${name} (HTTP ${res.status})`);
    mkdirSync(NATIVES, { recursive: true });
    tgz = join(TMP, `${name}.tgz`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    writeFileSync(cacheFile, readFileSync(tgz));
    log(`${name}: cached to ${cacheFile}`);
  }
  const x = join(TMP, name);
  rmSync(x, { recursive: true, force: true });
  mkdirSync(x, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tgz, "-C", x], { stdio: "ignore" });
  if (r.status !== 0) fail(`failed to extract ${scope}/${name}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  copyTree(join(x, "package"), dest);
  log(`${name}: installed`);
}

async function ensureKoffi() {
  // DSH 内核依赖 bare `koffi`（native），其平台原生模块由 `@koromix/koffi-<plat>` 子包提供。
  // 跨平台 VSIX 需补齐各平台子包（linux/darwin 的 x64/arm64），否则对应平台启动会报
  // "Cannot find the native Koffi module"。版本以 bare koffi 主包的实际版本为准（勿硬编码）。
  let koffiVersion = KOFFI_VERSION;
  try {
    koffiVersion = JSON.parse(readFileSync(join(root, "node_modules", "koffi", "package.json"), "utf8")).version || KOFFI_VERSION;
  } catch { /* keep default */ }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const p of REQUIRED_KOFFI) {
    await ensurePlatformPackage("@koromix", p, koffiVersion);
  }
}

/** @vscode/ripgrep 平台包补齐（仿 ensureKoffi）：grep/glob 工具内部 spawn 打包的
 *  rg 二进制，跨平台 VSIX 缺某平台包时，该平台上工具执行
 *  `require.resolve("@vscode/ripgrep-<plat>/bin/rg")` 失败 → 报 "ripgrep launch failed"。
 *  版本以 node_modules/@vscode/ripgrep 主包为准（勿硬编码）。 */
async function ensureRipgrep() {
  let rgVersion = "";
  try {
    rgVersion = JSON.parse(readFileSync(join(root, "node_modules", "@vscode", "ripgrep", "package.json"), "utf8")).version || "";
  } catch { /* keep empty */ }
  if (!rgVersion) fail("cannot resolve @vscode/ripgrep version from node_modules — run npm install first");

  for (const p of REQUIRED_RIPGREP) {
    await ensurePlatformPackage("@vscode", p, rgVersion);
  }
}

/** sharp 平台包补齐（仿 ensureRipgrep）：dsh-attachment-local 依赖 sharp 处理图片附件。
 *  Linux 缺 @img/sharp-linux-x64 + @img/sharp-libvips-linux-x64 时图片功能不可用；
 *  跨平台 WASM 兜底 @img/sharp-wasm32 已由 package.json 显式声明（vsce 只按依赖树打包）。
 *  版本以 sharp 主包 optionalDependencies 声明为准（libvips 与主包版本不同，勿硬编码）。 */
async function ensureSharp() {
  let sharpVersion = "";
  const pkgVersions = {};
  try {
    const sj = JSON.parse(readFileSync(join(root, "node_modules", "sharp", "package.json"), "utf8"));
    sharpVersion = sj.version || "";
    for (const p of REQUIRED_SHARP) {
      const v = sj.optionalDependencies?.[`@img/${p}`];
      if (v) pkgVersions[p] = v;
    }
  } catch { /* keep empty */ }
  if (!sharpVersion) fail("cannot resolve sharp version from node_modules — run npm install first");

  for (const p of REQUIRED_SHARP) {
    await ensurePlatformPackage("@img", p, pkgVersions[p] || sharpVersion);
  }
}

async function ensureNodePty() {
  for (const plat of REQUIRED_PTY) {
    const dest = join(root, "node_modules", "node-pty", "prebuilds", plat, "pty.node");
    if (existsSync(dest)) {
      log(`node-pty ${plat}/pty.node: already present`);
      continue;
    }
    // 1) local cache (scripts/.natives/, gitignored, seeded once)
    const src = join(NATIVES, `node-pty-${plat}.pty.node`);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src));
      log(`node-pty ${plat}/pty.node: copied from local cache`);
      continue;
    }
    // 2) build on the current machine (only when this platform's prebuild is
    //    missing; npm ci on Linux already compiles into build/Release, this is
    //    a fallback that also seeds prebuilds/<plat>/)
    if (process.platform + "-" + process.arch === plat) {
      log(`node-pty ${plat}: prebuild missing, trying local build (needs build-essential/python3/node-gyp)…`);
      const r = spawnSync("npm", ["rebuild", "node-pty"], { cwd: root, stdio: "inherit" });
      const built = join(root, "node_modules", "node-pty", "build", "Release", "pty.node");
      if (r.status === 0 && existsSync(built)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(built));
        log(`node-pty ${plat}/pty.node: built locally`);
        continue;
      }
      log(`node-pty ${plat}: local build failed (check the toolchain)`);
    }
    // 3) download from this project's GitHub Release asset (lets a Windows
    //    packaging machine fill in the linux binary automatically)
    if (plat === "linux-x64") {
      try {
        log(`node-pty ${plat}: trying GitHub Release asset…`);
        const url = "https://github.com/kele688/ay-dsh-vscode/releases/latest/download/node-pty-linux-x64.pty.node";
        const res = await fetch(url);
        if (res.ok) {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          log(`node-pty ${plat}/pty.node: downloaded from GitHub Release`);
          continue;
        }
        log(`node-pty ${plat}: Release asset unavailable (HTTP ${res.status})`);
      } catch (e) {
        log(`node-pty ${plat}: Release download failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    fail(
      `missing ${plat} pty.node. Choose one of:\n` +
        `  a) build it on a Linux machine and place it at ${src}\n` +
        `     (cd <ext>/node_modules/node-pty && npm rebuild node-pty)\n` +
        `  b) retry after this project's GitHub Release ships node-pty-linux-x64.pty.node (auto-download)`
    );
  }
}

// manifest
function manifest() {
  log("packaged manifest (cross-platform native modules):");
  for (const p of REQUIRED_KOFFI) {
    log(`  - @koromix/${p}: ${existsSync(join(root, "node_modules", "@koromix", p, "package.json")) ? "OK" : "MISSING"}`);
  }
  log(`  - node-pty prebuilds: ${existsSync(join(root, "node_modules", "node-pty", "prebuilds")) ? readdirSync(join(root, "node_modules", "node-pty", "prebuilds")).join(", ") : "(none)"}`);
  log(`  - @vscode/ripgrep platform pkgs: ${REQUIRED_RIPGREP.filter((p) => existsSync(join(root, "node_modules", "@vscode", p, "package.json"))).length}/${REQUIRED_RIPGREP.length} present`);
  log(`  - @img/sharp linux pkgs: ${REQUIRED_SHARP.filter((p) => existsSync(join(root, "node_modules", "@img", p, "package.json"))).length}/${REQUIRED_SHARP.length} present (wasm32 fallback: ${existsSync(join(root, "node_modules", "@img", "sharp-wasm32", "package.json")) ? "OK" : "MISSING"})`);
}

try {
  await ensureKoffi();
  await ensureRipgrep();
  await ensureSharp();
  await ensureNodePty();
  rmSync(TMP, { recursive: true, force: true });
  manifest();
  log("cross-platform native modules ready ✓");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
