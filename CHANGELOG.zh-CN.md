# 更新日志

## [0.5.5] - 2026-09-13

- 安全与正确性加固
- fix: harden security, correctness and remove redundant code

## [0.5.4] - 2026-09-12

适配 DSH 内核 0.1.5-rc.2（修复升级后"会话历史恢复不了 / 最后的正文输出丢失 / 反应变慢"）：

- 修复重启宿主后会话历史不恢复：0.1.5 移除了 `sessionPersistence.inspect`，预览路径的
  `typeof === "function"` 守卫静默失败 → 一个 `history` 帧都不发（标题与日志大小仍在、
  消息列表被清空、统计归零）。改为跨版本只读读取（`inspect` → `open(id,"read")` →
  `sessionQuery.readSession` 三级回退），预览 / 只读浏览 / 分页三处统一。
- 修复一轮对话只显示第一步正文、最后的总结报告消失：0.1.5 不再产生 `assistant/chunk`
  会话事件后，`translateEvent` 误判"已流式渲染过"而丢弃每条 `assistant/message` 的正文；
  改为按"本步是否真有流式增量"判定，无流时整段下发。
- 恢复实时流式输出：桥接 0.1.5 的进程内临时帧 `agent/assistant-stream`，重新包装为
  `assistant/chunk` 推给前端，流式渲染链路零改动（不再"整段输出憋到最后才出现"）。
- 适配 0.1.5 新增的 `assistant/attempt` 终态事件（模型尝试未提交可见消息时收尾气泡）。
- 多代不可变日志：统计 `lastSeq` 随代际重编号自动重算落盘；日志大小 / 列表 / 删除
  按代际识别（session.jsonl.zstd = v0，session.v3.jsonl.zstd = v3）。
- 性能：会话统计落盘由"每次 flush 全量拷贝 + 全量扫描"改为按 seq 增量切片
  （31 万事件会话实测 8.7ms → ~0ms/次）。
- 诊断：宿主 stderr 同步落盘到 `<DSH home>/dsh-host.log`（>5MB 自动重建），
  内核启动期问题（会话加载被拒 / 格式拒绝 / 迁移失败）可离线定位。
- 历史列表项目过滤在 Windows 上改为大小写不敏感：会话目录名取自会话创建时的
  cwd（旧 home 迁移的会话保留旧键名），盘符大小写不一致曾让列表静默变空。

## [0.5.3] - 2026-09-11

- patch
- feat: label system rules, add per-round reiteration directive; fix updater latest/next logic

## [0.5.2] - 2026-09-04

- 基于项目隔离历史会话列表，防止在不同的工作区恢复不相干会话
- 默认关闭dsh_goal相关功能，无人值守长程任务与ay-dsh应用模式冲突，可能造成模型死循环
- chore: bump version to 0.5.2

## [0.5.1] - 2026-09-02

- fix: session rotation summary/title & idle-check, stats reset, ripgrep exec, bump lock sync

## [0.5.0] - 2026-08-31

- 各组独立保存按钮仅落盘不重启
- 新增重启应用功能组/命令，确认后统一重启生效
- 修复布尔开关环境变量注入（关闭状态真正失效）
- 补注册 6 个缺失配置键
- 权限规则系统默认只读展示并拒绝同名重复
- 个性提示词注入与自动学习受开关控制
- 修复 L.on/L.off 缺失

## [0.4.1] - 2026-08-27

- 工具级自动授权规则
- 跨平台 koffi 原生修复
- DSH 内核保持 0.1.1-rc.2

## [0.4.0] - 2026-08-23

- 自包含 DSH 核心 0.1.1-rc.2（替换原 0.1.0-rc.6）
- 多模态模型支持：DeepSeek-V4-Vision-Exp 图像理解模型
- 粘贴图片进可横向滚动的缩略图轨道，并插入 [图N] 序号引用锚点
- 大图 lightbox 卡片：左右切换、鼠标滚轮切图、关闭按钮、文件名与序号
- 历史会话图片支持横向滚动与多图 lightbox 切换
- 温和图片限制（PNG/JPG/WebP/GIF、每消息 20 张、单张 ≤5MB、内容去重）
- 可配置自动压缩（auto / thresholdRatio / maxTokens），位于配置面板"控制参数"区，触发比例为百分比（默认 80%）
- 压缩开始/结束在状态栏即时提示，完成显示本次释放的 token 数
- 会话头部 logo 改为 AY-DSH，更新输入框占位提示
- 粘贴为唯一图片入口（移除拖拽与悬浮添加按钮）

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

