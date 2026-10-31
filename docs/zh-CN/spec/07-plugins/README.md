# 插件系统

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/README) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 目录：`docs/spec/07-plugins`

插件作者应该从面向任务开始
【从零到一的开发指南】(../../plugin-development.md)。文档在
该目录定义了规范性合同和实施边界。

| 文件 | 描述 |
|---|---|
| [01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system) | 插件系统概述 |
| [02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) | Manifest Schema |
| [03-plugin-api.md](/zh-CN/spec/07-plugins/03-plugin-api) | 插件 API |
| [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) | 插件安全 |
| [05-plugin-lifecycle.md](/zh-CN/spec/07-plugins/05-plugin-lifecycle) | 生命周期 |
| [06-plugin-packaging.md](/zh-CN/spec/07-plugins/06-plugin-packaging) | 包装及安装 |
| [07-plugin-marketplace.md](/zh-CN/spec/07-plugins/07-plugin-marketplace) | 插件市场 |
| [08-plugin-signing-updates.md](/zh-CN/spec/07-plugins/08-plugin-signing-updates) | 签名和更新 |
| [09-plugin-command-palette.md](/zh-CN/spec/07-plugins/09-plugin-command-palette) | 命令面板 |
| [10-plugin-devex.md](/zh-CN/spec/07-plugins/10-plugin-devex) | 开发者经验 |
| [11-plugin-storage-isolation.md](/zh-CN/spec/07-plugins/11-plugin-storage-isolation) | 存储隔离 |
| [12-plugin-ipc-and-host-services.md](/zh-CN/spec/07-plugins/12-plugin-ipc-and-host-services) | 主机服务和 IPC |
| [13-plugin-permissions-matrix.md](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix) | 权限矩阵 |
| [14-plugin-roadmap.md](/zh-CN/spec/07-plugins/14-plugin-roadmap) | 插件路线图 |
| [15-plugin-center.md](/zh-CN/spec/07-plugins/15-plugin-center) | 插件中心（发布侧） |
| [16-trusted-extensions.md](/zh-CN/spec/07-plugins/16-trusted-extensions) | 受信任扩展（sidecar 内扩展面） |

## 从契约回查代码

每个可调用方法见[完整 SDK 索引](../../plugin-development.md#13-complete-sdk-surface-and-source-map)，
授权见权限矩阵。SDK、安装器和运行时是独立校验层，指南明确指出差异，不能把宽松解析当成授权。

| 范围 | 实现依据 |
|---|---|
| Manifest, permission vocabulary, host API | `packages/plugin-sdk/src/index.ts` |
| Renderer slots, actions, drafts, attachments | `packages/plugin-sdk/src/renderer.ts`, `renderer-composer.ts` |
| File/network/theme/MCP rules | SDK policy helpers and their unit tests |
| Templates, checks, packing, submission preparation | `packages/plugin-devkit/src` and its tests |
| Install, registry, marketplace, ownership | `crates/host-core/src/plugins` |
| Broker dispatch, callbacks, cleanup, events | `apps/desktop/electron/main/plugin-runtime.ts`, `plugin-host-process.mjs` |
| Panel bridge and command search | `apps/desktop/electron/preload/plugin-panel.ts`, `apps/desktop/electron/main/ipc/market-ipc.ts` |
| Trusted extension subset | `packages/agent-runtime/src/extensions` and spec 16 |
| Representative host/user paths | `apps/desktop/test/plugin-*.test.mjs`, repository example plugins |

生命周期提案、无设备后端的后台音频、签名规划、中心服务架构，都与已实现的运行时 API 区分。
`docs/plugin-plan` 的评审页可能包含尚未实现的钩子，不是额外公开 API。
