/**
 * runtime-redirector.cjs — 机制 A（宿主 ESM 解析重定向）的唯一逻辑实现。
 *
 * 把宿主运行时动态解析的 DSH 内核裸标识符（cordis 插件按名加载 @deepseek-ai/* 等）
 * 重定向到用户采纳的运行时闭包目录（ESM 不读 NODE_PATH）。设计依据见
 * 插件设计决策文档（AY-DSH 插件改进方案选取依据）§1.4.3。
 *
 * 加载方式（跨平台一致，由调用方统一选择，见 host.ts 的 hostLoaderArgs）：
 *   - Node ≥22.12：`node -r host/runtime-redirector.cjs <hostScript>`
 *     （registerHooks 注入；规避 Node 24 在 Windows 上 --import/--experimental-loader
 *     导致 main 入口加载崩溃的回归：ERR_UNSUPPORTED_ESM_URL_SCHEME protocol 'd:'）
 *   - Node <22.12（无 module.registerHooks）：`node --experimental-loader
 *     host/runtime-redirector.mjs <hostScript>`（mjs 薄壳 re-export 本文件 resolve）
 *
 * 环境：DSH_RUNTIME_NODE_MODULES = <闭包>/node_modules（为空/未设置 → 直通不重定向）
 *
 * 安全（2026-09 加固）：
 *   - **包名白名单**：只重定向 `@deepseek-ai/*`，不劫持其它裸标识符（此前只要闭包内
 *     存在同名 package.json 就重定向，闭包被投毒时可替换任意被宿主 import 的包名）。
 *   - **解析结果包含性校验**：nextResolve 结果必须仍落在闭包目录内，否则回退默认解析
 *     （防闭包内恶意 package.json 的 exports/main 指向闭包外文件）。
 */
"use strict";
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const runtime = process.env.DSH_RUNTIME_NODE_MODULES || "";
const runtimePrefix = runtime ? pathToFileURL(runtime.replace(/[\\/]+$/, "") + "/").href : "";

/** 仅当 specifier 是 DSH 内核包（@deepseek-ai/<合法包名>）且闭包内确实存在该包时才重定向。 */
function shouldRedirect(specifier) {
  if (!runtime) return false;
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("data:") ||
    specifier === "" ||
    !specifier.startsWith("@deepseek-ai/")
  ) {
    return false;
  }
  const seg = specifier.split("/");
  const pkgName = seg[1];
  // 第二段必须是合法包名（不含 . / ..），防止 join 折叠逃出闭包目录
  if (!pkgName || pkgName === "." || pkgName === ".." || pkgName.includes("..") || pkgName.includes("\\")) {
    return false;
  }
  return existsSync(join(runtime, "@deepseek-ai", pkgName, "package.json"));
}

/**
 * 解析钩子（同步实现，跨平台）：
 * - 必须同步：registerHooks 的 resolve 在 main 入口走同步解析路径（resolveSync），
 *   async 钩子返回的 Promise 会被 validateResolve 判为 url undefined；
 * - Windows 绝对路径（"D:\..."，Node 把 main 入口以 URL 字符串交给钩子，个别场景
 *   仍可能出现盘符形式）：默认解析器不认，先转 file:// URL（POSIX 路径不匹配此分支）。
 */
function resolve(specifier, context, nextResolve) {
  if (/^[A-Za-z]:[\\/]/.test(specifier)) {
    return nextResolve(pathToFileURL(specifier).href, context);
  }
  if (shouldRedirect(specifier)) {
    const anchor = pathToFileURL(join(runtime, "__dsh_redirect_anchor__.js")).href;
    const resolved = nextResolve(specifier, { ...context, parentURL: anchor });
    // 包含性校验：解析结果必须仍落在闭包目录内；否则回退默认解析（防越界加载）。
    const url = typeof resolved === "string" ? resolved : resolved && resolved.url;
    if (typeof url === "string" && url.startsWith(runtimePrefix)) return resolved;
    return nextResolve(specifier, context);
  }
  return nextResolve(specifier, context);
}

// Node ≥22.12：module.registerHooks 注册（-r preload / --import 加载本文件时生效）
const { registerHooks } = require("node:module");
if (typeof registerHooks === "function") {
  registerHooks({ resolve });
}
// Node <22.12：无 registerHooks，静默；由 --experimental-loader 薄壳（runtime-redirector.mjs）
// 以具名导出使用本 resolve。module.exports = { resolve } 可被 cjs-module-lexer 静态识别。
module.exports = { resolve };
