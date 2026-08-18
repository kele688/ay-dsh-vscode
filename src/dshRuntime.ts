/**
 * dshRuntime.ts — DSH 运行时管理器（P2：动态解析最小依赖集 → 自检 → 启用/回滚/黑名单）。
 *
 * 设计依据见插件设计决策文档（AY-DSH 插件改进方案选取依据）§1。
 * 状态机（持久化于 workspaceState）：
 *   currentVersion     当前生效版本（顶栏显示；初始 = VSIX 内置）
 *   knownGoodVersion   上一个可正常工作版本（只升不降；初始 = VSIX 内置）
 *   failedVersions[]   失败版本黑名单（不再推荐，须有更新的适配版本才重新推荐）
 *   ignoredVersions[]  用户点"忽略"的版本（同样不再推荐，直到更新的版本出现）
 * 用户可见提示仅两条：状态栏「升级成功」/「升级失败」；过程性事件只写日志。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

const DSH_PKG = "@deepseek-ai/dsh-app-boot";
const REGISTRY_URL = `https://registry.npmjs.org/${DSH_PKG}`;
const KEY_CURRENT = "dshRuntimeCurrentVersion";
const KEY_KNOWN_GOOD = "dshRuntimeKnownGoodVersion";
const KEY_PREVIOUS = "dshRuntimePreviousVersion";
const KEY_FAILED = "dshRuntimeFailedVersions";
const KEY_IGNORED = "dshRuntimeIgnoredVersions";
/** 宿主自检超时（毫秒）。 */
const SELF_TEST_TIMEOUT_MS = 45_000;
/** 运行期崩溃检测时间窗：窗口内连续异常退出达到阈值才判定版本不稳定（crash-loop）。 */
const CRASH_WINDOW_MS = 5 * 60 * 1000;
/** 时间窗内连续异常退出达到该次数 → 回退（仅重启不足以自愈）。 */
const CRASH_THRESHOLD = 3;
/** 升级版本稳定门槛：累计运行 >1 小时。 */
const STABLE_RUN_MS = 60 * 60 * 1000;
/** 升级版本稳定门槛：累计对话 >10 次。 */
const STABLE_CHATS = 10;
/** 版本稳定性统计键（workspaceState）：{ version: { runMs, chats } }。 */
const KEY_STABILITY = "dshRuntimeStability";

export interface DshRuntimeDeps {
  extensionPath: string;
  /** globalStorage 目录（运行时闭包存放于 <globalStorage>/dsh-runtime/<版本>/）。 */
  globalStoragePath: string;
  workspaceState: vscode.Memento;
  /** 宿主可执行文件（自检/升级后以同一 Node 运行重定向器）。 */
  nodeResolver: () => Promise<string | null>;
  /** 宿主入口脚本（agent-host.bundle.mjs 绝对路径）。 */
  hostScript: () => string;
  /** 宿主 ESM 重定向器的命令行参数（Node ≥22.12 用 `-r` CJS preload 规避
   *  Node 24 Windows 的 main 加载回归；旧 Node 回退 --experimental-loader）。 */
  loaderArgs: () => string[];
  log: (msg: string) => void;
  /** 状态栏提示（仅升级成功/失败两类，由调用方本地化）。 */
  statusBar: (msg: string) => void;
}

export class DshRuntimeManager {
  constructor(private readonly deps: DshRuntimeDeps) {}

  /* ---------------- 状态存取 ---------------- */

  get currentVersion(): string | undefined {
    return this.deps.workspaceState.get<string>(KEY_CURRENT) ?? bundledDshVersion(this.deps.extensionPath);
  }

  /** 稳定基线版本（崩溃回退目标）：初始 = VSIX 内置；升级版本须稳定运行
   *  （>1h + >10 次对话，见 tryPromotePrevious）才提升。始终有值（兜底内置）。
   *  公开供调用方判断"当前是否试用版本"（current !== previous → 立即重启策略）。 */
  get previousVersion(): string | undefined {
    return this.deps.workspaceState.get<string>(KEY_PREVIOUS) ?? bundledDshVersion(this.deps.extensionPath);
  }

  private get failedVersions(): string[] {
    return this.deps.workspaceState.get<string[]>(KEY_FAILED) ?? [];
  }

  private get ignoredVersions(): string[] {
    return this.deps.workspaceState.get<string[]>(KEY_IGNORED) ?? [];
  }

  private setState(key: string, value: unknown): void {
    void this.deps.workspaceState.update(key, value);
  }

  /** 当前生效的闭包 node_modules 目录；未升级（用 VSIX 内置）返回 undefined。 */
  runtimeNodeModules(): string | undefined {
    const ver = this.currentVersion;
    if (!ver) return undefined;
    const dir = this.runtimeRoot(ver);
    return fs.existsSync(path.join(dir, "node_modules", DSH_PKG, "package.json")) ? path.join(dir, "node_modules") : undefined;
  }

  private runtimeRoot(version: string): string {
    return path.join(this.deps.globalStoragePath, "dsh-runtime", version);
  }

  /* ---------------- 候选评估（由检测器闲时调用） ---------------- */

  /** 评估候选版本：满足"更新 + 不在黑名单/忽略"则返回 true（由调用方触发采纳 UI）。 */
  isCandidate(latest: string | undefined): boolean {
    if (!latest) return false;
    const cur = this.currentVersion;
    if (cur && !semverGt(latest, cur)) return false;
    if (this.failedVersions.includes(latest)) return false;
    if (this.ignoredVersions.includes(latest)) return false;
    return true;
  }

  /** 记录用户"忽略"：该版本不再推荐，直到出现更新的版本。 */
  ignore(latest: string): void {
    const set = new Set(this.ignoredVersions);
    set.add(latest);
    this.setState(KEY_IGNORED, [...set]);
    this.deps.log(`[dsh-runtime] ignored DSH ${latest} (user choice)`);
  }

  /* ---------------- 升级（动态解析最小依赖集） ---------------- */

  /**
   * 采纳候选版本：隔离目录 npm install 插件最小依赖集 → 校验版本 → 宿主自检 →
   * 成功则切换（状态栏「升级成功」）。
   * 失败分级：安装/网络/环境失败（阶段 A）**不进黑名单**（可重试）；
   * 版本不符/自检失败（阶段 B/C，版本本身问题）**进黑名单**。
   */
  async upgrade(latest: string): Promise<boolean> {
    this.deps.log(`[dsh-runtime] upgrading DSH to ${latest} …`);
    const root = this.runtimeRoot(latest);
    const failStatus = () =>
      this.deps.statusBar(vscode.env.language.startsWith("zh") ? "✗ DSH 升级失败" : "✗ DSH upgrade failed");
    // 阶段 A：安装 + 版本校验（环境/网络失败不拉黑）
    let installed: string | undefined;
    try {
      fs.mkdirSync(root, { recursive: true });
      const specs = this.minimalDependencySpecs(latest);
      // Windows 下 npm.cmd 必须走 shell（CreateProcess 直执行 .cmd 会 EINVAL）
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      execFileSync(npm, ["install", "--prefix", root, "--no-audit", "--no-fund", "--no-package-lock", ...specs], {
        cwd: root,
        stdio: "pipe",
        timeout: 5 * 60 * 1000,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      // bundledDshVersion(x) 读 <x>/node_modules/@deepseek-ai/dsh-app-boot，传 root 即可
      installed = bundledDshVersion(root);
      if (!installed || !semverGt(installed, this.currentVersion ?? "")) {
        throw new Error(`resolved dsh-app-boot=${installed ?? "?"}, not newer than current`);
      }
    } catch (e) {
      // 失败明细（含 npm stdout/stderr，便于定位 ERESOLVE 等依赖冲突）
      const detail =
        e && typeof e === "object" && "stdout" in e
          ? String((e as { stdout?: unknown }).stdout ?? "") + String((e as { stderr?: unknown }).stderr ?? "")
          : "";
      const reason = `${e instanceof Error ? e.message : String(e)}${detail ? `\n${detail}` : ""}`;
      failStatus();
      // 安装/环境失败：不黑名单（瞬时网络/npm 问题，稍后可重试）
      this.deps.log(`[dsh-runtime] DSH ${latest} install/verify FAILED: ${reason} — NOT blacklisted (transient, retry later)`);
      return false;
    }
    // 阶段 B：宿主自检（版本本身问题 → 黑名单）
    try {
      const ok = await this.selfTest(root);
      if (!ok) throw new Error("host self-test failed with the new runtime");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const failed = new Set(this.failedVersions);
      failed.add(latest);
      this.setState(KEY_FAILED, [...failed]);
      failStatus();
      this.deps.log(`[dsh-runtime] DSH ${latest} self-test FAILED: ${reason} — blacklisted`);
      return false;
    }
    // 阶段 C：启用。previousVersion（稳定基线）保持不变——升级版本须稳定运行
    // （>1h + >10 次对话，见 tryPromotePrevious）才提升为基线；self-test 通过只证明"能启动"。
    this.setState(KEY_CURRENT, installed);
    this.deps.statusBar(vscode.env.language.startsWith("zh") ? "✅ DSH 已升级" : "✅ DSH upgraded");
    this.deps.log(`[dsh-runtime] DSH upgraded to ${installed} (self-test passed)`);
    return true;
  }

  /** 运行异常回滚（降级链）：current → previous（稳定基线）→ VSIX 内置。
   *  前 3 次崩溃后调用：试用版本回退到稳定基线；基线即当前版本（已回退过）时降级到
   *  VSIX 内置；已是最低（内置）则无可退——此后由调用方转入无限指数退避。 */
  markRuntimeFailed(version: string): void {
    const failed = new Set(this.failedVersions);
    failed.add(version);
    this.setState(KEY_FAILED, [...failed]);
    const prev = this.previousVersion;
    const bundled = bundledDshVersion(this.deps.extensionPath);
    let target: string | undefined;
    if (prev && prev !== version) {
      target = prev; // 回退到稳定基线（验证过的好版本）
    } else if (bundled && bundled !== version && prev !== bundled) {
      target = bundled; // 基线即当前且非内置 → 降级到 VSIX 内置（最后底线），基线同步为内置
      this.setState(KEY_PREVIOUS, bundled);
    }
    if (target) {
      this.setState(KEY_CURRENT, target);
      this.deps.statusBar(vscode.env.language.startsWith("zh") ? "✗ DSH 升级失败（已回滚）" : "✗ DSH upgrade failed (rolled back)");
      this.deps.log(`[dsh-runtime] runtime ${version} failed — rolled back to ${target}${target === bundled ? " (bundled)" : ""}`);
    } else {
      // 已是 VSIX 内置（最低底线）：无更低可退，交由调用方持续指数退避
      this.deps.log(`[dsh-runtime] runtime ${version} failed — no lower version (bundled baseline), continuing backoff`);
    }
  }

  /* ---------------- 运行期崩溃检测（重启 vs 回退） ---------------- */

  /** 各版本运行期崩溃计数（进程内；宿主正常就绪后清零）。 */
  private crashCounts = new Map<string, { count: number; firstAt: number }>();

  /**
   * 宿主异常退出时记录并决策：
   * 时间窗内连续崩溃 < 阈值 → 仅重启同版本（瞬时故障，版本本身可能没问题）；
   * ≥ 阈值 → 判定版本不稳定 → 回退（markRuntimeFailed）+ 黑名单。
   * 返回 "restart"（仅重启）| "rollback"（回退版本）。
   */
  noteHostCrash(version: string): "restart" | "rollback" {
    const now = Date.now();
    const prev = this.crashCounts.get(version);
    const count = prev && now - prev.firstAt < CRASH_WINDOW_MS ? prev.count + 1 : 1;
    this.crashCounts.set(version, { count, firstAt: now });
    if (count >= CRASH_THRESHOLD) {
      this.deps.log(`[dsh-runtime] runtime ${version} crashed ${count}x within window — rolling back`);
      this.markRuntimeFailed(version);
      return "rollback";
    }
    this.deps.log(`[dsh-runtime] runtime ${version} exited abnormally (${count}/${CRASH_THRESHOLD} in window) — restarting same version`);
    return "restart";
  }

  /** 宿主正常就绪：该版本能正常启动工作，清零崩溃计数。 */
  markHostHealthy(version: string): void {
    this.crashCounts.delete(version);
  }

  /* ---------------- 稳定基线提升（previous 门槛） ---------------- */

  /** 当前版本的稳定性统计（持久化，跨宿主重启累计）。 */
  private stability(version: string): { runMs: number; chats: number } {
    const all = this.deps.workspaceState.get<Record<string, { runMs: number; chats: number }>>(KEY_STABILITY) ?? {};
    return all[version] ?? { runMs: 0, chats: 0 };
  }

  private saveStability(version: string, s: { runMs: number; chats: number }): void {
    const all = this.deps.workspaceState.get<Record<string, { runMs: number; chats: number }>>(KEY_STABILITY) ?? {};
    all[version] = s;
    void this.deps.workspaceState.update(KEY_STABILITY, all);
  }

  /** 宿主运行时长累计（每次 ready→exit 结算后由调用方传入）。 */
  addRunTime(version: string, ms: number): void {
    if (!version || !Number.isFinite(ms) || ms <= 0) return;
    const s = this.stability(version);
    s.runMs += ms;
    this.saveStability(version, s);
    this.tryPromotePrevious(version);
  }

  /** 对话完成计数（每次 chat 成功返回后由调用方传入）。 */
  addChat(version: string): void {
    if (!version) return;
    const s = this.stability(version);
    s.chats += 1;
    this.saveStability(version, s);
    this.tryPromotePrevious(version);
  }

  /** 稳定基线提升检查：当前版本累计运行 >1h 且对话 >10 次 → previous = 当前版本（只升不降）。
   *  门槛未满足前，previous 保持旧的已验证基线（或初始的 VSIX 内置），崩溃回退永不落空。 */
  private tryPromotePrevious(version: string): void {
    if (version !== this.currentVersion) return;
    const s = this.stability(version);
    if (s.runMs < STABLE_RUN_MS || s.chats < STABLE_CHATS) return;
    const prev = this.previousVersion;
    if (prev && prev !== version) {
      this.setState(KEY_PREVIOUS, version);
      this.deps.log(
        `[dsh-runtime] DSH ${version} stable (${Math.round(s.runMs / 60000)}m, ${s.chats} chats) — stable baseline updated`
      );
    }
  }

  /** 重置运行时状态（回退 VSIX 内置 + 清空候选/黑名单；供测试与紧急恢复）。 */
  reset(): void {
    this.setState(KEY_CURRENT, undefined);
    this.setState(KEY_KNOWN_GOOD, undefined);
    this.setState(KEY_PREVIOUS, undefined);
    this.setState(KEY_FAILED, undefined);
    this.setState(KEY_IGNORED, undefined);
    this.setState(KEY_STABILITY, undefined);
    this.crashCounts.clear();
    this.deps.statusBar(vscode.env.language.startsWith("zh") ? "DSH 运行时已重置为内置版" : "DSH runtime reset to bundled");
    this.deps.log("[dsh-runtime] runtime state reset to bundled");
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 插件最小依赖集（= package.json dependencies 中的 @deepseek-ai 内核包）。
   * 按**候选版本**统一指定（DSH 各包 lockstep 同版本发布；@latest 各自独立解析会 ERESOLVE）；
   * cordis 基础设施包（@deepseek-ai/cordis / cordis-plugin-loader）不显式指定，
   * 由内核包按其依赖约束传递解析，避免冲突。
   */
  private minimalDependencySpecs(version: string): string[] {
    const pkg = JSON.parse(fs.readFileSync(path.join(this.deps.extensionPath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(pkg.dependencies ?? {})
      .filter((name) => name.startsWith("@deepseek-ai/") && !name.includes("cordis"))
      .map((name) => `${name}@${version}`);
  }

  /** 宿主自检：以重定向器 + 自检模式启动宿主，期望输出哨兵行。
   *  Node 解析与 AgentHost 一致（系统 node ≥20 优先，回退 VS Code 内置 +
   *  ELECTRON_RUN_AS_NODE）；加载器统一 --experimental-loader（兼容 Node 16.12+）。 */
  private async selfTest(runtimeRoot: string): Promise<boolean> {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const nodeExe = (await this.deps.nodeResolver()) ?? process.execPath;
    const useElectronNode = nodeExe === process.execPath;
    const hostScript = this.deps.hostScript();
    const loader = this.deps.loaderArgs();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_RUNTIME_NODE_MODULES: path.join(runtimeRoot, "node_modules"),
      DSH_SELF_TEST: "1",
      DSH_HOME: path.join(runtimeRoot, "selftest-home"),
    };
    if (useElectronNode) env.ELECTRON_RUN_AS_NODE = "1";
    return new Promise<boolean>((resolvePromise) => {
      const child = spawn(nodeExe, [...loader, hostScript], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolvePromise(false);
      }, SELF_TEST_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (out.includes("DSH_SELF_TEST_OK")) {
          clearTimeout(timer);
          try { child.kill(); } catch { /* ignore */ }
          resolvePromise(true);
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolvePromise(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolvePromise(code === 0 && out.includes("DSH_SELF_TEST_OK"));
      });
    });
  }
}

/* ---------------- 工具 ---------------- */

/** 解析 VSIX 内置（或任意目录下）的 dsh-app-boot 版本。 */
export function bundledDshVersion(extensionPathOrModules: string): string | undefined {
  try {
    const p = path.join(extensionPathOrModules, "node_modules", DSH_PKG, "package.json");
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
