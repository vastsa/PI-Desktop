# 便携式配置同步

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/22-config-sync) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

状态：已实现已批准 WebDAV 配置同步切片的基线。

便携式配置同步是由 Host 所有、使用加密 WebDAV 的工作流。它不会同步对话历史、项目源文件、附件、运行时状态或模型权重。Renderer 只接收脱敏后的状态、预览计数、冲突和激活摘要。

## 1. 所有权与边界

进程路径保持不变：

```text
Renderer → Preload IPC → Electron Main → host-core → WebDAV
```

Host-core 持有 vault key、WebDAV 传输、修订状态、合并基线、待处理审批、本地加密暂存以及导入应用。Electron Main 只注册 IPC 处理器并转发 `configSync.changed`。Agent Runtime 不实现同步。

导出路径是 `crates/host-core/src/config_sync/domains.rs` 中按域明确列出的 allowlist。它不会序列化数据库、secrets 目录或任意文件系统树。本地路径、窗口状态、就绪标记、OAuth 会话、插件二进制文件和设备审批属于本地覆盖或排除数据。
同一模块为每个受支持的域暴露适配器注册表，声明 schema 版本、便携/秘密字段、本地覆盖、身份与引用、合并粒度、激活方式以及恢复策略。

## 2. 便携域

当前适配器集合覆盖应用偏好、用户所有的 providers、MCP 定义、用户 skills、全局 subagents、由应用管理的全局/项目指令与项目、插件安装意图、定时自动化任务以及可选的项目记忆。凭据默认需要明确选择。只有选中凭据类别时才会包含 provider API key 和 MCP 环境变量/headers；OAuth access/refresh token 与 cookies 永远不会导出。
指令适配器只读取固定的全局 `~/.pi/agent/AGENTS.md` 和每个已注册项目根目录的 `AGENTS.md`；不会扫描嵌套仓库或任意文件。导入的指令文件只有在明确选择其作用域、完成必要映射并获得审批后才会写入。
目录形态的 skills 会将有界的同级资源作为已认证对象携带。Host 会校验 package path、symlink、冲突、文件数量和总大小后才写入已审批的资源：每个 package 最多 256 个资源、单个资源 2 MiB、整个 package 16 MiB；技能文档本身仍保持 128 KiB 上限，因为它可能进入 prompt。脚本按字节存储，导入时绝不执行。

项目和 workspace 绑定使用不透明的逻辑标识符表示。Host-core 为每个已注册的独立项目分配持久逻辑身份；项目组根目录的身份由组身份和有序根位置派生。设备映射把接收的逻辑 ID 覆盖到本地文件夹，因此不同绝对路径不会产生重复实体。
传入的项目作用域可执行内容在本地文件夹映射和审批存在前保持暂存。加密的便携实体负载中不会写入本地路径。没有受支持适配器的插件数据会报告为不支持，而不会被声称为已同步。已审批的插件安装意图保存在 Host 所有的本地覆盖中；它不会拉取插件字节或权限授予。

## 3. Vault 与 WebDAV 协议

每个 vault 都有随机 data key。备份密码使用有界的 Argon2id 参数处理，data key 使用 AES-256-GCM 包裹。每个 head、revision manifest 和 resource object 都使用按 purpose/vault 派生的对象密钥、域隔离的关联数据和新鲜 nonce 单独认证。resource object ID 是带密钥的内容标识符，因此不需要明文全局 hash。vault envelope 版本独立于 SQLite schema；密码派生发生变化时会提升该版本。

远端布局是不透明 header 和不可变 revision/resource object。严格模式额外使用一个可变加密 head：

```text
<selected-directory>/header
<selected-directory>/vault/<opaque-vault-id>/head
<selected-directory>/vault/<opaque-vault-id>/revisions/<revision-id>
<selected-directory>/vault/<opaque-vault-id>/objects/<object-id>
```

严格模式初始化使用 `If-None-Match: *`。已有 head 必须有 strong ETag，并使用 `If-Match` 发布。前置条件失败时会从重新读取的 head 开始重新协调；绝不会盲目覆盖。能力探测会用临时对象进行两次条件创建，取得 strong ETag，验证匹配的 `If-Match` 更新，并验证旧的 `If-Match` 会被拒绝，然后删除该对象。

设置页还提供一个明确选择的追加式兼容模式，用于忽略条件头的服务器。能力探测仍必须证明有界的 `PROPFIND` 目录列表能力。兼容模式增加不透明的每设备指针集合：

```text
<selected-directory>/vault/<opaque-vault-id>/heads/<device-id>
```

每台设备只覆盖自己的加密指针，并通过回读验证。同步会列出所有指针（若存在也会纳入旧的严格模式 head），遍历有界的父 revision 图，移除作为其他指针祖先的指针，并以已确认的基线合并剩余 tips。新 revision 和 resource 使用唯一不可变对象；复用已有 resource 前会先读取并认证。兼容模式保留不可变历史，不运行远端清理，因为服务器无法提供安全的跨设备确认协议。共享同一 vault 的所有设备必须使用相同模式。该模式不会被静默选择，也不宣称提供严格 CAS 保证。

部分 WebDAV 网关会把不存在的对象返回为 `502 Bad Gateway`，而不是
`404 Not Found`。能力探测会在删除临时对象后记录所选 endpoint 的这一行为；后续读取只会将该
endpoint 已观测到的状态视为对象不存在，其他非成功响应仍然报错。这不会放宽严格模式的条件写要求：忽略 `If-None-Match` 或 `If-Match` 的服务器，只有在用户选择追加式兼容模式且目录列表探测成功后，才支持双向同步。

默认要求 HTTPS。设置页可显式确认 LAN HTTP 风险，但 Host 仅接受 localhost、`.local` 或私有／链路本地 IP；公网 HTTP 仍会被拒绝。3xx 重定向会被拒绝且不会跟随；成功响应仍可以带 Location。endpoint userinfo、路径穿越、不安全远端名称、过大对象、weak ETag 和无界 KDF 参数都会被拒绝。所选端点下缺失的集合（含嵌套远程目录）会按顺序创建。已保存的 WebDAV 应用密码只对同一端点和账户复用。再次保存同步设置会保留已有的暂停状态。Host 错误使用稳定的 `CONFIG_SYNC_*` 代码，设置页据此给出恢复说明。

## 4. 合并与激活

本地加密基线是最后一次确认的共同 revision。每个 vault 内的捕获、远端读取、三方合并、不可变对象上传、head 发布和本地应用会串行执行。严格模式使用 CAS head 发布；兼容模式发布每设备指针并合并发现的 tips。标量设置按声明的实体单元合并；provider 记录、MCP 记录、skill package 和 automation 定义不会作为任意 JSON 数组合并。tombstone 表示明确删除；未选择的类别不表示删除。

相同编辑会收敛，不相交编辑可以继续。同一单元编辑以及 delete-versus-edit 会将两个候选都保留为冲突。导入的 MCP、skills、subagents、plugins 和 automations 需要本地激活审批；审批绑定实体 digest。因此命令、endpoint、脚本、指令或凭据目的地改变后，旧审批会失效。缺失的 provider 引用会作为依赖审批保留，而不会被写成不可用的默认值；无关实体仍可继续应用。
Host 绝不会仅因为 UI flag 被设置就激活暂存的可执行内容。新导入的 automation 定义同样会被禁用，直到本设备明确取得执行所有权；已有本地任务继续使用其设备本地启用状态。

导入路径会在应用每个实体前重新检查捕获到的本地 generation。捕获之后发生的修改会保留，并在下一轮重新协调。持久化的加密 pending bundle 会记录捕获的本地 manifest 和 `applying` 标记；重启恢复会完成已审批步骤，或在认为配置已收敛前保留 bundle 供重试。现有的本地 MCP 直接创建行为不变。

## 5. 设置工作流

设置 → 云同步提供 WebDAV endpoint 凭据、vault 密码、设备标签、服务器兼容模式、类别选择、能力测试、立即同步、解锁、暂停、文件夹映射、批准/拒绝、revision history/restore、vault 密码重新包裹以及断开连接控制。严格 CAS 是默认模式。选择追加式兼容模式会显示持续风险提示，并在保存配置前要求确认；其测试成功提示目录列表支持，而不是条件写支持。Renderer 将 `notConfigured`、`locked`、`upToDate`、`localChangesPending`、`syncing`、`offline`、`unsupportedServer`、`conflict`、`awaitingActivation`、`paused` 和 `error` 显示为不同状态。断开连接会保留本地数据，不会删除远端数据。

重新打开页面时，先用短时的 Renderer 缓存绘制最近一次脱敏的 Host 状态和历史记录，随后在后台刷新 Host。连接草稿（endpoint、用户名、远程目录、设备标签、兼容模式和类别选择）保存在 Renderer 本地存储中，因此离开页面或重载后未完成的表单仍会保留；Host 确认已保存的配置后，草稿会重新标记为已保存。WebDAV 应用密码留在 Host secret store 中，且只对同一 endpoint 和账户复用；Renderer 永远不会存储任一密码，只有新设备或已锁定设备需要打开 vault 时才需要输入 vault 密码。

手动同步会在运行期间报告它正在做什么。`configSync.progress` 携带当前阶段（`capture`、`download`、`merge`、`upload`、`apply` 或 `cleanup`）、该阶段已完成的单位数，以及已知时的字节数：`done`/`total` 在传输时计资源对象（追加式模式下计正在读取的设备 tip）、其他阶段计实体；`total` 为 0 表示该阶段无法预知总量；`bytesTotal` 为 0 表示字节数未知，这是下载阶段的常态。报告会节流，阶段变化绝不丢弃，状态事件与调用的返回值仍是终态信号。后台轮询不报告进度：只有手动路径有调用方在等待。

凭据和 memory 默认未选中。设置预览报告 supported、excluded、secret-bearing、mapping-required 和 pending-activation 计数。原始秘密值、vault key 和备份密码永远不会跨过 Renderer 边界。

Host 负责自动同步启用后的启动即时检查、30 秒本地变更防抖以及有界的五分钟远端轮询。失败网络请求使用带 jitter 且有上限的指数重试；paused、locked、不兼容、认证和错误密码状态不会启动重试循环。应用退出时 worker 会随 Host 取消；退出后没有额外 daemon。

## 6. 持久性与兼容性

同步配置存储在 Host 的 `kv` namespace 中。vault key 和 WebDAV password 使用现有 Host secret store。本地基线和 pending bundle 会加密，并通过临时文件 rename 替换。格式错误或未认证的本地 bundle 会报告错误，而不是当作空状态。备份格式版本独立于 SQLite schema；遇到更新格式时会拒绝且不截断本地表示。

严格模式的远端 history 保留最新 30 个可达的逻辑 revision，并保护当前 head、merge base、待处理冲突引用和恢复点；只有在宽限期结束且发布成功后才会删除未引用对象。兼容模式保留不可变历史，因为没有安全的跨设备清理确认。restore 会先写入恢复前的本地加密恢复点，再发布新的 revision。严格模式下 vault 密码变更会 CAS 更新 wrapped-key header；兼容模式使用无条件写入后再认证回读。两种模式都不会改变 vault data key；已复制的旧 key 无法被密码变更进行密码学撤销，因此移除设备不等同于撤销访问。

项目组映射接受有序的多根绑定，并保留 primary root 不变量。WebDAV 测试使用进程内 fixture 覆盖条件创建、strong-ETag 更新、旧 writer 拒绝、空 vault 竞争和 weak-ETag 拒绝。剩余的可用性限制是固有的：没有可信 head 历史的新设备无法证明恶意服务器返回的是最新有效备份。
