# 更新日志

## [0.3.0] - 2026-08-20

- 多提供商 LLM 路由（DeepSeek/Zhipu/ZAI）及会话内模型切换
- 历史会话恢复（秒显+立即resume，首条消息零等待）
- 每轮效率体系（系统提示静态规则 + STEPS_USED/TOOLS_USED/ELAPSED_SEC 动态字段 + 强制收尾报告）
- 统计与日志强同步落盘
- 历史列表与恢复提速（零解压扫描+prepared缓存共享）
- 删除会话乐观UI+状态栏提示
- 子代理会话统一命名（subsession_+sessionId）
- 双语更新日志（中/英）

本文件由 scripts/bump-version.mjs 维护；按用户本地语言（zh-CN）引用展示。

