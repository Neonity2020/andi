# 无尽流 Coding Agent 设计稿

版本：`v0.1`
状态：Draft
日期：`2026-06-04`

## 1. 目标

构建一个轻量级的 coding agent 控制平面，让开发者可以在多个大模型 provider 之间切换，而不会丢失对话上下文，也不会打断开发节奏。

第一阶段的产品楔子不是“另一个 agent”，而是：

- 统一的 provider 路由
- 持久化的对话记忆
- provider 之间的中途交接
- 极低的配置成本

MVP 应该允许用户先用 OpenAI 开始对话，再在对话中途切换到 Anthropic，并且保留最后一段相关上下文继续推进。

## 2. 产品原则

1. 第一版要尽量聚焦。
2. 优先保证“不要打断工作流”。
3. 除非明确需要云能力，否则优先本地优先存储。
4. 路由决策要保留用户控制权。
5. 每个子系统都要保持可替换。

## 3. MVP 范围

### 包含

- OpenAI 和 Anthropic provider
- 一个统一路由层
- SQLite 会话持久化
- 滚动消息窗口
- 轻量级滚动摘要
- 手动切换 provider
- 基础重试和 provider 错误展示

### MVP 不包含

- 团队协作
- 多租户工作区认证
- 插件市场
- Postgres / 分布式基础设施
- 基于复杂启发式的自动模型路由
- 浏览器自动化
- 超出最小 agent loop 的工具生态

## 4. 系统形态

产品第一版应该实现为一个小型控制平面，分成三层：

1. `Client`
   - CLI 或桌面壳，用于输入提示词和切换 provider
2. `Agent Core`
   - 负责会话、记忆、摘要和 provider 选择
3. `Provider Adapters`
   - 统一 OpenAI / Anthropic 的请求和响应格式

第一版应避免不必要的服务拆分，一个 Node 进程就足够。

## 5. 核心数据流

1. 用户向当前会话发送一个 prompt。
2. Core 加载：
   - 最近消息
   - 滚动摘要
   - 当前 provider 配置
3. Core 构造 provider 专属请求 payload。
4. provider 把 token 流式返回给 Core。
5. Core 立刻把 token 转发给 client。
6. Core 持久化：
   - 原始用户消息
   - assistant 响应
   - 必要时更新摘要
   - provider 元数据
7. 如果用户在对话中切换 provider，下一次请求会复用同一个会话记忆。

## 6. 核心模块

### 6.1 会话管理器

职责：

- 创建和加载会话
- 跟踪会话状态
- 记录每轮使用的 provider
- 维护消息历史窗口

### 6.2 记忆管理器

职责：

- 保留最近 `N` 条消息
- 维护旧上下文的滚动摘要
- 为下一次 provider 调用生成紧凑的上下文

推荐策略：

- 所有消息都存入 SQLite
- 下一次请求只传最近 `10` 轮消息加摘要
- 当历史超过窗口时刷新摘要

### 6.3 路由器

职责：

- 选择 provider
- 校验 provider 可用性
- 应用可选路由规则
- 明确地把回退决策展示给用户

初始路由策略：

- 默认由用户显式选择
- 后续允许一个简单规则引擎
- provider 不可用时默认失败关闭，除非用户明确要求 fallback

### 6.4 Provider Adapter 接口

每个 adapter 都应该统一三件事：

- 消息输入格式
- 流式输出格式
- 错误形状

所需 adapter 方法：

- `sendMessage(sessionContext, prompt, options)`
- `streamMessage(...)`
- `healthCheck()`
- `estimateCost(...)` 或占位实现

### 6.5 持久化层

MVP 使用 SQLite，因为它足够简单、本地、可靠，并且足以支撑单用户控制平面。

最少需要这些表：

- `sessions`
- `messages`
- `summaries`
- `provider_configs`
- `routing_events`

## 7. SQLite 表结构草图

### `sessions`

- `id`
- `title`
- `created_at`
- `updated_at`
- `active_provider`
- `model_hint`

### `messages`

- `id`
- `session_id`
- `role`
- `provider`
- `model`
- `content`
- `created_at`
- `token_count`
- `parent_message_id`

### `summaries`

- `id`
- `session_id`
- `summary_text`
- `summary_version`
- `updated_at`

### `provider_configs`

- `id`
- `provider`
- `name`
- `base_url`
- `api_key_ref`
- `enabled`

### `routing_events`

- `id`
- `session_id`
- `from_provider`
- `to_provider`
- `reason`
- `created_at`

## 8. 上下文连续性策略

真正的工程难点不是简单的聊天转发，而是模型切换时的连续性。

推荐做法：

1. 永远保存完整对话。
2. 每次 provider 请求都由以下内容组成：
   - 滚动摘要
   - 最近 `N` 条消息
   - 当前用户消息
3. 如果用户切换 provider，保持同一个 session，并为新 provider 重新生成请求包。

这样可以避免脆弱的“模型专属状态转移”。

## 8.1 上下文注入护栏

prompt builder 不能把大段 LLM 生成代码无脑注入到下一轮上下文里。

规则：

- 原始转录内容完整保存在存储层。
- assistant 和 tool 生成的大段代码，在注入 prompt 前要强力截断。
- 热路径里优先使用按行保留头尾的方式，不做复杂语义改写。
- 截断必须显式写明 marker，让模型知道中间内容被省略了。
- 只有用户明确需要时，才考虑保留完整代码进入活跃上下文。

这和 Claude Code 的 compaction / session memory 路径是一致的思路：全部存储，注入时只给有用的、受限的一小段。

## 9. Provider 切换行为

provider 切换应该是会话级决策，而不是把对话重置。

发生切换时：

- 保持相同的 session id
- 保持相同的记忆存储
- 记录一条路由事件
- 重新生成 provider 专属 payload
- 继续从新的 provider 流式输出

这样用户体验到的是无缝交接，而不是重新开了一个聊天窗口。

## 10. 失败模式

我们需要显式地处理并展示这些失败：

- provider 超时
- provider 认证失败
- 限流 / 配额耗尽
- 上下文窗口溢出
- 流式中断

默认行为：

- 保留部分转录内容
- 存储失败事件
- 给出可恢复的重试路径

重要的是：失败不能破坏会话状态。

## 11. 第一版非目标

不要过早引入这些能力：

- 多 agent 规划
- 自主工具执行
- 插件 SDK
- 分布式锁
- 云同步
- 协作编辑

这些能力未来可能会成为长期平台的一部分，但它们不是验证这个楔子的必要条件。

## 12. 实现计划

### 阶段 1：可工作的骨架

- 创建仓库结构
- 增加 provider adapter 接口
- 增加 SQLite 持久化
- 增加最小会话命令面板

### 阶段 2：持续上下文

- 持久化消息
- 生成滚动摘要
- 每一轮都恢复上下文
- 在当前 prompt 包里保留最近 10 条消息

### 阶段 3：Provider 交接

- 增加显式 provider 切换
- 验证对话中途的连续性
- 衡量正常使用场景下的上下文丢失是否接近于零

### 阶段 4：把控制平面产品化

- 增加配置界面
- 增加路由规则
- 增加可观测性
- 增加分发入口，例如 CLI、桌面应用或编辑器集成

## 13. 工程质量标准

我们应该把第一版实现当作基础设施，而不是演示样例。

质量要求：

- 清晰的模块边界
- 可测试的 adapter 合约
- 确定性的持久化
- client 中不隐藏状态
- 对路由和 provider 失败有可观测性
- 如果未来拆服务，迁移路径要清晰

## 14. 下一步需要决策的事项

要从设计进入执行，我们需要按顺序对齐这些问题：

1. 主入口形态：CLI 优先、桌面应用优先，还是编辑器插件优先
2. 仓库结构：单包还是小型 monorepo
3. 会话身份：仅本地，还是支持云同步
4. 摘要策略：基于规则的摘要刷新，还是由 LLM 生成摘要
5. 路由策略：v0 仅手动切换，还是手动加一个很小的规则引擎

## 15. 当前推荐

如果是第一版实现，我推荐：

- `CLI first`
- `单个 Node 应用`
- `本地 SQLite`
- `手动 provider 切换`
- `简单滚动摘要`

这个组合是验证核心承诺的最快路径：在 provider 切换时保持上下文连续。
