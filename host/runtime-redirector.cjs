/**
 * runtime-redirector.cjs — 机制 A（宿主 ESM 解析重定向）的唯一逻辑实现。
 *
 * 把宿主运行时动态解析的裸标识符（cordis 插件按名加载 @deepseek-ai/* 等）重定向到
 * 用户采纳的运行时闭包目录（ESM 不读 NODE_PATH）。设计依据见
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
 */
"use strict";
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const runtime = process.env.DSH_RUNTIME_NODE_MODULES || "";

/** 取裸标识符的包根（scoped 包取前两段）："@deepseek-ai/dsh-llm/lib/x" → "@deepseek-ai/dsh-llm" */
function pkgRoot(specifier) {
  const seg = specifier.split("/");
  return seg[0].startsWith("@") && seg.length > 1 ? `${seg[0]}/${seg[1]}` : seg[0];
}

/** 仅当闭包内存在该包时才重定向（其余保持默认解析）。 */
function shouldRedirect(specifier) {
  if (!runtime) return false;
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("data:") ||
    specifier === ""
  ) {
    return false;
  }
  return existsSync(join(runtime, pkgRoot(specifier), "package.json"));
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
    return nextResolve(specifier, { ...context, parentURL: anchor });
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
