/**
 * dshVersion.ts — DSH 内核版本相关常量与工具（唯一真源）。
 *
 * 此前 `bundledDshVersion` / `comparePre` / `semverGt` / `DSH_PKG` / `REGISTRY_URL`
 * 在 dshRuntime.ts 与 dshUpdater.ts 各有一份（语义已易漂移、且 dshRuntime 的
 * REGISTRY_URL 是死代码），现收敛到此单模块；升级安装、更新检测、版本比较共用。
 */
import * as path from "node:path";
import * as fs from "node:fs";

/** DSH 内核入口包（版本锁步发布的锚点包）。 */
export const DSH_PKG = "@deepseek-ai/dsh-app-boot";
/** npm registry 基地址（升级安装用 `--registry` 固定，探测与安装同源）。 */
export const DSH_REGISTRY = "https://registry.npmjs.org";
/** DSH 包元数据端点（更新检测 fetch 用）。 */
export const DSH_PACKAGE_METADATA_URL = `${DSH_REGISTRY}/${DSH_PKG}`;

/** 严格 semver（无 build 元数据；字符集不含 shell 元字符，可作为命令参数白名单）。 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 是否为可安全进入 npm 参数与比较逻辑的版本字符串（防命令注入 / 目录穿越）。 */
export function isValidDshVersion(v: unknown): v is string {
  return typeof v === "string" && SEMVER_RE.test(v.trim());
}

/** 解析某目录（VSIX 内置目录，或运行时闭包根）下 dsh-app-boot 的版本；缺失返回 undefined。 */
export function bundledDshVersion(dir: string): string | undefined {
  try {
    const p = path.join(dir, "node_modules", DSH_PKG, "package.json");
    const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
    return pkg.version || undefined;
  } catch {
    return undefined;
  }
}

/** 按 semver 规则比较预发布标识符（"rc.7" > "rc.6"；正式版 > 预发布）。 */
export function comparePre(a: string | undefined, b: string | undefined): number {
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
  const m = SEMVER_RE.exec(a.trim());
  const n = SEMVER_RE.exec(b.trim());
  if (!m || !n) return false;
  const core = [Number(m[1]) - Number(n[1]), Number(m[2]) - Number(n[2]), Number(m[3]) - Number(n[3])];
  for (const d of core) {
    if (d !== 0) return d > 0;
  }
  return comparePre(m[4], n[4]) > 0;
}
