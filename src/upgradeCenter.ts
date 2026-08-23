/**
 * upgradeCenter.ts — 配置面板"版本升级"功能的集中服务。
 *
 * 提供两类升级的统一后端：
 *  1) DSH 核心升级（复用 dshRuntime 的升级/回退机制，查询源 = DSH 官方 GitHub Releases）
 *  2) AY-DSH-VSCode 插件升级（查询源 = 本插件仓库 GitHub Releases，下载 VSIX 安装）
 *
 * 与既有升级机制的关系：
 *  - 24h 自动检测（dshUpdater，npm registry latest）与顶栏横幅提示**原样保留**；
 *    本模块的"重新查询"是**手动**按 GitHub Releases 拉取版本列表（只列比基线更高的）。
 *  - DSH 升级/重置的执行仍走 DshRuntimeManager（隔离目录 npm install + 自检 + 切换），
 *    宿主重启编排由调用方（extension.ts）注入回调，与 doDshUpgrade / reset 命令一致。
 *
 * 缓存约定：只缓存**版本列表信息**（version + release notes 文本），不缓存任何文件。
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DshRuntimeManager, bundledDshVersion, semverGt } from "./dshRuntime";

/** 版本条目（版本号 + 可选的 release note 文本）。 */
export interface UpgradeVersionInfo {
  version: string;
  notes?: string;
}

/** 查询结果（versions 按版本从高到低排序；error 非空表示查询失败）。 */
export interface UpgradeQueryResult {
  versions: UpgradeVersionInfo[];
  error?: string;
}

export interface UpgradeCenterDeps {
  extensionPath: string;
  globalState: vscode.Memento;
  runtime: DshRuntimeManager;
  /** 当前插件版本（package.json version）。 */
  pluginVersion: () => string;
  /** DSH 升级成功后的宿主切换编排（清候选横幅 + 等空闲 + 重启宿主）。 */
  onDshUpgraded: (version: string) => Promise<void>;
  /** DSH 重置后的宿主重启编排（清候选/检测周期 + 重启宿主）。 */
  onDshReset: () => Promise<void>;
  log: (msg: string) => void;
  statusBar: (msg: string) => void;
}

const GITHUB_API = "https://api.github.com";
/** DSH 核心官方仓库（dsh-app-boot 位于 packages/boot/app-boot）。 */
const DSH_REPO = "deepseek-ai/deepseek-harness";
/** 本插件仓库。 */
const PLUGIN_REPO = "kele688/ay-dsh-vscode";
/** DSH Release tag 前缀（如 dsh-v0.1.0-rc.7），与 openDshDetails 的跳转格式一致。 */
const DSH_TAG_PREFIX = "dsh-v";
/** 插件 Release tag 前缀（如 v0.3.0）。 */
const PLUGIN_TAG_PREFIX = "v";
/** 版本列表缓存键（globalState，跨工作区；仅存版本信息，不缓存文件）。 */
const CACHE_KEY_DSH = "dshVscode.dshVersionsCache";
const CACHE_KEY_PLUGIN = "dshVscode.pluginVersionsCache";
/** GitHub API 查询超时。 */
const FETCH_TIMEOUT_MS = 15_000;

export class UpgradeCenter {
  constructor(private readonly deps: UpgradeCenterDeps) {}

  /* ---------------- 当前版本信息 ---------------- */

  /** 当前生效的 DSH 核心版本（初始 = VSIX 内置）。 */
  dshCurrent(): string | undefined {
    return this.deps.runtime.currentVersion;
  }

  /** VSIX 内置的 DSH 核心版本（重置回退目标）。 */
  dshBundled(): string | undefined {
    return bundledDshVersion(this.deps.extensionPath);
  }

  /** 当前插件版本。 */
  pluginCurrent(): string {
    return this.deps.pluginVersion();
  }

  /* ---------------- 缓存（仅版本列表信息） ---------------- */

  cachedDshVersions(): UpgradeVersionInfo[] {
    return this.deps.globalState.get<{ versions: UpgradeVersionInfo[] }>(CACHE_KEY_DSH)?.versions ?? [];
  }

  cachedPluginVersions(): UpgradeVersionInfo[] {
    return this.deps.globalState.get<{ versions: UpgradeVersionInfo[] }>(CACHE_KEY_PLUGIN)?.versions ?? [];
  }

  /* ---------------- 查询（GitHub Releases，只列比基线更高的版本） ---------------- */

  /** 重新查询 DSH 核心可用版本（> VSIX 内置版本），结果写入缓存。 */
  async queryDshVersions(): Promise<UpgradeQueryResult> {
    const bundled = this.dshBundled();
    return this.queryReleases(
      DSH_REPO,
      DSH_TAG_PREFIX,
      (v) => bundled !== undefined && (v === bundled || semverGt(v, bundled)),
      CACHE_KEY_DSH
    );
  }

  /** 重新查询插件可用版本（> 当前插件版本），结果写入缓存。 */
  async queryPluginVersions(): Promise<UpgradeQueryResult> {
    const current = this.pluginCurrent();
    return this.queryReleases(
      PLUGIN_REPO,
      PLUGIN_TAG_PREFIX,
      (v) => Boolean(current) && (v === current || semverGt(v, current)),
      CACHE_KEY_PLUGIN
    );
  }

  private async queryReleases(
    repo: string,
    tagPrefix: string,
    filter: (version: string) => boolean,
    cacheKey: string
  ): Promise<UpgradeQueryResult> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, {
          headers: { "User-Agent": "ay-dsh-vscode", Accept: "application/vnd.github+json" },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const releases = (await res.json()) as unknown[];
      const versions: UpgradeVersionInfo[] = (Array.isArray(releases) ? releases : [])
        .map((r) => {
          const raw = r as { tag_name?: unknown; body?: unknown; draft?: unknown };
          const tag = String(raw.tag_name ?? "");
          let version = tag;
          if (tagPrefix && tag.startsWith(tagPrefix)) version = tag.slice(tagPrefix.length);
          else version = tag.replace(/^v/i, "");
          return { version, notes: typeof raw.body === "string" ? raw.body : undefined, draft: raw.draft === true };
        })
        .filter((r) => !r.draft && r.version && filter(r.version))
        .sort((a, b) => (semverGt(a.version, b.version) ? -1 : 1))
        .map((r) => ({ version: r.version, notes: r.notes }));
      // 只缓存版本列表信息（版本号 + notes 文本），不缓存任何文件
      await this.deps.globalState.update(cacheKey, { versions, fetchedAt: Date.now() });
      return { versions };
    } catch (e) {
      return {
        versions: [],
        error: e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e),
      };
    }
  }

  /* ---------------- DSH 核心升级 / 重置（复用 DshRuntimeManager） ---------------- */

  /** 升级 DSH 核心到指定版本（复用 runtime.upgrade：隔离目录安装 + 自检 + 切换）。
   *  升级前做兼容预检：版本必须高于当前，且不在失败黑名单/用户忽略列表
   *  （黑名单 = 此前自检或运行失败判定不兼容的版本，见 dshRuntime 状态机）。 */
  async upgradeDsh(version: string): Promise<boolean> {
    const zh = vscode.env.language.startsWith("zh");
    const current = this.dshCurrent();
    if (current && !semverGt(version, current)) {
      this.deps.statusBar(
        zh ? `✗ 所选版本 ${version} 不高于当前版本 ${current}` : `✗ Selected version ${version} is not newer than current ${current}`
      );
      return false;
    }
    if (!this.deps.runtime.isCandidate(version)) {
      this.deps.statusBar(zh ? `✗ 版本 ${version} 此前被标记为失败/忽略，不再推荐` : `✗ Version ${version} was previously blacklisted or ignored`);
      return false;
    }
    const ok = await this.deps.runtime.upgrade(version);
    if (ok) {
      this.deps.log(`[upgrade-center] DSH upgraded to ${version} — switching host`);
      await this.deps.globalState.update(CACHE_KEY_DSH, undefined);
      await this.deps.onDshUpgraded(version);
    }
    return ok;
  }

  /** 重置 DSH 核心回插件包原始版本（复用 runtime.reset + 清候选/检测周期 + 重启宿主）。 */
  async resetDsh(): Promise<void> {
    this.deps.log("[upgrade-center] resetting DSH core to bundled");
    this.deps.runtime.reset();
    await this.deps.globalState.update(CACHE_KEY_DSH, undefined);
    await this.deps.onDshReset();
  }

  /* ---------------- 插件升级（下载 VSIX + 安装） ---------------- */

  /**
   * 升级插件到指定版本：从 GitHub Release 下载 VSIX 资产 → VS Code 覆盖安装 →
   * 提示用户 Reload。安装由 VS Code 的 workbench.extensions.installExtension 执行。
   */
  async upgradePlugin(version: string): Promise<{ ok: boolean; message?: string }> {
    const zh = vscode.env.language.startsWith("zh");
    const current = this.pluginCurrent();
    // 不高于当前版本：直接拒绝（与 upgradeDsh 一致），避免选中当前版本却触发重回安装
    if (current && !semverGt(version, current)) {
      this.deps.statusBar(
        zh ? `✗ 所选版本 ${version} 不高于当前版本 ${current}` : `✗ Selected version ${version} is not newer than current ${current}`
      );
      return { ok: false, message: "not newer than current" };
    }
    try {
      // 1) 取该版本的 Release（找 VSIX 资产下载地址）
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${GITHUB_API}/repos/${PLUGIN_REPO}/releases/tags/${PLUGIN_TAG_PREFIX}${version}`, {
          headers: { "User-Agent": "ay-dsh-vscode", Accept: "application/vnd.github+json" },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`release fetch HTTP ${res.status}`);
      const release = (await res.json()) as { assets?: { browser_download_url?: string }[] };
      const asset = (release.assets ?? []).find((a) => /\.vsix$/i.test(a.browser_download_url ?? ""));
      if (!asset?.browser_download_url) throw new Error(zh ? "该版本没有 VSIX 安装包资产" : "no VSIX asset for this release");

      // 2) 下载 VSIX 到系统临时目录（安装后即删，不落地缓存）
      const dl = await fetch(asset.browser_download_url, {
        headers: { "User-Agent": "ay-dsh-vscode" },
      });
      if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
      const tmp = path.join(os.tmpdir(), `ay-dsh-vscode-${version}.vsix`);
      fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));

      // 3) 覆盖安装（同 publisher 同 id → VS Code 升级该扩展）
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(tmp));
      fs.rmSync(tmp, { force: true });
      this.deps.statusBar(
        zh ? `✅ 插件已升级到 ${version}，请重新加载窗口生效` : `✅ Extension upgraded to ${version} — reload the window to apply`
      );
      await this.deps.globalState.update(CACHE_KEY_PLUGIN, undefined);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`[upgrade-center] plugin upgrade to ${version} FAILED: ${message}`);
      this.deps.statusBar(zh ? `✗ 插件升级失败：${message}` : `✗ Plugin upgrade failed: ${message}`);
      return { ok: false, message };
    }
  }
}
