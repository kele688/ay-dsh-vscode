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
    const dest = join(root, "node_modules", "@koromix", p);
    const marker = join(dest, "package.json");
    if (existsSync(marker)) {
      let cur = "";
      try { cur = JSON.parse(readFileSync(marker, "utf8")).version || ""; } catch { /* ignore */ }
      if (cur === koffiVersion) {
        log(`koffi ${p}: already present (${cur})`);
        continue;
      }
      log(`koffi ${p}: version mismatch (${cur || "?"} vs ${koffiVersion}) — refreshing`);
      rmSync(dest, { recursive: true, force: true });
    }
    log(`koffi ${p}: downloading ${koffiVersion}…`);
    const url = `${REG}/@koromix/${p}/-/${p}-${koffiVersion}.tgz`;
    const res = await fetch(url);
    if (!res.ok) fail(`failed to download @koromix/${p} (HTTP ${res.status})`);
    const tgz = join(TMP, `${p}.tgz`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    const x = join(TMP, p);
    mkdirSync(x, { recursive: true });
    const r = spawnSync("tar", ["-xzf", tgz, "-C", x], { stdio: "ignore" });
    if (r.status !== 0) fail(`failed to extract @koromix/${p}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    copyTree(join(x, "package"), dest);
    log(`koffi ${p}: installed`);
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
}

try {
  await ensureKoffi();
  await ensureNodePty();
  rmSync(TMP, { recursive: true, force: true });
  manifest();
  log("cross-platform native modules ready ✓");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
