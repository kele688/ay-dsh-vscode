/**
 * dshUpdater.ts — DSH 运行时更新检测器（P1：可见性 + 闲时检测）。
 *
 * 设计依据见插件设计决策文档（AY-DSH 插件改进方案选取依据）§1。
 * 要点：
 * - lastCheckAt 持久化（workspaceState），跨插件生命周期：距上次成功检测 ≥24h 才检，
 *   并非每次启动都检；
 * - 执行条件：启动满 1 分钟 且 无活动对话（空闲门控）；有活动对话则每 1 分钟退避重试，
 *   直到成功检测（无论有无更新）后记录 lastCheckAt，再隔 24h 才下次检测；
 * - 结果处理：有更新 → 仅日志记录候选（采纳交互属 P3）；无更新 → 无事发生；
 *   不兼容/超范围 → 静默忽略（不提示、不降级）；
 * - 检测为闲时低优先级任务，绝不阻塞启动、不打扰用户。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

const DSH_PKG = "@deepseek-ai/dsh-app-boot";
const REGISTRY_URL = `https://registry.npmjs.org/${DSH_PKG}`;
/** 距上次成功检测 ≥ 24h 才安排检测。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 忙碌退避：有活动对话时每 1 分钟重试。 */
const IDLE_RETRY_MS = 60 * 1000;
/** 启动满 1 分钟才允许检测。 */
const STARTUP_DELAY_MS = 60 * 1000;
/** lastCheckAt 的 workspaceState 键（导出：重置命令需清除以强制重新检测）。 */
export const LAST_CHECK_KEY = "dshLastCheckAt";

export interface DshUpdaterDeps {
  workspaceState: vscode.Memento;
  extensionPath: string;
  /** 是否正在活动对话（host.status === running）。 */
  isChatActive: () => boolean;
  /** 日志输出（走扩展输出通道）。 */
  log: (msg: string) => void;
  /** 发现更新的 DSH 版本时回调（由运行时管理器评估并触发采纳 UI）。 */
  onCandidate?: (latest: string) => void;
}

/** 解析 VSIX 内置（插件发布时锁定）的 DSH 版本；缺失返回 undefined。 */
export function bundledDshVersion(extensionPath: string): string | undefined {
  try {
    const p = path.join(extensionPath, "node_modules", DSH_PKG, "package.json");
    const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
    return pkg.version || undefined;
  } catch {
    return undefined;
  }
}

/** 按 semver 规则比较预发布标识符（"rc.7" > "rc.6"；正式版 > 预发布）。 */
function comparePre(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1; // 正式版 > 预发布
  if (b === undefined) return -1;
  const tok = (s: string): Array<number | string> =>
    s.split(".").map((t) => {
      const n = Number(t);
      return Number.isNaN(n) ? t : n;
    });
  const A = tok(a);
  const B = tok(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? -1;
    const y = B[i] ?? -1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "string") return -1; // 数字段 < 字符串段
    if (typeof x === "string" && typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 宽松 semver 比较（正确处理 0.1.0-rc.6 / 0.1.0-rc.7 预发布号）。 */
export function semverGt(a: string, b: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(a.trim());
  const n = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(b.trim());
  if (!m || !n) return false;
  const core = [Number(m[1]) - Number(n[1]), Number(m[2]) - Number(n[2]), Number(m[3]) - Number(n[3])];
  for (const d of core) {
    if (d !== 0) return d > 0;
  }
  return comparePre(m[4], n[4]) > 0;
}

/**
 * 启动 DSH 更新检测调度器。返回 Disposable（deactivate 时清理）。
 * 每分钟 tick 一次；满足"启动 ≥1 分钟 + 空闲 + 距上次 ≥24h"才真正执行 registry 查询。
 */
export function startDshUpdateChecker(deps: DshUpdaterDeps): vscode.Disposable {
  const startedAt = Date.now();
  let checking = false;

  const tick = async (): Promise<void> => {
    if (checking) return;
    const last = deps.workspaceState.get<number>(LAST_CHECK_KEY) ?? 0;
    // 跨生命周期：24h 内已成功检测过 → 本会话不检（满 24h 的后续会话再检）
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
    // 启动满 1 分钟
    if (Date.now() - startedAt < STARTUP_DELAY_MS) return;
    // 空闲门控：有活动对话 → 下轮（1 分钟）再试
    if (deps.isChatActive()) return;
    checking = true;
    try {
      const res = await fetch(REGISTRY_URL, { headers: { "User-Agent": "ay-dsh-vscode" } });
      if (!res.ok) {
        deps.log(`[dsh-updater] registry check failed (HTTP ${res.status}) — will retry next cycle`);
        return;
      }
      const info = (await res.json()) as { "dist-tags"?: Record<string, string> };
      const tags = (info["dist-tags"] ?? {}) as Record<string, string>;
      const latest = tags.latest;
      const next = tags.next;
      const bundled = bundledDshVersion(deps.extensionPath);
      if (latest && bundled && semverGt(latest, bundled)) {
        deps.log(`[dsh-updater] new DSH ${latest} available (latest=${latest}, next=${next ?? "—"}, bundled=${bundled})`);
        // 候选移交运行时管理器（黑名单/忽略过滤 + 采纳 UI 由调用方决定）
        if (deps.onCandidate) deps.onCandidate(latest);
      } else {
        deps.log(`[dsh-updater] DSH up to date (latest=${latest ?? "unknown"}, next=${next ?? "—"}, bundled=${bundled ?? "unknown"})`);
      }
      // 成功检测（无论有无更新）→ 记录时间，24h 后再检
      await deps.workspaceState.update(LAST_CHECK_KEY, Date.now());
    } catch (e) {
      // 网络异常：不记录时间（下轮重试），不打扰
      deps.log(`[dsh-updater] check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, IDLE_RETRY_MS);
  return { dispose: () => clearInterval(timer) };
}
