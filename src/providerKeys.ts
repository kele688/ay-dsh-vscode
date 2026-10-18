/**
 * providerKeys.ts — 提供商密钥读取与"下发项"构造的**唯一来源**。
 *
 * 背景（2026-10 小米 MiMo 等自定义提供商全部无法认证的根因修复）：
 *   `globalState.dshProviders` 是配置真源，但它只承载"该提供商是否已配置密钥"的
 *   结果（前端据此显示"已配置"），**密钥本体在 VS Code SecretStorage**
 *   （条目名 `dshVscode.provider.<id>.apiKey`，per-provider 独立存储）。
 *
 *   任何把 `dshProviders` 列表**原样**下发给宿主的地方，都会让宿主收到
 *   `apiKey === undefined`：宿主既不写 `llm-pi-ai.providers.<id>.apiKeyEnv`，
 *   还会反过来 `credentials.unset(...)` 删除已存凭据（见 host/agent-host.mjs 的
 *   providersApply 分支）。最终表现为内核侧
 *   `PI_AI_ERROR: No API key for provider: <id>`（pi-ai 的 openai-completions
 *   在 `options.apiKey` 为空时抛出）。
 *
 *   ⇒ **所有**下发路径（配置面板保存、宿主就绪后的重同步）都必须经过本模块，
 *     先把 SecretStorage 中的密钥补齐，再交给宿主。
 */
import * as vscode from "vscode";
import type { ProviderApplyItem } from "./protocol";

/** 配置真源的持久化键（globalState；历史版本曾存于 workspaceState，同名）。 */
export const PROVIDERS_KEY = "dshProviders";

/** SecretStorage 中某个提供商的密钥条目名。
 *  provider id 含 `-` 等字符没问题（SecretStorage 键是任意字符串），
 *  但进入宿主后会被清洗成凭据 ref（`[^A-Za-z0-9_]` → `_`）。 */
export const providerSecretKey = (id: string): string => `dshVscode.provider.${id}.apiKey`;

/** 本模块所需的最小提供商结构；`configPanel` 的 `ProviderInfo` 满足之。
 *  刻意不 import `ProviderInfo`，避免与 configPanel 形成循环依赖。 */
export interface ProviderSyncSource {
  id: string;
  name?: string;
  baseUrl?: string;
  protocol?: string;
  models?: ProviderApplyItem["models"];
}

/**
 * 读取配置真源（提供商列表）——**与配置面板共用同一路径**。
 *
 * 为什么不能直接 `globalState.get(PROVIDERS_KEY)`：历史版本把该键存在
 * `workspaceState`，而 `globalState` 在首次运行/新机器/Remote-SSH 上可能为空。
 * 配置面板的 `loadProviders()` 会做一次 `workspaceState → globalState` 迁移；
 * `onHostReady` 若绕过它直接读 `globalState`，就会拿到**空列表** ⇒ 宿主
 * `dshProviders` 为空 ⇒ 对话面板走"回退到内核已注册路由"分支（表现为只剩
 * DeepSeek Official / Account 两项，而配置页仍显示完整列表）。
 *
 * @param context - 扩展上下文（两级 Memento 来源）。
 * @returns 配置真源列表；两处都没有时返回空数组（是否播种默认项由调用方决定）。
 */
export function loadStoredProviders(context: vscode.ExtensionContext): ProviderSyncSource[] {
  const saved = context.globalState.get<ProviderSyncSource[]>(PROVIDERS_KEY);
  if (Array.isArray(saved) && saved.length > 0) return saved;
  const legacy = context.workspaceState.get<ProviderSyncSource[]>(PROVIDERS_KEY);
  if (Array.isArray(legacy) && legacy.length > 0) {
    // 一次性迁移（幂等）：此后读写都以 globalState 为准。
    void context.globalState.update(PROVIDERS_KEY, legacy);
    return legacy;
  }
  return [];
}

/**
 * 读取提供商列表并补齐密钥，得到可下发给宿主 `providersApply` 的同步项。
 *
 * 读取失败**不再静默降级**为"无密钥"（此前那个空 catch 让本故障多隐藏了数周），
 * 而是记录警告后按"本次未携带密钥"处理 —— 宿主侧对 `undefined` 只保留既有凭据、
 * 绝不删除，因此失败是安全的、可观测的。
 *
 * @param context - 扩展上下文（SecretStorage 来源）。
 * @param load - 返回配置真源列表；由调用方注入，避免本模块反向依赖配置面板。
 * @returns 与列表等长的同步项；`apiKey` 来自 SecretStorage，可能为 `undefined`。
 */
export async function collectProviderApplyItems(
  context: vscode.ExtensionContext,
  load: () => ProviderSyncSource[]
): Promise<ProviderApplyItem[]> {
  return Promise.all(
    load().map(async (p) => {
      let apiKey: string | undefined;
      try {
        apiKey = (await context.secrets.get(providerSecretKey(p.id))) ?? undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ay-dsh] 读取提供商 ${p.id} 的 API Key 失败，本次按"未携带密钥"下发：${message}`);
        apiKey = undefined;
      }
      return { id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol, models: p.models, apiKey };
    })
  );
}
