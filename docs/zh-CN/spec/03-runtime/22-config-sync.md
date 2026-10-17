# 便携式配置同步

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/22-config-sync) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

Status: S3-only encrypted configuration backup and synchronization.

The current contract is [the English source](/spec/03-runtime/22-config-sync).
Portable configuration excludes chats, project source, attachments, runtime
state and model weights. Only redacted state is returned to the renderer.

## 1. 所有权与边界

进程路径保持不变：

```text
Renderer → Preload IPC → Electron Main → host-core → private S3-compatible bucket
```

Host Core owns S3 transport, keys, revisions, baselines, staging, approvals and
application. Electron Main is a thin IPC bridge; Agent Runtime owns no sync.

导出路径是 `crates/host-core/src/config_sync/domains.rs` 中按域明确列出的 allowlist。它不会序列化数据库、secrets 目录或任意文件系统树。本地路径、窗口状态、就绪标记、OAuth 会话、插件二进制文件和设备审批属于本地覆盖或排除数据。
同一模块为每个受支持的域暴露适配器注册表，声明 schema 版本、便携/秘密字段、本地覆盖、身份与引用、合并粒度、激活方式以及恢复策略。

## 2. 便携域

当前适配器集合覆盖应用偏好、用户所有的 providers、MCP 定义、用户 skills、全局 subagents、由应用管理的全局/项目指令、插件安装意图、定时自动化任务以及可选的项目记忆。凭据默认需要明确选择。只有选中凭据类别时才会包含 provider API key 和 MCP 环境变量/headers；OAuth access/refresh token 与 cookies 永远不会导出。
指令适配器只读取固定的全局 `~/.pi/agent/AGENTS.md` 和每个已注册项目根目录的 `AGENTS.md`；不会扫描嵌套仓库或任意文件。导入的指令文件只有在明确选择其作用域、完成必要映射并获得审批后才会写入。
指令文件没有单独的字节上限；其内容只受 Host 在上传与远程校验时统一的便携实体负载上限约束。
目录形态的 skills 会将有界的同级资源作为已认证对象携带。Host 会校验 package path、symlink、冲突、文件数量和总大小后才写入已审批的资源：每个 package 最多 256 个资源、单个资源 2 MiB、整个 package 16 MiB；技能文档本身仍保持 128 KiB 上限，因为它可能进入 prompt。脚本按字节存储，导入时绝不执行。

项目和项目组列表保留在本机。同步和备份均不采集或应用其名称、置顶、根目录列表和排序，也不提供 projects 类别。同步和恢复会忽略既有 vault 修订中的旧 `projects` 实体；不会因此删除本机项目或云端修订历史。项目级 MCP、skills、指令、记忆和自动化绑定仍通过本地文件夹映射受支持。需要本地 workspace 的功能由接收设备自行注册项目和项目组。

项目和 workspace 绑定使用不透明的逻辑标识符表示。Host-core 为每个已注册的独立项目分配持久逻辑身份；项目组根目录的身份由组身份和有序根位置派生。设备映射把接收的逻辑 ID 覆盖到本地文件夹，因此不同绝对路径不会产生重复实体。
传入的项目作用域可执行内容在本地文件夹映射和审批存在前保持暂存。加密的便携实体负载中不会写入本地路径。没有受支持适配器的插件数据会报告为不支持，而不会被声称为已同步。已审批的插件安装意图保存在 Host 所有的本地覆盖中；它不会拉取插件字节或权限授予。

## 3. Vault and S3 protocol

每个 vault 都有随机 data key。备份密码使用有界的 Argon2id 参数处理，data key 使用 AES-256-GCM 包裹。每个 head、revision manifest 和 resource object 都使用按 purpose/vault 派生的对象密钥、域隔离的关联数据和新鲜 nonce 单独认证。resource object ID 是带密钥的内容标识符，因此不需要明文全局 hash。vault envelope 版本独立于 SQLite schema；密码派生发生变化时会提升该版本。

S3 uses origin-only endpoints, region, bucket, prefix, access key ID, secret
access key, optional session token and path-style/virtual-hosted addressing.
Defaults: `us-east-1`, `pi-desktop/config`, path style, and `sync` mode.
The private bucket must already exist; Host does not create it or change ACLs.

```text
<bucket>/<prefix>/header
<bucket>/<prefix>/vault/<vault-id>/head
<bucket>/<prefix>/vault/<vault-id>/backup-head
<bucket>/<prefix>/vault/<vault-id>/revisions/<revision-id>
<bucket>/<prefix>/vault/<vault-id>/objects/<object-id>
```

SigV4 signs conditional headers and optional session tokens. The probe verifies
exclusive creation, readback, matching update, stale-write rejection and its
own random-object cleanup. Strong ETags and reliable `If-None-Match`/`If-Match`
are mandatory. There is no WebDAV, append-only mode or unconditional fallback.
Only GET 404 means absent; 403 and 502 remain errors. Redirects and public HTTP
are rejected. LAN HTTP follows Host network policy, not a sync checkbox.
Requests use 10-second connect and 60-second total timeouts, 64 MiB object
bounds, and validated safe ASCII paths. Userinfo, query, fragment and non-root
endpoint paths are rejected. Raw credentials/signatures are not logged.

Credentials are reused only for the same full connection identity. Omitted
secret/token inputs mean reuse; an empty token clears it. Supplying both fields
permits full replacement without reading damaged old credentials. Connection
or mode changes create fresh local state; pending imports must be resolved.

## 4. 合并与激活

Sync uses three-way merge and CAS publication. Shared and observed baselines
separate cloud acknowledgment from local overlays and credential opt-out.
Unacknowledged local edits stay visible. Tombstones include deletion state and
refreshed digests; category opt-out does not delete remote entities. Backup
publishes local snapshots to `backup-head` without applying remote settings.
Both modes have independent 30-entry history indexes; immutable objects remain
indefinitely, so history is bounded but cloud storage is not.

相同编辑会收敛，不相交编辑可以继续。同一单元编辑以及 delete-versus-edit 会将两个候选都保留为冲突。导入的 MCP、skills、subagents、plugins 和 automations 需要本地激活审批；审批绑定实体 digest。因此命令、endpoint、脚本、指令或凭据目的地改变后，旧审批会失效。缺失的 provider 引用会作为依赖审批保留，而不会被写成不可用的默认值；无关实体仍可继续应用。
Host 绝不会仅因为 UI flag 被设置就激活暂存的可执行内容。新导入的 automation 定义同样会被禁用，直到本设备明确取得执行所有权；已有本地任务继续使用其设备本地启用状态。

导入路径会在应用每个实体前重新检查捕获到的本地 generation。捕获之后发生的修改会保留，并在下一轮重新协调。持久化的加密 pending bundle 会记录捕获的本地 manifest 和 `applying` 标记；重启恢复会完成已审批步骤，或在认为配置已收敛前保留 bundle 供重试。现有的本地 MCP 直接创建行为不变。

Receiving application settings use the portable allowlist; credential opt-out
also applies on import. Skill resource updates check expected bytes and paths,
preserve unrelated files, and delete only omitted synchronized files. Per-file
atomic replacement and import journaling are not a filesystem-wide transaction.

## 5. 设置工作流

「设置 → 云同步」在开发版和打包版中均可用，导轨行与页面标题带有实验性徽章。开放该入口不改变本文描述的 Host 同步行为。

Settings exposes S3 fields, vault password, device label, modes, automatic runs,
categories, probing, manual run, pause, unlock, approvals, mappings, history,
restore, password rewrap and disconnect. Existing distinct status codes remain.
The S3 draft key is `pi.desktop.configSyncS3Draft.v1`; old drafts are ignored,
not deleted. Persist only typed non-secret choices. Secrets and passwords stay
in transient input memory and are cleared after save. A replacement secret with
a blank token clears the old token. Saved destination/mode changes invalidate
history and outstanding responses; unsaved mode edits do not alter restore.

Progress phases are `capture`, `download`, `merge`, `upload`, and `apply`, with
unit/byte totals of zero meaning unknown. No cleanup phase remains. Credentials
and memory remain opt-in; keys and exported secrets are never returned to the
renderer. Newly entered connection secrets/passwords are transient IPC inputs.

`configSync.syncNow` has no aggregate RPC deadline. The Host owns the operation,
so navigating away from Settings does not cancel it. Returning to the page reads
the Host's `syncing` state, disables duplicate actions, and subscribes to the
remaining progress reports. Individual S3 requests retain their own timeouts;
normal Host/process shutdown remains the lifecycle boundary.

Host 负责自动同步启用后的启动即时检查、30 秒本地变更防抖以及有界的五分钟远端轮询。失败网络请求使用带 jitter 且有上限的指数重试；paused、locked、不兼容、认证和错误密码状态不会启动重试循环。应用退出时 worker 会随 Host 取消；退出后没有额外 daemon。

## 6. 持久性与兼容性

S3 uses `configSyncS3/config` and `config-sync/s3/<state-id>/`. Encrypted
shared/observed baselines, pending bundles and recovery points use temp-file
rename. Malformed or unauthenticated state is an error, never an empty state.
The existing local secret store uses encrypted files plus a colocated
`.machine-key`, not OS Keychain protection. SQLite schema is unchanged.

Only the new S3 format is supported. Old configuration and backups are not
detected, interpreted or migrated. Existing unrelated files and cloud objects
are not deleted. Disconnect removes only current S3 state.

An applied conflict choice records both candidate digests. The next sync
folds only that exact unchanged pair into the chosen entity and publishes it
with CAS. Changed candidates require another explicit choice.

Restore first writes a local recovery point. Sync restore requires propagation
acknowledgment and immediately publishes a new revision; sensitive activation
still requires device-local approval. Backup restore is local only and may
restore the latest backup without changing either cloud head. Password changes
CAS-rewrap the same key and do not revoke previously unlocked devices. A fresh
device cannot prove a malicious server returned the newest valid backup.
