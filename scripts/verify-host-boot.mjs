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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const smokeHome = join(root, ".smoke-home");
const legacyHome = join(smokeHome, "legacy");
// --keep-home：保留隔离 home 供诊断（宿主日志 dsh-host.log 落在其中）。
// 默认仍清理，避免残留污染下一次冒烟。
const keepHome = process.argv.includes("--keep-home");
// --dump-stderr：成功后也完整打印宿主 stderr（宿主 log() 全部走 stderr），
// 用于核对启动期关键日志（如 "settings service available"）；默认只保留尾部供失败诊断。
const dumpStderr = process.argv.includes("--dump-stderr");
const stderrAll = [];
rmSync(smokeHome, { recursive: true, force: true });
mkdirSync(legacyHome, { recursive: true });

// --entry=<相对路径>：指定要冒烟的宿主入口。默认源文件；发布前应显式跑
// `--entry=host/agent-host.bundle.mjs`，因为扩展运行时优先加载 bundle。
const entryArg = process.argv.find((a) => a.startsWith("--entry="));
const hostScript = entryArg
  ? resolve(root, entryArg.slice("--entry=".length))
  : join(root, "host", "agent-host.mjs");
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
  if (!keepHome) rmSync(smokeHome, { recursive: true, force: true }); // 超时路径也清理临时 home
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
      // exit 帧先于 close 到达：立即打印 stderr 尾部（宿主 boot 错误明细），
      // 否则 CI 日志只能看到 exit 帧摘要，无法定位平台差异根因
      if (stderrTail) console.error(`--- stderr tail ---\n${stderrTail}`);
      child.kill();
      process.exit(1);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  stderrTail = (stderrTail + String(d)).slice(-2000);
  if (dumpStderr) stderrAll.push(String(d));
});

child.on("close", (code) => {
  if (closed) return;
  closed = true;
  clearTimeout(timeout);
  if (keepHome) console.log(`· kept isolated home: ${smokeHome}`);
  else rmSync(smokeHome, { recursive: true, force: true });
  if (sawReady) {
    if (dumpStderr && stderrAll.length > 0) {
      console.log("--- host stderr (full) ---");
      console.log(stderrAll.join(""));
      console.log("--- end host stderr ---");
    }
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
