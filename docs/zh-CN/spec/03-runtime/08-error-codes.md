# 08. 错误代码

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/08-error-codes) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 事实来源：`packages/shared/src/errors.ts` (`ErrorCodes`)。代码在
> §3.7 被保留（在发布之前记录）；其他一切都是实时的。

## 1. Goal

提供一种稳定的错误词汇表：

- Renderer 用户界面
- Electron IPC
- Rust 主机 RPC
- Node pi sidecar 桥

## 2. 错误对象

```ts
type AppError = {
  code: string            // stable machine code, e.g. TOOL_DENIED
  message: string         // English UI/default message
  details?: unknown
  retriable?: boolean
  source?: "renderer" | "electron" | "host" | "agent" | "plugin"
  causeCode?: string      // nested/transport code if mapped
  traceId?: string
}
```

规则：

1. `code` 一旦发布就不可更改
2. `message` 为英文源文本（i18n 键可单独映射）
3. UI 应该更喜欢从 `code` 派生的 i18n 密钥（如果可用）

## 3. 代码注册

### 3. 1 应用程序/协议

| 代码 | 可重审的 | 意义 |
|---|---|---|
| `PROTOCOL_MISMATCH` | 不 | handshake/protocol 版本不匹配 |
| `HOST_UNAVAILABLE` | 是的 | Rust 主机不是 running/reachable |
| `HOST_OVERLOADED` | 是的 | 绑定主机 RPC/tool 容量已满；背压后重试 |
| `AGENT_UNAVAILABLE` | 是的 | pi sidecar 不是 running/reachable |
| `APP_DEGRADED` | 是的 | 应用程序以有限的功能运行 |
| `INTERNAL` | 也许 | 意外的内部故障 |
| `INVALID_ARGUMENT` | 不 | 请求 schema/args 无效，包括错误 file/directory 类型的本机工具路径 |
| `UNAUTHORIZED` | 不 | capability/auth 边界拒绝呼叫 |
| `NOT_FOUND` | 不 | 未找到实体 |
| `CONFLICT` | 也许 | 状态冲突/资源繁忙 |
| `TIMEOUT` | 是的 | 通用超时 |

`HOST_UNAVAILABLE` 是为丢失或损坏的主机 process/transport 保留的，
不是普通的入学压力。 RPC 容量返回 `HOST_OVERLOADED`，并且
由于操作系统暂时无法启动而无法启动的 shell
进程资源返回 `PROCESS_RESOURCE_EXHAUSTED`。主机核的控制
stdio 与 Tokio 的动态阻塞池隔离，因此后一种情况
不会将临时线程压力转变为主机进程退出。

### 3. 2 Agent/会话

| 代码 | 可重审的 | 意义 |
|---|---|---|
| `AGENT_BUSY` | 不 | 会话已经有活动轮次 |
| `AGENT_NOT_FOUND` | 不 | 会话丢失 |
| `TURN_NOT_FOUND` | 不 | 使 id 无效 |
| `TURN_ABORTED` | 不 | 回合被 user/system 中止 |
| `MODEL_NOT_CONFIGURED` | 不 | 未选择可用模型，或提供商因未知而拒绝所选模型 |
| `PROVIDER_ERROR` | 是的 | 上游提供商故障；可重试的故障（5xx 网关）最多获得四次同回合重试，格式错误的 400/422 请求是终止的 |
| `PROVIDER_UNAUTHORIZED` | 不 | bad/missing 提供商凭证 |
| `PROVIDER_RATE_LIMITED` | 是的 | 供应商费率有限 |
| `CONTEXT_TOO_LARGE` | 不 | 恢复后 prompt/context 仍超出安全模型预算、发生第二个提供程序溢出或禁用自动恢复 |
| `CONTEXT_COMPACTION_FAILED` | 不 | 自动保留尾部恢复无法准备、持久或适合检查点，或手动检查点摘要生成/持久追加失败；受保护的下一个提供程序请求不会启动 |
| `STREAM_FAILED` | 是的 | 提供程序流在完整响应之前终止、提前关闭或以其他方式结束；最多四次同回合重试可能会在终止事件之前发生 |
| `EMPTY_MODEL_RESPONSE` | 是的 | 模型在没有工具调用且没有可见文本的情况下结束了两次：一次是流式传输，一次是在自动重新运行后（规范 02-agent-runtime §5e） |

### 3. 3 工作空间/工具/权限

| 代码 | 可重审的 | 意义 |
|---|---|---|
| `WORKSPACE_REQUIRED` | 不 | 无工作空间限制 |
| `PATH_OUTSIDE_WORKSPACE` | 不 | 在显式外部路径权限决策或未经许可的兼容性调用到达解析器之前，路径逃逸沙箱 |
| `TOOL_NOT_FOUND` | 不 | 未知工具 |
| `TOOL_DENIED` | 不 | 权限被拒绝/模式被禁止 |
| `TOOL_TIMEOUT` | 是的 | 工具执行超时 |
| `TOOL_FAILED` | 也许 | 工具已执行但失败 |
| `MUTATION_RETRY_BUDGET_EXHAUSTED` | 是 | 重复保护在同路径 `Edit` 或 shell patch 反复失败后终止了本轮；携带 `details.kind`（`edit` 或 `patch-command`）与最后一个工具错误代码 |
| `PROCESS_RESOURCE_EXHAUSTED` | 是的 | shell 进程无法启动，因为操作系统暂时耗尽了进程资源 |
| `SHELL_NOT_FOUND` | 不 | 目录回退后没有有效的平台 shell 可用；消息承载指引 |
| `COMMAND_SHELL_CHANGED` | 不 | 固定的 shell ID 或方言在执行前已更改 |
| `COMMAND_SHELL_INVALID` | 不 | 设置提供了未知、不可用或错误的平台 shell ID |
| `PERMISSION_TIMEOUT` | 不 | 权限提示超时（映射为拒绝） |
| `PERMISSION_REQUIRED` | 不 | 等待用户决定 |
| `WRITE_DISABLED_IN_PLAN` | 不 | Write 的契约模式硬拒绝 |
| `EDIT_DISABLED_IN_PLAN` | 不 | 编辑的契约模式硬拒绝 |
| `PLUGIN_DISABLED_IN_PLAN` | 不 | 每个插件工具的契约模式硬拒绝 |
| `TOOL_DISABLED_IN_PLAN` | 不 | unknown/unlisted 工具的契约模式硬拒绝 |
| `PLAN_NOT_ACTIVE` | 不 | 在没有协商合同的情况下运行了提交工具 |
| `PLAN_KIND_MISMATCH` | 不 | Goal 模式下的 `SubmitPlan`，或 Plan 模式下的 `SubmitGoal` |
| `PLAN_APPROVAL_REQUIRED` | 不 | SubmitPlan/SubmitGoal 正在等待单独的批准 |
| `PLAN_APPROVAL_TIMEOUT` | 不 | 绝对 30 分钟计划批准期限已过 |
| `PLAN_APPROVAL_STALE` | 不 | 响应与实时 proposal/session/turn/tool-call/version 不匹配 |
| `PLAN_APPROVAL_INTERRUPTED` | 不 | 待批准在中止、崩溃或持久性失败期间关闭 |
| `PLAN_ARTIFACT_WRITE_FAILED` | 不 | 主机无法将确切的字节写入新的 `.pi/<kind>/*.md` 工件 |
| `PLAN_EXECUTION_INTERRUPTED` | 不 | 已批准的 queued/running Plan 或 Goal 执行已停止且不重播 |
| `PLAN_REQUIRES_INTERACTIVE_SESSION` | 不 | unattended/scheduled Plan 或 Goal 运行无法请求批准 |

`_IN_PLAN` 后缀和 `PLAN_` 前缀是历史性的：两种合约模式
（Plan 和 Goal）共享这些代码，而不是复制 `_IN_GOAL` 集
(**D198**)。渲染器从提案的 `kind` 中选择其措辞，因此
代码可以显示为“Plan”或“Goal”副本。

### 3. 4 Edit 契约（ADR 0087）

仅由 `Edit` 发出。版本与来源失败拥有各自的代码，因为每一个都指向不同的
下一步动作；把它们报告为 `TOOL_FAILED` 会丢失这一信息。见
[18-line-anchored-edit-contract](18-line-anchored-edit-contract.md) §11。

| 代码 | 可重试 | 含义 |
|---|---|---|
| `EDIT_TAG_REQUIRED` | 否 | `tag` 缺失或不是 4 位十六进制 |
| `EDIT_TAG_MISMATCH` | `Read` 之后可以 | tag 无法哈希出实时文件且漂移恢复拒绝；携带实时 tag 与锚点处的当前内容 |
| `EDIT_TAG_UNKNOWN` | `Read` 之后可以 | tag 格式正确，但本会话没有为该路径记录过对应内容 |
| `EDIT_LINES_UNSEEN` | 是 | 锚点引用了会话从未显示过的行；携带被揭示的内容 |
| `EDIT_PARSE_FAILED` | 否 | 操作头格式错误、无冒号头下出现正文行、缺少正文，或出现 `-`/上下文行 |
| `EDIT_RANGE_INVALID` | 否 | 范围反向、行号越界、操作重叠，或锚点重复 |
| `EDIT_BLOCK_UNRESOLVED` | 否 | `N*` 定位符无法解析；消息给出纯范围替代方案 |
| `EDIT_REGISTER_EMPTY` | 否 | 从未设置的寄存器粘贴 |
| `EDIT_REGISTER_AMBIGUOUS` | 否 | 存在多个待粘贴的匿名捕获时进行匿名粘贴 |
| `EDIT_REPAIR_AMBIGUOUS` | 否 | 边界修复候选在最小代价上并列 |
| `EDIT_NO_CHANGE` | 否 | 应用产生了与输入完全相同的文本 |
| `EDIT_AMPLIFICATION_LIMIT` | 否 | 下降展开超过膨胀上限 |

当消息报告 reveal 完整时，`EDIT_LINES_UNSEEN` **无需**再次 `Read` 即可重试：
被揭示的行已并入会话来源集，因此原样重试同一个 `tag` 即可应用。被截断的
reveal 不并入任何行，必须重新读取。

`EDIT_TAG_MISMATCH`、`EDIT_TAG_UNKNOWN` 与 `EDIT_LINES_UNSEEN` 在重复保护开始计数
之前，各自在每条路径上有一次免费尝试，因为每一个都已经携带了重试所需的东西。其余代码
在第一次出现时就计数，而耗尽额度的那次失败会以 §3.3 的
`MUTATION_RETRY_BUDGET_EXHAUSTED` 出现在 assistant 行上
（[18-line-anchored-edit-contract](/zh-CN/spec/03-runtime/18-line-anchored-edit-contract) §9.3）。

### 3. 5 秘密/设置

| 代码 | 可重审的 | 意义 |
|---|---|---|
| `PROVIDER_SECRET_MISSING` | 不 | 启用的提供程序需要 API 密钥 |
| `SECRET_STORE_UNAVAILABLE` | 也许 | 操作系统安全存储不可用（保留） |
| `SETTINGS_INVALID` | 不 | 设置有效负载无效（保留） |

### 3. 6 插件

| 代码 | 可重审的 | 意义 |
|---|---|---|
| `PLUGIN_NOT_FOUND` | 不 | 插件 ID 缺失（保留） |
| `PLUGIN_INVALID` | 不 | manifest/package 无效 |
| `PLUGIN_LOAD_FAILED` | 也许 | enable/load 失败 |
| `PLUGIN_DISABLED` | 不 | 插件已禁用（保留） |
| `PLUGIN_PERMISSION_DENIED` | 不 | 插件缺少 declared/granted 权限（保留） |
| `PLUGIN_COMMAND_NOT_FOUND` | 不 | 命令 ID 丢失（保留） |
| `PLUGIN_CRASHED` | 是的 | 插件运行时崩溃（保留） |
| `PLUGIN_CONTRACT_MISMATCH` | 不 | 不支持的 manifest/api 版本（保留） |

### 3. 7 保留的详细代码（尚未发布）

记录了更细粒度的 provider/tool 区别，以供将来映射。
在发布之前，实现使用所示的规范父代码。

| 保留代码 | 今天的规范父母 | 笔记 |
|---|---|---|
| `PROVIDER_BASE_URL_INVALID` | `PROVIDER_ERROR` | 端点无效（400） |
| `PROVIDER_PROTOCOL_MISMATCH` | `PROVIDER_ERROR` | 错误的协议配置文件 |
| `PROVIDER_MODEL_NOT_FOUND` | `MODEL_NOT_CONFIGURED` | 未知模型 ID (404) |
| `PROVIDER_TIMEOUT` | `TIMEOUT` | network/server 超时（可重试） |
| `PROVIDER_UNSUPPORTED_CAPABILITY` | `PROVIDER_ERROR` | tools/vision 不支持 |
| `PROVIDER_DISABLED` | `MODEL_NOT_CONFIGURED` | 提供商已禁用 |
| `WORKSPACE_PATH_DENIED` | `PATH_OUTSIDE_WORKSPACE` | ignore/denylist 块 |
| `TOOL_BINARY_CONTENT` | `TOOL_FAILED` | 拒绝二进制转储 |

历史别名（切勿在新代码中使用）：`PROVIDER_AUTH_FAILED` →
`PROVIDER_UNAUTHORIZED`； `PROVIDER_STREAM_INTERRUPTED` → `STREAM_FAILED`；
`WORKSPACE_OUTSIDE_ROOT` → `PATH_OUTSIDE_WORKSPACE`； `SECRET_MISSING` →
`PROVIDER_SECRET_MISSING`； `SHELL_UNAVAILABLE` → `SHELL_NOT_FOUND`；
`SHELL_IDENTITY_STALE` → `COMMAND_SHELL_CHANGED`； `PLAN_APPROVAL_EXPIRED` →
`PLAN_APPROVAL_TIMEOUT`。截断不是错误：有界工具结果
带有一个标记，命名哪一端幸存以及其余部分在哪里，或者报告
同级结果字段中的有界窗口
（请参阅 [16-工具-结果-限制](/zh-CN/spec/03-runtime/16-tool-result-limits)）。

## 4. 映射规则

### 主机 RPC 数字 → AppError.code
请参阅 `06-host-rpc-protocol.md` 数值表。
示例：主机 `1004` → `TOOL_DENIED`。

### 提供商例外
Node sidecar 将提供商 SDK 错误映射到：

- `PROVIDER_UNAUTHORIZED`
- `PROVIDER_RATE_LIMITED`
- `MODEL_NOT_CONFIGURED`（提供商拒绝选择的模型并返回 404）
- `PROVIDER_ERROR`
- `NETWORK_ERROR`
- `STREAM_FAILED`

精确的 `terminated` 提供商消息和等效的过早流关闭
消息映射到 `STREAM_FAILED`。请求设置阶段或响应后的
`PROVIDER_RATE_LIMITED` 使用共享的运行时预算：初始尝试之后最多五次重试，
且设置和流式传输失败一起计数。非 429 瞬时故障——`STREAM_FAILED`、
`NETWORK_ERROR`、`TIMEOUT` 以及可重试的 `PROVIDER_ERROR`（例如上游网关
502/503/504）——共享它们自己的有界预算：初始尝试之后最多四次重试，同样
跨请求设置和流式传输一起计数，并且与 429 预算相互独立。两个预算都是
可中止的。429 路径在客户端退避之前先遵循 `retry-after-ms`、`retry-after`
秒和 HTTP 日期标头，并将等待上限设为 30 秒；非 429 路径应用相同的优先级，
上限为 8 秒，在其他情况下依次等待 1 秒、2 秒、4 秒，然后是 8 秒。只有失败
的请求会被重放；会话及其工具状态保持不变。来自格式错误的 400/422 请求的
不可重试 `PROVIDER_ERROR` 永远不会进入任何预算。预算耗尽后的失败仍然是
致命的。

### 权限超时
UI/host 超时在内部发出 `PERMISSION_TIMEOUT`，工具结果向代理显示为拒绝 (`TOOL_DENIED`)。

### Shell 和 Plan/Goal 检查点失败

仅当目录回退发现不可用时才返回 `SHELL_NOT_FOUND`
平台外壳。 `COMMAND_SHELL_CHANGED` 永远不会使用不同的 shell 重试；
该回合必须获得新的有效 ID/dialect。 `PLAN_ARTIFACT_WRITE_FAILED`
从不创建批准行。 `PLAN_APPROVAL_TIMEOUT` 仅适用于
绝对待决期限；
`PLAN_EXECUTION_INTERRUPTED` 标识已批准的 queued/running
执行因中止或主机恢复而中断。 `PLAN_KIND_MISMATCH` 是
终止工具错误，如 `PLAN_NOT_ACTIVE`：提交工具运行于
错误的合同，因此没有编写任何工件，也没有创建批准行。

## 5. UI 处理指南

| 类 | 用户界面行为 |
|---|---|
| auth/config（`PROVIDER_SECRET_MISSING`、`MODEL_NOT_CONFIGURED`） | 带有设置 CTA 的助理错误消息 |
| 拒绝许可 | 内联工具卡状态 |
| 可重试的 provider/network | 带有重试操作的助理错误消息 |
| internal/host 不可用 | 降级横幅 + 恢复提示 |

消息绑定提供程序故障从不使用 toast 或浮动全局横幅。
助手错误消息显示本地化摘要和稳定代码，并带有
包含经过编辑的提供商响应的可访问详细信息披露，
提供商 ID 和模型 ID。提供商详细信息上限为 600 个字符，并且
公共 credential/header 值在事件发射之前进行编辑或
坚持。如果有的话，详细信息披露和计时日志也可能
显示有界 `phase`、`providerStatus`、`providerCode`、`providerWaitMs`、
`streamMs` 和 `retryAttempt` 字段。

## 6. i18n 按键约定

```text
errors.<code>
errors.<code>.action
```

示例：

- `errors.PROVIDER_SECRET_MISSING`
- `errors.PROVIDER_SECRET_MISSING.action`
- `errors.HOST_UNAVAILABLE`

## 7. 验收

1. 每次 IPC 失败都会返回 `AppError.code`
2. 主路径上没有原始非类型化字符串故障
3. Plan/Goal 硬否认使用显式特定于工具的代码； Bash 从未被否认
   仅仅因为运营模式而采用任一合同模式，而不是
   遵循权限策略
4. 主机数字代码映射到稳定的字符串代码
5. 无效的 shell 设置、no-effective-shell/stale-pin、artifact-write、
   到期、计划拒绝和重新启动中断路径映射到稳定
   代码；仅允许记录的预转目录后备，并且不进行任何工作
   正在重播
