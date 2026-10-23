# 06. pi 运行时依赖边界

> **翻译说明：** 本页是与 [英文源规格](/spec/02-architecture/06-pi-runtime-dependency-boundary) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 1. 目的

PI-Desktop 使用 pi Agent 循环，但不把 CLI 会话运行时或桌面持久化交给
JavaScript 包。上游包演进时，必须保持这一职责划分清晰。

## 2. 当前职责

- `@earendil-works/pi-agent-core` 提供 Agent 循环，以及稳定的 agent、event、tool
  类型。Agent Runtime 自行维护桌面专用的上下文投影、压缩和 prompt 模板展开。
- `@earendil-works/pi-ai` 提供提供商传输、认证、消息类型、请求重试和 token 估算。
  Hosted search 请求与估算行为，以及为 Fast 模式让 `streamSimple` 转发 `serviceTier`
  （ADR 0334），继续由 PI-Desktop 的 pi-ai 补丁和契约测试覆盖。
- Rust `host-core` 仍然是 SQLite 和权威持久会话状态的唯一所有者。Node sidecar
  通过现有 RPC 契约请求持久化检查点和工具结果。
- `@earendil-works/pi-coding-agent` 是过渡期依赖。生产代码仅在原生 Pi 会话续接及
其 session-file manager 中使用；该路径仍使用包内 `AgentSession` 和原生会话行为。
可信扩展由 `extensions/loader.ts` 提供小型兼容 shim。Desktop 常规 Agent 运行时、
host-core 检查点压缩路径和持久会话存储不使用其 `AgentSession`。

不要重新引入已移除的 pi-agent-core harness、session、compaction 或 prompt-template
API。桌面行为留在 `agent-runtime` 边界内；提供商操作使用 pi-ai 的公开 API。

## 3. `pi-durable` 评估

`@earendil-works/pi-durable` 可作为后续运行时迁移的候选方案，但不是已移除
pi-agent-core helper 的直接替代品。其[上游 README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
当前将 API 标为实验性，并说明接口可能变化。它提供围绕 `Session` 存储的完整 `Harness`，
包括不可变会话条目、
原子提交、任务检查点、压缩和恢复；Node adapter 包括 SQLite 与 JSONL 存储。README
同时说明，同一份存储一次由一个进程持有，且没有跨进程锁。

这些语义与 PI-Desktop 的当前边界不同：Rust host-core 拥有 SQLite 数据库和会话
记录，Node 只拥有内存中的 Agent 循环。不能对 host-core 数据库开启第二个 SQLite
写入者。采用 durable harness 前，需通过单独 ADR 比较以下选择：

1. 通过 host-core RPC 实现 `pi-durable` 的 `Storage` 契约，并覆盖其原子事务保证和
   存储一致性测试。
2. 保留 host-core 作为事实来源，使用内存 durable harness，并明确从 host transcript
   重建与恢复的语义。
3. 如果上述方案都不能保留会话兼容性和现有 host 权限边界，则继续使用当前桌面自有
   运行时。

决策需覆盖现有 SQLite 数据、JSONL/原生 Pi 会话、检查点顺序、重复提交、取消、进程
重启、工具重放安全和单写入者规则。任何冻结的 Rust 存储所有权或 RPC 契约变更都需要
新的 ADR 和数据迁移方案。

## 4. 后续移除 `pi-coding-agent`

该依赖不是新 agent-runtime 功能的基础。完成以下替代接口后再移除：

1. 用桌面自有的读写实现替换 `native-pi-session.ts` 中的 `AgentSession`、
   `SessionManager`、`ModelRuntime`、资源加载器、trust-manager 和原生压缩调用；
   实现应读取既有原生 Pi JSONL 格式，并使用稳定的 pi Agent 循环。
2. 保持扩展 SDK 契约向后兼容，同时让运行时 shim 和导出的扩展类型归 PI-Desktop
   所有。保留现有 virtual-module 行为与发现规则。
3. 一并移除直接依赖、更新包固定版本和补丁，然后对新依赖图运行原生会话、可信扩展、
   compaction、构建和 package bundle 检查。

在此之前，新增 `pi-coding-agent` 导入必须有明确兼容原因，并限制在原生会话或扩展兼容
边界内。不要为了接替已移除的 pi-agent-core API 而把这些 API 转移到该包。

## 5. 兼容性不变量

- Renderer、Electron Main、host-core 和 sidecar 的职责保持不变。
- 现有会话数据及公开 RPC / Plugin SDK 契约仍可读取。
- 完整转录继续可见；压缩只改变模型上下文，并通过 host-core 持久化。
- 取消、提供商重试、hosted-search 校验、工具顺序和扩展发现保持当前行为。
- 未来切换 `pi-durable` 必须单独评审，因为它会改变运行时/会话生命周期，不能仅由
  包版本升级推导出来。
