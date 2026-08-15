#!/usr/bin/env node
/**
 * verify-host-boot.mjs — host boot smoke test for ay-dsh-vscode.
 *
 * Spawns the real agent host (`host/agent-host.mjs`) in an isolated DSH home
 * and requires a `ready` frame within 90 s, then shuts it down cleanly.
 *
 * Guards against boot regressions that type-checking cannot catch:
 * patch composition (dsh-base/dsh-headless overlays), bundle/resource
 * resolution (`import.meta.resolve`), native dependencies (koffi), and
 * JSONL protocol startup.
 *
 * Usage:  node scripts/verify-host-boot.mjs   (from the repo root)
 * Safety: DSH_HOME / DSH_LEGACY_HOME are forced to a temp dir inside the
 *         repo (`.smoke-home`, gitignored) — the real user home (~/.dsh,
 *         plugin globalStorage) is never touched. No API key is needed
 *         (session creation is lazy; boot only).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const smokeHome = join(root, ".smoke-home");
const legacyHome = join(smokeHome, "legacy");
rmSync(smokeHome, { recursive: true, force: true });
mkdirSync(legacyHome, { recursive: true });

const hostScript = join(root, "host", "agent-host.mjs");
const child = spawn(process.execPath, [hostScript], {
  cwd: root,
  env: {
    ...process.env,
    // 强制隔离：冒烟测试绝不读写真实 DSH home / 用户目录
    DSH_HOME: smokeHome,
    DSH_LEGACY_HOME: legacyHome,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_VSCODE_MODEL: "deepseek-v4-flash",
    DSH_PERMISSION_MODE: "read-only",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let sawReady = false;
let stderrTail = "";
let closed = false;

const timeout = setTimeout(() => {
  console.error("✗ smoke test TIMEOUT — host did not emit `ready` within 90 s");
  child.kill();
  process.exit(1);
}, 90000);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // 非协议行（不应出现在 stdout，容忍）
    }
    if (frame.t === "ready") {
      sawReady = true;
      console.log(`✓ host ready (version=${frame.version}, cwd=${frame.cwd})`);
      child.stdin.write(JSON.stringify({ t: "shutdown" }) + "\n");
    } else if (frame.t === "exit" && !sawReady) {
      console.error(`✗ host exited before ready: code=${frame.code} error=${frame.error ?? ""}`);
      child.kill();
      process.exit(1);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  stderrTail = (stderrTail + String(d)).slice(-2000);
});

child.on("close", (code) => {
  if (closed) return;
  closed = true;
  clearTimeout(timeout);
  rmSync(smokeHome, { recursive: true, force: true });
  if (sawReady) {
    console.log(`✓ host exited cleanly (code ${code})`);
    process.exit(code === 0 ? 0 : 1);
  }
  console.error(`✗ no ready frame; host exited ${code}\n--- stderr tail ---\n${stderrTail}`);
  process.exit(1);
});

child.on("error", (err) => {
  console.error(`✗ failed to spawn host: ${err.message}`);
  process.exit(1);
});
