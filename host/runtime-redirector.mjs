/**
 * runtime-redirector.mjs — 机制 A 的 ESM 薄壳入口。
 *
 * 逻辑唯一实现在 runtime-redirector.cjs（同步 resolve + registerHooks 自动注册）；
 * 本文件仅用于 Node <22.12（无 module.registerHooks）的 `--experimental-loader`
 * 兼容路径 —— loader 需要 ESM 模块的具名 resolve 导出。
 */
export { resolve } from "./runtime-redirector.cjs";
