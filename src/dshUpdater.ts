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
import { DSH_PACKAGE_METADATA_URL, bundledDshVersion, semverGt } from "./dshVersion";

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
  /** 发现可升级的 DSH 候选版本时回调（可能来自 latest 或 next 标签，见检测处通道
   *  规则；由运行时管理器评估黑名单/忽略并触发采纳 UI）。 */
  onCandidate?: (candidate: string) => void;
}

// 版本比较与内置版本解析已收敛到 ./dshVersion（唯一真源）；此处 re-export 供兼容
// （extension.ts 等仍按旧路径导入）。
export { bundledDshVersion, semverGt };

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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(DSH_PACKAGE_METADATA_URL, { headers: { "User-Agent": "ay-dsh-vscode" }, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        deps.log(`[dsh-updater] registry check failed (HTTP ${res.status}) — will retry next cycle`);
        return;
      }
      const info = (await res.json()) as { "dist-tags"?: Record<string, string> };
      const tags = (info["dist-tags"] ?? {}) as Record<string, string>;
      const latest = tags.latest;
      const next = tags.next;
      const bundled = bundledDshVersion(deps.extensionPath);
      // npm dist-tag 语义（2026-09 实测 DSH 官方发布习惯）：
      //   latest 标签可能长期停在旧版（曾见 latest=0.1.0-rc.6），新 rc/预发布都发在
      //   next 标签（next=0.1.2-rc.1）——"latest 标签"≠"远端最高版本"。旧逻辑只比较
      //   latest 会漏报更新，且日志 "up to date" 有误导（next 明明更高却不提示）。
      // 通道规则：
      //   - 插件内置版本为预发布（含 -rc/beta 等）→ 用户处于 next/rc 通道：
      //     候选 = max(latest, next)（语义更高者），两个标签都纳入；
      //   - 插件内置为正式版 → 只跟随 stable 通道（latest）：next 的预发布不自动
      //     推送给正式版用户（避免未经预览的 rc 打扰），next 仅留日志参考。
      const bundledPre = typeof bundled === "string" && /-/.test(bundled);
      let candidate: string | undefined;
      let chosenTag: string | undefined;
      const consider = (tag: string | undefined, tagName: string): void => {
        if (!tag) return;
        if (!bundledPre && tagName === "next") return; // 正式版用户不自动跟 next
        if (candidate === undefined || semverGt(tag, candidate)) {
          candidate = tag;
          chosenTag = tagName;
        }
      };
      consider(latest, "latest");
      consider(next, "next");
      if (candidate && bundled && semverGt(candidate, bundled)) {
        deps.log(`[dsh-updater] new DSH ${candidate} available (tag=${chosenTag}, latest=${latest ?? "—"}, next=${next ?? "—"}, bundled=${bundled})`);
        // 候选移交运行时管理器（黑名单/忽略过滤 + 采纳 UI 由调用方决定）
        if (deps.onCandidate) deps.onCandidate(candidate);
      } else {
        // 未命中更新：日志同时给出两个 tag 的真实值，供人工判断发布通道状态
        deps.log(`[dsh-updater] DSH up to date (latest=${latest ?? "—"}, next=${next ?? "—"}, bundled=${bundled ?? "unknown"})`);
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
