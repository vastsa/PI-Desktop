# 04. 数据存储（架构 v11）

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/04-data-storage) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 0. 所有权决定

**Rust host-core 独家拥有 SQLite (D002)，以及转录文件
与它一起存储（D119）。 Plan/Goal 工件和队列记录也是主机拥有的
（D189）； shell 默认值是主机设置 (D190)。**

- Node pi sidecar 不直接打开数据库或转录文件
- Electron main 不直接写入 DB 或转录文件
- 所有持久应用程序数据 - 会话、设置、提供程序、计划任务、
  工件、通知、审核 — 通过主机 RPC。 （v1 违规
  已修复：以前位于 Electron 拥有的计划任务
  `scheduled-tasks.json`.)

## 1. 目标

本地优先、重启后可恢复、敏感数据隔离 — 另外，对于
架构 v7、v8 和 v11：

1. **无损转录** — 存储运行时消息形状（内容块），
   不是 UI 投影； UI 形状是在 RPC 边界处导出的。
2. **SQLite 是一个索引，而不是有效负载存储 (D119)** — 消息内容有效
   每个会话一个 JSONL 文件（codex/claude-code 样式）：人类可读，
   可 grepable、可复制，并且无论数据库大小如何，数据库都保持很小
   聊天。
3. **高性能** — O(1) 文件追加，覆盖每个热点的索引
   查询、整数倍、单写入器 WAL、热路径上没有 JSON 扫描。
4. **可扩展，无需迁移**，成本低廉（块词汇、JSONL 行
   类型、kv 命名空间、`config_json` 列），**带有迁移**，其中
结构（新实体），由 `PRAGMA user_version` 版本化。
5. **Plan/Goal 检查点是不可变的主机工件**，具有记录的路径，
   哈希值和大小；现有的批准行还带有执行字段。
   启动中断是进程纪元栅栏，并且不会重播任何工作。

## 2. 文件布局

```text
~/.pi-desktop/
 ├── pi.sqlite            # index database (WAL: + -wal/-shm) — host-core only
 ├── pi.sqlite.v6.bak     # archived pre-v7 database (D119 breaking reset)
 ├── pi.sqlite.v8.bak     # exact readable backup before v8→v11 destructive work
 ├── pi.sqlite.v9.bak     # exact readable backup before v9→v11 destructive work
 ├── pi.sqlite.v10.bak    # exact readable backup before v10→v11 destructive work
 ├── sessions/            # transcript file store (D119) — host-core only
 │    ├── <sessionId>.jsonl           # live transcript (header + messages)
 │    ├── <sessionId>.revisions.jsonl # regenerate branches, append-only
 │    └── <sessionId>.inflight.json   # streaming reply checkpoint (D299), transient
 ├── secrets/             # encrypted secret blobs + .machine-key (unchanged)
 ├── attachments/         # content-addressed blobs (sha256 name), refs from messages
 ├── plugins/             # code + data + registry.json (unchanged, spec 07-11)
 ├── logs/                # NDJSON app/<category>, host/<category>, agent/<category> logs
 ├── cache/               # disposable caches
 ├── review-changes/<sessionId>/<snapshotId>/
 │    ├── before          # bounded pre-tool bytes, when reversible
 │    └── meta.json       # path, hashes, diff state, and ownership
 └── scratch/<sessionId>/ # per-session agent temp files (D114), including
                          # composer pasted files under pasted/ — deleted
                          # with the session; startup sweep removes orphans
                          # and stale dirs
```

一个数据库文件保持跨实体写入事务性（例如会话+
一次提交中的转+工件）。数据库存储**没有大的有效负载**：消息
内容存在于 `sessions/` 中，附件和工具输出超出限制
[16-tool-result-limits](/zh-CN/spec/03-runtime/16-tool-result-limits) 存在于磁盘上，已引用
由 path/hash 提供。

### 2. 0 消息拥有的评论快照 (ADR 0043)

成功的工作区 `PRAGMA user_version`/Plan/Goal 工具结果携带有界
[03-工具和权限](/zh-CN/spec/03-runtime/03-tools-and-permissions) 中描述的 `details.review` 记录。
转录本 JSONL 是可见卡片的持久索引；上一个
字节和哈希位于工作区之外
`review-changes/<sessionId>/<snapshotId>/`。主机删除会话的
带有 `session.delete` 的快照目录并扫描其会话的目录
启动时不再存在。快照永远不会从 Git 推断出来，所以稍后
commit 不会删除历史审查证据。

### 2. 1 成绩单文件 (D119)

`sessions/<sessionId>.jsonl` — 第一行是会话标头，然后是一行
每条消息； `seq` 由行顺序隐含：

```jsonl
{"type":"session","schema":1,"sessionId":"0b0e…","createdAt":"2026-07-26T09:00:00.000Z"}
{"type":"message","id":"m1","role":"user","createdAt":"…","blocks":[{"type":"text","text":"…"}]}
{"type":"message","id":"m2","role":"tool","toolName":"Write","blocks":[{"type":"tool_call","callId":"c1","args":{},"result":{},"status":"success"}]}
{"type":"message","id":"m3","role":"assistant","createdAt":"…","blocks":[{"type":"thinking","text":"…"},{"type":"text","text":"…"}],"meta":{"usage":{},"modelId":"…"}}
{"type":"compaction","id":"cp1","summary":"…","firstKeptMessageId":"m2","throughMessageId":"m3","tokensBefore":917000,"retainedTail":[…],"providerId":"…","modelId":"…","createdAt":"…"}
```

`sessions/<sessionId>.inflight.json` — 会话中正在流式输出的助手回复，是一个
`{ schema, sessionId, turnId, savedAt, message }` 对象，host-core 在每次
`session.saveInflightMessage` 时原子替换（临时文件 + 重命名）（D299）。当
`message_update` 事件携带可见文本时，Electron 主进程至多每 1.5 秒发送一次检查点，
因此回复中途退出或崩溃最多丢失最后一个间隔的输出，而不是整条回复。该文件是临时的：
同一 id 的最终行的 `session.appendMessage` 会移除它，`completed`/`error` 的回合
结束会移除它，而启动扫描以及 sidecar 丢失时的回合结束（`recoverInflight`）会把
最终行从未落盘的残留检查点提升为该回合下的 `aborted` 助手消息写入转录。它从不追加、
从不被 sidecar 读取、也从不镜像进 SQLite；针对已被索引的 id 的迟到检查点会被丢弃。
子代理回复不做检查点。

`sessions/<sessionId>.revisions.jsonl` — 仅附加，每个存档一行
重新生成分支； *active* 标志仅存在于数据库索引中，因此切换
修订版永远不会重写此文件：

```jsonl
{"type":"revision","rootUserId":"u1","revisionIndex":1,"createdAt":"…","messages":[…message records…],"turns":{"<messageId>":"<turnId>"}}
```

规则：

- `blocks` 是规范的块词汇表 (§4.7) — 不是 UiMessage
  投影。 `meta` 是解析后的元数据对象（usage/modelId/
  提供商 ID / 状态 / 错误 / 修订字段）。
- 文件中的时间戳是 RFC3339 有线拼写（可读性）；数据库索引
  保持整数毫秒。
- 读者跳过未知的 `type` 行和撕裂的尾行：新的行类型
  不需要迁移，并且附加过程中的崩溃不会毒害文件。
- `compaction` 是一个模型上下文检查点，而不是一条消息 — 但它是
  呈现为分隔行而不是聊天气泡 (D203)。读者归来
  每条消息均保持不变并单独返回 **every** 仍然有效
  检查点，最早的在前；最新的是活跃的，整个链是
  转录本从什么中提取行，因此检查点比
  产生它的压实。 `throughMessageId` 锚点编号为 1 的记录
  读取和分叉时，每条记录的较长存在时间都会被删除。
  `throughMessageId` 是持久转录本边界；
  `firstKeptMessageId` 和 `retainedTail` 重现摘要+适用的
  重启后的上下文。活动回合的 `retainedTail` 最多保存最新的用户消息；
  已完成回合的检查点尾部为空。`details.retainedTailMode`（`active_turn` 或
  `completed_turn`）持久化该边界；没有该字段的旧记录归一化为最新的用户消息。
  活动消息超过保留限制时，将以标记、截断的形式存储；UI/diagnostics 的原始消息行
  保持完整和权威。
  自动压缩失败可能会存储`details.fallback = "retained_tail"`
  以及简短的恢复摘要，而不是法学硕士生成的摘要；完整的
  成绩单仍然具有权威性，后备尾部只是模型上下文
恢复视图。 `details` 还携带检查点生成和
  压缩族，两者对主机都是不透明的。
- 写入者使用flush + fsync追加（消息持久性≈WAL
  `synchronous=NORMAL`);完整的成绩单重写（regenerate/edit，修订
  切换、导入）执行同级临时文件 + 原子重命名。一个正常的
  上下文检查点是一个附加行，并且永远不会重写可见消息。
  重写会延续每个仍然有效的检查点
  重写的消息，而不仅仅是最新的消息。
- 排序：文件在数据库索引事务**之前**写入。一场车祸
  两者之间的成本是一个派生索引行（从不满足）和下一个
  完全重写自我修复；转录读取重复数据删除重复消息 ID
  保持最后。
- 成绩单文件是用户数据：仅在删除其会话时删除，
  绝不会被年龄或孤儿横扫（与 `scratch/` 不同）。

## 3. 连接引导

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;      -- durable enough under WAL; app-crash safe
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16000;       -- 16 MB page cache
PRAGMA trusted_schema = ON;       -- required by the FTS triggers (§4.8); the DB
                                  -- is app-owned at a fixed path, never an
                                  -- untrusted input, so schema trust is safe
PRAGMA auto_vacuum = INCREMENTAL; -- set at creation, before any table
```

- 架构版本位于 `PRAGMA user_version` (v11 = `11`) 中。 v1 `meta`
  桌子不见了。
- host-core 是**单一作者**；语句使用 `prepare_cached`；每个
  多行写入在一个事务中运行。
- 启动维护在 RPC 服务之前运行：一个事务标记每个
  `plan_approvals` 行，其中 `status='pending'` 为 `interrupted` 以及每一行
  将 `execution_state IN ('queued', 'running')` 设为 `interrupted`；它也
  中止正在运行的轮次并附加恢复审核记录。无进程纪元
已连载。已批准的 queued/running Plan/Goal 中断离开
`sessions.mode = 'agent'`。然后交易就进入正常状态
  `PRAGMA incremental_vacuum` 和审计保留修剪 (§9)。

## 4. 架构

### 4. 1 kv — 命名空间配置

替换 v1 `settings` + `meta`，并托管插件设置（规范 07-11 §5）。

```sql
CREATE TABLE kv (
  ns         TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;
```

| 纳秒 | 内容 |
|---|---|
| `app` | 设置 blob (`settings.get/set`)、`currentProjectId` |
| `ui` | 渲染器要求主机保留的非关键 UI 状态 |
| `cache` | 模型刷新标记，最近的模型参考（规范 13 §3） |
| `plugin:<id>` | 每个插件的设置；卸载=`DELETE WHERE ns = ?` |

新的配置域（例如 MCP 服务器）作为命名空间启动；他们毕业到
仅当表需要关系或索引时才使用它们。

#### Renderer 侧边栏首选项 (D093)

侧边栏组织是非权威的呈现状态存储
渲染器 localStorage 键下的尽力而为
`pi.desktop.sidebarPreferences`：

```ts
type SidebarPreferences = {
  sessionMeta: Record<string, {
    pinned?: boolean;
    archived?: boolean;
    order?: number; // compatibility/future manual order
  }>;
  projectMeta: Record<string, {
    pinned?: boolean;
    archived?: boolean;
    collapsed?: boolean;
    order?: number; // compatibility/future manual order
  }>;
  projectSort: "recent" | "created" | "oldest" | "name" | "manual";
  sessionView: {
    sort: "recent" | "created" | "oldest" | "name" | "manual";
    archived: boolean;
  };
  openProjectPaths: string[];
};
```

- 项目密钥和保留路径使用规范化的完整路径；会话密钥使用
  持久会话 ID。 Duplicate/slash-variant 路径在加载时被丢弃。
- `sessions.mode = 'agent'`/`PRAGMA incremental_vacuum` 是兼容性字段。该基线没有暴露
  drag/manual-reorder交互；没有可用顺序的值回落为
  近期订单稳定。
- 缺失、格式错误或不可写的首选项回退到空元数据，
  `recent`，存档隐藏，以及主机选择的项目。偏好失败
  永远不会阻止主机操作。
- 记录从不包含转录内容、工具参数、提供商
  配置或秘密。清除它仅更改显示。
- `openProjectPaths` 保留侧边栏选项卡。选定的工作空间仍然存在
  主机拥有的 `kv(app, currentProjectId)` 并通过以下方式恢复
  `workspace.get`；渲染器不会保留竞争的活动路径。

### 4. 2 项目——工作发生的地方

替换 v1 `workspace` 单例。提供设置项目存档索引
(D066/D133)、侧边栏按项目分组（基准§3.8）以及未来的每个项目
默认值。

```sql
CREATE TABLE projects (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
```

- 每当打开工作区、会话时，行都会按路径自动插入
  使用项目路径或导入引用创建。
- 项目路径被修剪，分隔符标准化为 `/`，并且尾随
  在唯一路径更新插入之前删除分隔符。因此进口
  为每个不同的路径实现一个持久的逻辑项目目录。
- `projects.list` 是项目存档索引的真实来源。 Renderer
  首选项可能会从默认侧边栏隐藏已存档的项目，但不能
  删除或隐藏其持久的项目索引行。
- 项目行是逻辑索引条目。导入永远不会创建操作
  系统目录：历史路径可能丢失、远程或只读。
- *当前*可见工作空间是 `kv(app, currentProjectId)` — 无单例
  表，没有部分唯一标志。保留的选项卡不会添加更多当前项目
  字段。

### 4. 3 提供商

与v1作用相同； `headers_json` + `compatibility_json` 合二为一
可扩展的 `config_json`（形状符合 [12-provider-config-schema](/zh-CN/spec/03-runtime/12-provider-config-schema)）。

```sql
CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  vendor_key       TEXT NOT NULL DEFAULT 'custom',
  type             TEXT NOT NULL DEFAULT 'openai_compatible',
  protocol         TEXT NOT NULL DEFAULT 'openai_compatible',
  api_style        TEXT,
  auth_kind        TEXT NOT NULL DEFAULT 'api_key_and_base_url',
  base_url         TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  secret_ref       TEXT,
  default_model_id TEXT,
  config_json      TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
```

### 4. 4 模型 — 目录缓存

实现 [13 模型目录和选择](/zh-CN/spec/03-runtime/13-model-catalog-and-selection)
（v1 已死，`provider_models` 从未死过）。

```sql
CREATE TABLE models (
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'user',  -- bundled | discovered | user
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  context_window    INTEGER,
  max_output_tokens INTEGER,
  deprecated        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) WITHOUT ROWID;
```

刷新（规范 13 §6/§9）更新插入 `discovered` 行并且**从不覆盖
`source='user'`** 行。最新模型的 MRU 保留在 `kv(cache)` — 这是一个
有界显示列表，而不是关系数据。

### 4. 5 节课

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  provider_id TEXT,                            -- loose ref, see below
  model_id    TEXT,
  mode        TEXT NOT NULL DEFAULT 'agent',   -- plan | agent
  thinking_level TEXT NOT NULL DEFAULT 'off'
                CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium',
                                          'high', 'xhigh', 'max')),
  permission_mode TEXT NOT NULL DEFAULT 'inherit' -- D115: inherit follows settings
                CHECK (permission_mode IN ('inherit', 'ask', 'accept-edits', 'auto')),
  source      TEXT,                            -- import origin: claude-code | codex | opencode | pi
  pinned      INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL DEFAULT 0,      -- message ordinal allocator
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
```

- `source='user'`/`kv(cache)` 是**松散引用**（无 FK），就像 `turns` 一样：
  根据规范 13 选择 `(providerId, modelId)`，始终带有自定义 ID
  允许，并且内置运行时（例如 `pi`）永远不会存在于 `providers` 中。
- `thinking_level` 是持久会话选择器。新的和 v2 迁移的
  会话默认为 `off`；能力分辨率可能会限制有效
  请求而不重写存储的首选项。

- `project_id` 规范化 v1 的自由文本 `project_path`（分组、徽章、
  将hover-`+` new-session-in-project全部变为索引查找）。
- 导入将每个非空标准化 `projectPath` 绑定到 `project_id`；
  无路径导入仍为 `NULL`。重新导入确定性会话 ID
  既不创建另一个会话，也不创建另一个项目行。
- 保留模式 `pinned` 列用于项目索引排序和
  迁移兼容性。 D093 侧边栏 pin/archive/collapse 状态为
  渲染器首选项覆盖，不需要架构迁移。否
  `status` 列：实时 running/waiting 状态是运行时真相，不持久
  真相；徽章数据来自最新的 `turns` 行 (§4.6) 以及内存中
  状态。
- `source` + 确定性导入 id 保持重新导入幂等性并让
  UI 徽章导入会话。
- `project_id` 也是该会话的工具根权限。切换
  可见工作区无法重定向正在进行或稍后的工具调用
到另一个会话。
- 分叉会话将其当前活动记录复制到新会话中
  行，同时保留精确的 `project_id`、provider/model、模式、思维、
  和权限配置。未存储 parent/child 列：结果
  是一个独立的会话，不是持久的导航树。
- `mode` 是权威的操作模式。 `plan` 和 `goal` 表示相同的 pi
  Agent 正在谈判此类合同；双方都没有选择另一个
  运行时。实时 `pending` 行
  在 `plan_approvals` 项目 `awaiting_approval` 中； `execution_state` 值
  `project_id`/provider/model 项目审批后执行。否则为 Plan 或 Goal
  会话为 `planning` 时
  Agent 处于活动状态或准备就绪。该行的 `kind` 可以区分两者，因为
  预测状态是共享的。终端审批行已成为历史
  持久记录，而不是渲染器门；拒绝、过期或待中断
  将实时计划返回到可编辑状态。渲染器可能会保留最新的
  proposal/execution 每个会话的快照仅适用于其当前生命周期
  现场主持活动； `plans.pending` 仅重新水化挂起的行。
- 新会话默认为 `agent`。导入的旧 `chat` 值已标准化
  至 `plan`；分叉会话复制持久模式，但从不复制挂起模式，
  已排队或正在运行批准行。
- 消息范围的分叉仅复制所选内容的规范前缀
  消息。 Assistant Edit 使用该子项并记录 original/edited
  子级现有 `message_revisions` 存储中的响应尾部；来源
  抄本和源版本的修订永远不会被重写。

### 4. 6 圈 — 每个代理运行一行

[10-session-state-machine](/zh-CN/spec/03-runtime/10-session-state-machine) 的持久性一半
（旧逻辑模型中的 `turn_runs`）以及 usage/cost 的汇总点。

```sql
CREATE TABLE turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'running', -- running | completed | aborted | error
  provider_id   TEXT,                            -- snapshot at run time, no FK
  model_id      TEXT,                            -- snapshot at run time
  error_code    TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usage_json    TEXT,                            -- full provider usage (cached breakdown, …)
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX idx_turns_session ON turns(session_id, started_at DESC);
```

### 4. 6a plan_approvals — 不可变的检查点和执行字段（模式 v11）

主机将每个提交的 Markdown 快照写入到一个新的唯一文件中
提案类型的目录：`<workspaceRoot>/.pi/plan/` 用于计划和
`<workspaceRoot>/.pi/goal/` 实现目标。现有 `plan_approvals` 行存储
种类、结构化 title/question、工件元数据和批准后
执行描述符。文件路径是相对于会话工作空间的
始终采用 `.pi/<kind>/<unique-name>.md` 形式。一张桌子提供两种服务
(D198)，所以单待批准不变量、执行队列和每个
索引是共享的而不是重复的。

```sql
CREATE TABLE plan_approvals (
  request_id               TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id                  TEXT NOT NULL,
  tool_call_id             TEXT NOT NULL UNIQUE,
  kind                     TEXT NOT NULL DEFAULT 'plan'
                             CHECK (kind IN ('plan', 'goal')),
  plan_json                TEXT NOT NULL, -- exact submitted Markdown snapshot
  title                    TEXT NOT NULL DEFAULT '',
  question                 TEXT NOT NULL DEFAULT '',
  status                   TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'changes_requested', 'rejected',
    'expired', 'interrupted'
  )),
  action                   TEXT CHECK (action IN ('approve', 'request_changes', 'reject')),
  target_permission_mode  TEXT CHECK (target_permission_mode IN ('ask', 'accept-edits', 'auto')),
  feedback                 TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  expires_at               INTEGER,
  resolved_at              INTEGER,
  error_code               TEXT,
  artifact_relative_path   TEXT,
  artifact_sha256          TEXT,
  artifact_size_bytes      INTEGER,
  version                  INTEGER NOT NULL DEFAULT 1,
  execution_id             TEXT UNIQUE,
  execution_state          TEXT CHECK (execution_state IN (
    'queued', 'running', 'completed', 'interrupted'
  ))
);
CREATE INDEX idx_plan_approvals_session
  ON plan_approvals(session_id, created_at DESC);
CREATE INDEX idx_plan_approvals_pending
  ON plan_approvals(status, created_at DESC);
CREATE UNIQUE INDEX idx_plan_approvals_one_pending_session
  ON plan_approvals(session_id) WHERE status = 'pending';
CREATE INDEX idx_plan_approvals_execution_queue
  ON plan_approvals(execution_state, created_at DESC)
  WHERE execution_state IN ('queued', 'running');
CREATE INDEX idx_plan_approvals_execution_id
  ON plan_approvals(execution_id) WHERE execution_id IS NOT NULL;
```

`plan_json` 是为 approval/execution 保留的确切 Markdown 快照
记录；它不是规范的包装器。 `title` 和 `question` 是分开的
结构化字段。每个工件文件都是不可变且唯一的，因此稍后
Plan/Goal 又创建一个新的完整 snapshot/approval 行，并且永远不会替换
较早的文件。哈希值和字节大小在批准之前对文件进行身份验证，但是
审批UI可以简单地打开相对路径。

批准将 `status` 更改为 `approved`，设置 `execution_id` 并
`execution_state = 'queued'`，将 `sessions.mode` 更新为 `agent`，并存储
一笔交易中的显式许可模式。 Reject/expiry 离开
会话处于合约模式 — Plan 保持 Plan，Goal 保持 Goal — 并关闭
主动门；稍后的提示可以创建新的待处理行。新协议
没有请求更改操作；兼容性列保留用于旧记录。

启动时，在提供 RPC 之前，一个事务将每个 `pending` 行更改为
`interrupted` 和每个 `queued` 或 `running` 的执行状态为 `interrupted`。
相关的运行回合被中止。没有序列化的进程纪元
专栏并且没有重播。待处理的中断使会话保留在其合同中
模式，而已批准的 queued/running 中断则将其保留为 Agent。
Renderer 重新加载
在同一主机内可以列出挂起的行及其原始`expires_at`；
`plans.pending` 不返回任何终端行，因此被拒绝、过期、批准，
已完成且中断的卡片不会再水化。

服务：中间会话模型开关（“仅下一回合”，规范 13 §4），
每条消息成本芯片的会话汇总（基准§3.2），failed/aborted 徽章
（§3.8），并重试谱系。

### 4. 7 消息 — 文字记录索引

脚本本身是每个会话的 JSONL 文件（第 2.1 节）；这张表是它的
派生索引：每条消息一行携带排序、提升的过滤列，
以及提取的提供给 FTS 的纯文本。工具调用是
使用 `text = NULL` 进行流式传输（与今天一样）。

```sql
CREATE TABLE messages (
  mid          INTEGER PRIMARY KEY,             -- stable rowid: FTS anchor, VACUUM-safe
  id           TEXT NOT NULL UNIQUE,            -- caller-facing uuid (optimistic UI)
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id      TEXT REFERENCES turns(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL,                -- per-session ordinal
  role         TEXT NOT NULL,                   -- user | assistant | tool | system
  tool_name    TEXT,                            -- promoted for tool rows (filters, audit joins)
  is_error     INTEGER NOT NULL DEFAULT 0,
  text         TEXT,                            -- extracted plain text (search/preview); NULL for tool rows
  created_at   INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
```

**块词汇**（开放集——新类型不需要迁移；存储在
转录文件的 `blocks` 数组）：

```ts
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown;
      status: "ok" | "error" | "denied"; result?: unknown;
      completedAt?: string; durationMs?: number;
      toolUsage?: ToolTokenUsage }
  | { type: "attachment"; kind: "image" | "file"; name: string;
      ref: string /* attachments/<sha256> or absolute path */ };
```

- 工具结果存储**截断后**（16 个工具结果限制）；满
  原始输出不是存储问题。
- 辅助思维仅存储在文件内的 `thinking` 块中。的
  派生的 `text` 列包含最终答案文本，因此转录搜索和
  答案预览不会暴露或混合推理。
- 每个响应 usage/model 元数据位于文件行的 `meta` 对象中；
  `turns` 保存可求和汇总 — 查询时没有 `json_each`。可选
  保留响应流持续时间和估计的工具令牌足迹
  与消息元数据一起使用，以便上下文检查器能够重新加载。
- 排序：`seq` 在索引事务内通过以下方式分配 O(1)
  `UPDATE sessions SET last_seq = last_seq + 1 … RETURNING last_seq`；的
  文件的行顺序是相同的顺序。 `UNIQUE(session_id, seq)` 双打
  作为索引扫描的覆盖索引；转录*内容*加载自
  文件，而不是这个表。
- 索引是派生状态：丢失一行（文件追加和文件之间崩溃
  索引提交）会降低对该消息的搜索，直到下一次完全重写，
  但永远不会丢失内容。
- `mid`（显式整数主键）在 `VACUUM` 上引脚 rowid，其中
  FTS 外部内容映射取决于； `id` 保留有线格式 uuid。

### 4. 7a 子代理归属（D201、ADR 0062）

子代理生成的行存储在相同的转录文件和相同的记录文件中
作为父级的索引；标记它们的是文件行 `meta` 中的两个字段
对象，当 sidecar 发送它们时由 host-core 写入：

```ts
meta.parentToolCallId?: string  // the `Task` call that spawned the delegate
meta.agentName?: string         // the definition name, e.g. "code-reviewer"
```

无列、无表、无迁移：属性是有关消息的元数据，并且
推广它会引起没人提出的疑问。

这两个字段都可以在重新加载后保存下来，这就是恢复会话嵌套的原因
就像现场一样（`04-ux/08-component-spec.md` §9.9）。两位消费者阅读了它们：

- 渲染器将属性行分组到其 `Task` 行下并渲染它们
  一级；回合流和小地图永远看不到它们。
- 会话运行时在重建模型时**排除**属性行
  恢复时的上下文。家长只看过代表的报告，即
  `Task` 工具结果并按原样存储；重播代表自己的
  rows 会歪曲对话并重新引入上下文成本
  委托的存在是为了避免。

保留和删除将它们视为普通行：已删除的会话将其
用它委托行，并使用它们所属的分支重新生成存档
到。

### 4. 8 messages_fts — 全文搜索

跨记录的全局搜索（WorkBuddy-基准搜索、命令
调色板）。 Trigram 分词器涵盖 CJK 和子字符串匹配；查询更短
超过 3 个字符在 `messages.text` 上回退到 `LIKE`。

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages', content_rowid='mid',
  tokenize='trigram'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.text IS NOT NULL
  BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.mid, new.text); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.text IS NOT NULL
  BEGIN INSERT INTO messages_fts(messages_fts, rowid, text)
        VALUES ('delete', old.mid, old.text); END;
CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
      SELECT 'delete', old.mid, old.text WHERE old.text IS NOT NULL;
    INSERT INTO messages_fts(rowid, text)
      SELECT new.mid, new.text WHERE new.text IS NOT NULL;
  END;
```

通过普通扫描搜索会话标题（会话编号在
数百；没有第二个 FTS 表）。索引维护使用触发器而不是
应用程序代码，以便**级联删除**（会话→消息）清理
也有索引；这就是为什么 `trusted_schema = ON` 是引导程序的一部分。数据定义语言
经过验证的端到端（insert/update/delete/cascade + CJK trigram match）
`sqlite3` 3.43+。

### 4. 9 message_revisions — 重新生成历史索引

归档丢弃的重新生成分支，以便用户可以分页以前的变体
而不将它们堆叠在实时转录中（D105/D109）。一排就是一排
以用户回合为根的线性分支；分支**有效负载**位于
仅附加 `sessions/<id>.revisions.jsonl` (§2.1)，由
`(rootUserId, revisionIndex)`。

```sql
CREATE TABLE message_revisions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_user_id    TEXT NOT NULL,            -- wire id of the root user message
  revision_index  INTEGER NOT NULL,         -- 1-based per (session, root)
  is_active       INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0, -- pager label, no payload parse
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, root_user_id, revision_index)
);
CREATE INDEX idx_message_revisions_root
  ON message_revisions(session_id, root_user_id, revision_index);
```

- 实时转录本仅保留活动分支（转录本文件+索引）。
- 切换分页器条目从修订文件中读取分支，重写
  实时转录文件，重建索引行，并翻转 `is_active` —
  修订文件本身永远不会被重写。
- `session_id` 上的级联清除索引行；文件删除取决于会话
  删除。
- `root_user_id` 是稳定的重新生成系列密钥。实时重写用户
  提示可能会携带新消息 `id`，但 `meta.revisionRootId` 会保留
  指向原始系列，以便稍后重新生成附加到一组。
- Root 用户 `meta` 还存储 `revisionCount` / `activeRevision`
  成绩单寻呼机；这些字段是表示元数据，而不是第二源
  分支有效负载的真实性。
- 完成一回合的分支由 `session.saveActiveRevision` 存档，
  它读取转录本，附加修订行，并标记根的
  一次主机调用内的寻呼机元数据。标记仅重写根自己的标记
  转录行，并且文件在写入时被重新读取，因此助手或
  同时持久性发件箱附加的工具行仍然存在。一个
  从主机锁之外拍摄的快照重写整个转录本将
  删除它（ADR 0060）。
- 分支在归档之后仍会继续生长：之后的提示都追加在它上面，而以错误结束的
  回合永远到不了 `agent_end`。因此每个会丢弃实时分支的操作都先把它写回
  所属的修订（D307）：`session.activateRevision` 在切换前从持久转录本重新
  归档该系列的实时分支；重新生成路径向 `session.saveRevision` 传入
  `revisionIndex` 刷新被标记的变体；`session.saveActiveRevision` 对已归档
  的索引做刷新而不是跳过。刷新只是在追加式文件里多写一行（同一
  `(rootUserId, revisionIndex)` 以最后一条为准）并更新 `message_count`。
  被刷新的是实时根消息 `activeRevision` 标记所指的变体；已标记但还没有
  索引行的变体（其回合在归档前失败）作为新变体单独存储，绝不覆盖之前的
  变体。

### 4. 10 工件 — 会话生成的文件

支持工件表面（基准§3.7）。 v1 计划从中得出这个
`audit_log`，但审计有效负载从未记录文件路径；明确的
预测是精确的、有索引的，并且能够经受审计修剪。

```sql
CREATE TABLE artifacts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,               -- absolute, workspace-resolved
  op         TEXT NOT NULL,               -- write | edit | delete
  turn_id    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;
CREATE INDEX idx_artifacts_time ON artifacts(updated_at DESC);
```

由 host-core 在与 `tool_execute` 审计行相同的事务中更新插入
每当 Write/Edit（或声明文件效果的插件工具）成功时 -
重复编辑更新 Write/Edit/`op`，每个会话每个文件保留一行。
写入会话暂存目录 (D114) 被排除：工件列表
仅工作区可交付成果。

### 4. 11 Scheduled_tasks + task_runs — 自动化

将计划任务移出 Electron 的 `scheduled-tasks.json`（D002 修复）并
添加自动化页面所需的运行历史记录（定时任务/运行记录选项卡）。

```sql
CREATE TABLE scheduled_tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  cadence     TEXT NOT NULL DEFAULT 'manual',  -- manual | hourly | daily | weekly
  enabled     INTEGER NOT NULL DEFAULT 1,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',      -- mode, cron expr, model override, notify policy
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE task_runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, -- the run's transcript
  status     TEXT NOT NULL DEFAULT 'running',  -- running | completed | aborted | error
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX idx_task_runs ON task_runs(task_id, started_at DESC);
```

生成会话的运行通过 `session_id` 免费获取其转录本。
更精细的计划 (cron) 无需迁移即可登陆 `config_json`。

计划任务 `config_json.mode` 是持久操作模式值。有
故意没有物理 `scheduled_tasks.mode` 列。 v7→v8
v9/v10→v11 迁移路径将旧版 `chat` 值映射到 `plan`；新预定的
任务默认为 `agent`，并且 create/update/import 标准化相同的值。
顶级线 `ScheduledTask.mode` 只是该线的标准化投影
JSON 值。
模式为合同模式（Plan 或 Goal）的计划或无人值守运行是
在提供商工作、`.pi/<kind>/*.md` 创建、批准之前明确拒绝，
或使用 `PLAN_REQUIRES_INTERACTIVE_SESSION` 进行队列插入 — 一个共享代码
对于这两种。它无法显示批准卡或自动批准提案
背景。用户必须先将 task/session 显式切换为 Agent
可以执行无人值守的运行。

### 4. 12 Secrets_meta

存在秘密的注册表（blob 文件以 sha256 命名，否则
不可数）。 `owner_kind/owner_id` 将 v1 的仅提供商列概括为
未来的 plugin/MCP 秘密。

```sql
CREATE TABLE secrets_meta (
  secret_ref TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL DEFAULT 'provider',
  owner_id   TEXT,
  kind       TEXT NOT NULL DEFAULT 'api_key',
  backend    TEXT NOT NULL,                -- safe_storage | file_fallback
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

秘密*值*永远不会进入数据库（D028/D031）：操作系统安全存储主，
`secrets/` 下的 AES-GCM 文件回退。

### 4. 13 审计日志

仅追加；现在已编入索引并可修剪。整数自动增量 PK 取代 v1 的
随机 uuid（更便宜的插入，自然顺序）。

```sql
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,              -- tool_execute | tool_denied | …
  session_id   TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_session ON audit_log(session_id, ts)
  WHERE session_id IS NOT NULL;
```

### 4. 14 通知 — 持久本地收件箱 (D117)

一行记录了一个终端代理轮转结果，该结果在
当前聊天的焦点。它仅存储结构化源数据；渲染器和
Electron 在表示边界处派生本地化的 title/body 字符串。

```sql
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('task.completed', 'task.failed')),
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_title TEXT NOT NULL,              -- snapshot at terminal transition
  turn_id       TEXT NOT NULL UNIQUE,       -- exactly one inbox row per turn
  error_code    TEXT,                       -- populated for task.failed when known
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
CREATE INDEX idx_notifications_created
  ON notifications(created_at DESC);
CREATE INDEX idx_notifications_unread
  ON notifications(created_at DESC) WHERE read_at IS NULL;
```

- `session.endTurn` 始终更新回合，并且当 `createNotification` 为
  true，为 `completed` 插入 `task.completed` 或为 `error` 插入 `task.failed`
  在**同一笔交易**中。仅当主窗口时 Electron 才会传递 false
  是 visible/focused 并且该确切会话是当前聊天。 `aborted`
  从不插入行。
- 重复终端更新无法复制通知，因为
  `turn_id` 是独一无二的。仅当此调用时，RPC 结果才包含记录
  插入它；否则，`notification` 字段将被省略。
- `session_title` 是通知创建时的稳定会话名称快照，
  不是本地化通知 title/body。空标题仍然有效，并且
  仅在演示时接收本地化的“无标题任务”回退。
- 不存储 title/body 散文。权限请求、预定提醒、
  插件通知和中止的回合不是通知源。
- 插入后，同一事务将除最新的 200 行之外的所有行删减
`(created_at DESC, id DESC)`。这是全球上限；会话删除也
  级联其行。
- 标记读取更新是幂等的（`read_at` 仅从 null 更改），标记所有
  read 是一项索引更新，而clear 仅删除通知行。没有一个
  这些操作会更改会话、回合或记录。

### 从 v1 中删除

| v1表 | v2首页 |
|---|---|
| `meta` | `PRAGMA user_version` |
| `settings` | `kv(ns='app')` |
| `workspace`（单例） | `projects` + `kv(app, currentProjectId)` |
| `plugins`（死代码） | `plugins/registry.json` 保持权威（规范 07-11）；插件 *设置* → `kv(ns='plugin:<id>')` |
| `provider_models`（死代码） | `models` |

## 5. 写入路径（一致性）

持久化点遵循 [10-session-state-machine](/zh-CN/spec/03-runtime/10-session-state-machine) §4；
流增量永远不会接触存储。消息写入是固定的两个步骤
顺序 — **首先是转录文件，其次是索引交易** (§2.1)：文件
是真理之源，索引衍生且自愈。

| 事件 | 文件步骤 | index/DB 交易 |
|---|---|---|
| 接受提示 | 附加用户消息行 | `last_seq` 分配（返回）+索引行+触摸 `sessions.updated_at`；然后插入 `turns(running)` |
| assistant/tool 消息结束 | 附加消息行；id 匹配时移除进行中检查点 | 索引行+触摸会话 |
| 流式回复检查点（`session.saveInflightMessage`，D299） | 原子替换 `<id>.inflight.json`；空消息或已索引的 id 为空操作 | — |
| 上下文检查点（`session.appendCompaction`） | 在其引用的消息边界之后附加类型化检查点行 | —（检查点是不可搜索的成绩单内容） |
| 工具成功（Write/Edit） | — | upsert `artifacts` + `audit_log` 行，与结果持久化相同的 tx |
| 通过 `session.endTurn` 打开终端 | `completed`/`error`：移除进行中检查点；`recoverInflight`：当最终行从未落盘时把检查点作为 `aborted` 消息行追加 | 更新 `turns`；对于 completed/error，在同一交易中插入一个通知并修剪至 200 个；中止插入 无；被提升的检查点在该回合下获得一个索引行 |
| plan/goal 提交 | 主机将准确的 Markdown 字节写入新的唯一 `<workspaceRoot>/.pi/<kind>/*.md` 文件 | 在发出批准请求之前插入一个 `plan_approvals(pending)` 行，其中包含类型、结构化 title/question、工件 path/hash/size 和到期时间 |
| plan/goal 批准 | 验证不可变工件 path/hash/size | 原子地解析 `plan_approvals`，更新 `sessions.mode` 和显式 `permission_mode`，并设置 `execution_state = 'queued'`； reject/expiry 保持合约模式 |
| 转录本截断/编辑/无应答智能停止 (`session.replaceMessages`) | 原子记录重写（临时+重命名）；只保留边界仍然存在的检查点 | single tx：删除索引行，批量重新插入携带每个幸存消息所属的 `turn_id`，重置 `last_seq`； smart Stop 仅将其结构化输入框快照保留在渲染器内存中 |
| 会话分叉 (`session.fork`) | 使用重新映射的 message/tool-call id 编写新的转录本； copy/remap 仅当包含其边界时才为检查点 | single tx：克隆会话配置，插入子索引行，设置`last_seq`；失败时删除子文件 |
| 重新生成分支保存 | 追加修订行（带 `revisionIndex` 时为该已有变体的刷新行） | 带有 `message_count` 的索引行（+ `is_active` 翻转）；刷新只更新 `message_count` |
| 回合完成分支存档 (`session.saveActiveRevision`) | 附加修订行（活动变体已归档时为刷新行），然后仅重写寻呼机标记的根用户的转录行 | 带有 `message_count` 的索引行（+ `is_active` 翻转）；其他消息的索引行未受影响 |
| 修订版开关 | 先为实时分支自身的变体追加刷新行，读取目标分支，原子转录重写并保留锚点仍存在的检查点 | 翻转 `is_active`，重建索引行并带上每条幸存消息所属的 `turn_id`，重置 `last_seq` |
| 进口 | 写入成绩单文件 | 每个会话一笔交易：会话行 + 索引行；失败时文件将被删除 |
| 会话删除 | 行删除后删除两个会话文件 | `DELETE FROM sessions`（级联） |

规则：回合开始前用户消息持久（fsync'd 文件行）；
assistant/tool 行在其结束事件时持久化；正在流式的助手回复另外至多每 1.5 秒
做一次检查点（D299），因此回合中途退出或崩溃最多丢失进行中回复的最后一个检查点
间隔，加上仍在运行的工具行。启动扫描把该回合标记为 `aborted`，并把残留的检查点
提升为该回合的 `aborted` 助手行写入转录；用户停止不动检查点，因为运行时自己的
中止最终行仍在路上，到达时会移除它。渲染器侧的停止绝不重写已有已开始回复的转录
（规格 01 §5.3）；它唯一的重写是撤销未应答提示，且从完整持久转录与实时行的合并
结果计算。
只有在追加成功后，检查点才会安装到实时运行时中；
因此 failed/crashed 检查点写入会留下先前的完整上下文或
先前的检查点具有权威性，而不是创建仅内存状态。
文件追加和索引提交之间的崩溃使消息可读
（从文件加载脚本）只有其搜索行丢失，直到
下一步重写；转录读取重复数据删除重复的 id keep-last。

## 6. 性能说明

- 单写入者+WAL：读者永远不会阻塞；设计上没有锁争用。
- 所有时间戳 INTEGER Unix ms — 较小的行、整数比较、索引友好。
- 热门查询及其索引：
- 转录本加载 → `sessions/<id>.jsonl` 的一次连续读取（无 DB）
  - 会话列表 → `idx_sessions_updated`
  - 按项目分组 → `idx_sessions_project`
  - badges/cost 汇总 → `idx_turns_session`（每个会话的最新回合）
  - 按会话分类的工件 → PK；全球最近的工件 → `idx_artifacts_time`
  - 运行历史记录 → `idx_task_runs`
  - 审核 forensics/pruning → `idx_audit_session` / `idx_audit_ts`
  - 通知收件箱 → `idx_notifications_created`；未读 filter/count →
    `idx_notifications_unread`
- O(1) `seq` 分配；任何地方都没有 `MAX()+1` 扫描。
- 所有语句上的 `prepare_cached`；批量插入到一个 tx 中（导入，
  更换）。
- JSON 列在热路径上盲读（按原样发送到渲染器）；
  任何过滤或求和的内容都是按规则提升的列。

## 7. 版本控制、v7 重置和 v8 到 v11 Plan/Goal 迁移

- `PRAGMA user_version` 保留模式权限；未来的结构性变化
  再次添加有序的 Rust 迁移 fns，每个都在一个事务中，并带有一个
  `pi.sqlite.v<n>.bak` 在破坏性步骤之前进行复制。
- **v7 是一个中断重置 (D119)，而不是迁移。** 使用以下命令打开数据库
  `user_version` 1–6 WAL 检查点，将其重命名为 `pi.sqlite.v6.bak`
  （删除过时的 `sessions/<id>.jsonl`/`idx_sessions_updated` 同级文件），并引导一个新的 v7 文件。
  旧文件中的会话、提供程序和设置不会保留；
  存档仍保留以供手动恢复。所有 v7 之前的迁移代码
  （v1 `settings.sqlite` 导入，v2→v6 链）被删除。
- 全新安装直接运行完整的 v11 DDL。
- **架构 v7 首先到达 v8，然后使用受保护的路径。** v7→v8
  迁移之后是相同的受保护的 v8→v11 迁移；架构-v9 和
  schema-v10 数据库采用相同的受保护路径并接收精确的可读数据
  破坏性工作之前的 `pi.sqlite.v9.bak` / `pi.sqlite.v10.bak`。
- **v8-to-v11 是就地事务迁移。** 在迁移之前，
  host-core 检查 WAL，然后创建精确的可读文件
  `pi.sqlite.v8.bak`；两者都发生在破坏性工作之前。一个原子内
  交易它：
  1. 验证每个 `sessions.mode` 值并将 `chat` 映射到 `plan`；
  2. 解析结构化应用程序设置值并映射其顶层
     `defaultMode: "chat"` 至 `"plan"`；
  3.解析每个定时任务的`config_json`并映射其顶层存储
     `mode: "chat"` 到 `"plan"`，保持嵌套扩展模式不变；
  4. preserves/migrates 现有 `plan_approvals` 表并添加其
     工件和执行 fields/indexes；
  5. 保留成绩单、轮次、修订、项目、许可、赠款、
     提供商和计划任务历史记录；
  6. 将所有新模式值验证为 `plan | goal | agent`；和
  7. 验证 `defaultCommandShell` 作为已知的当前平台目录 ID，
     保留暂时不可用的有效ID以便正常运行
     Fallback可以选择第一个可用的shell；和
  8.添加`plan_approvals.kind`（`NOT NULL DEFAULT 'plan'`，对照
     `plan | goal`) 当该列不存在时，探测 `pragma_table_info`
首先是一个已经从当前 DDL 创建表的 v8 数据库
     没有被改变两次；根据定义，现有行是 Plan 合约，其中
     正是列默认值；和
  9. 仅在每次更改成功后才设置 `PRAGMA user_version = 11`。
  格式错误的应用程序设置值、格式错误的计划任务 `config_json`、
  会话或顶级计划模式无效、平台未知或错误
  `defaultCommandShell`、解析、约束或写入失败关闭失败，
  回滚事务，并保留迁移前架构
  权威；备份
  仍然可以恢复。
  旧版 `planApprovalPermissionMode` 已从应用设置 JSON 中删除
  迁移期间；所有不相关的设置保持不变。

`largePasteThreshold` 是应用设置 JSON 中的新增字段，而不是数据库 schema 字段。
主机读取设置时会将缺失、格式错误或超出范围的值规范化为 600，设置写入则验证
1–1,000,000 的整数范围。因此现有数据库会在读取时延迟获得默认值，不需要破坏性
迁移或第二个设置存储。
- Plan 和 Goal 工件永远不会根据转录内容重建。开
  启动,
  一笔交易标志着每笔 `pending` 批准和每笔 `queued` 或
  `running` `plan_approvals` 中的执行状态为 `interrupted`；关联的
  在 RPC 服务开始之前，运行回合标记为 `aborted`。待定
  会话仍处于合同模式并且已批准 queued/running
  会话仍为 Agent。之前没有批准回复或执行
  接受重新启动。
- 转录文件格式在会话中携带自己的 `schema` 字段
  标题行；未知的行类型会被跳过，因此文件格式会增加
  无需重置。

## 8. 保留和维护

-audit_log：在启动时修剪超过 90 天（可配置）的行；
  之后是 `incremental_vacuum`。
- task_runs：保留每个任务的最后 100 个（使用相同的引导通道进行修剪）。
- 通知：在每次插入后强制执行最新的 200 个全局上限
  引导作为防御性修复；否则，行将在重新启动后继续存在，直到清除，
  与会话一起修剪或级联删除。
- 转录文件：用户数据，从未修剪或清除 - 仅删除
  他们的会话（删除或计划运行的清理）。孤立文件（会话行
  消失，文件存在）被保留，而不是被垃圾收集：该文件是
  事实来源和未来的重新索引可以恢复它。
- 日志在文件层轮转（D082）；会话永远不会自动删除。
- 附件 GC（稍后）：扫描 `attachments/` 中未被任何引用的哈希值
  转录文件。

## 9. 可扩展性手册

| 需要 | 机制 | 迁移？ |
|---|---|---|
| 新的消息内容类型（引用、差异、语音） | 转录文件中的新块 `type` | 不 |
| 新的每个响应元数据 | 消息行中的 `meta` 键 | 不 |
| 新转录系类型 | 新的 JSONL `type`（读者跳过未知） | 不 |
| 新的配置域（MCP 服务器、内存） | `kv` 命名空间 | 不 |
| 新 provider/task 旋钮 | `config_json` 密钥 | 不 |
| 新模型能力 | `capabilities_json` 中的值 | 不 |
| 新 queryable/filterable 字段 | 晋升专栏 | 是（附加） |
| 具有关系的新实体（知识库、连接器） | 新表 | 是的 |

经验法则：files/JSON 适用于主机仅存储和发送的有效负载；
主机过滤、连接、求和或索引的任何内容的列。

## 10. 秘密规则（不变）

1.渲染器从不保守秘密
2. 操作系统 safeStorage 主；带有风险警告的显式加密文件后备
3. SQLite 中不存在秘密值；仅 `secrets_meta` 记账
4. 导出的会话默认排除机密

## 11. 验收

1. 会话和转录本以相同的字节方式重新启动（块、用法、
   工具结果） — 内容从 `sessions/<id>.jsonl` 重新加载，没有
UI投影损失
2. 5k 消息会话的转录加载是一个连续的文件读取；不
   热路径上的消息内容 SQL
3.在运行回合中杀死-9：启动标记回合`aborted`，转录
   直到最后一个 fsync 消息行都完好无损；撕裂的尾线是
   读取时跳过
4. 在文件追加和索引提交之间杀死-9：消息仍然呈现
   重启后；搜索只会错过它，直到下一次抄本重写为止
5. 打开 v7 之前的数据库将其存档为 `pi.sqlite.v6.bak` 并启动
   新鲜的 v7 文件；重新打开新文件就是简单的打开
6. 计划任务 CRUD + 运行历史记录仅通过主机 RPC 往返
7. FTS跨会话查找CJK和ASCII子串；删除会话
   删除其索引条目和两个会话文件
8. 插件卸载在一条语句中清除 `kv(plugin:<id>)`
9. 重置侧边栏首选项不会更改 `projects`、`sessions` 或
   成绩单数据；保留的路径和组织选择在正常情况下生存
   当首选项可用时渲染器重新启动
10. 会话 A 的工具调用会解析 A 的持久项目根，即使在
    可见工作区切换到项目 B
11.会话的思维水平在重新启动后仍然存在
12.辅助思维阻止往返，独立于最终答案文本；
    派生搜索文本排除思考内容
13. 重新生成的助手变体在重新启动后仍然有效
    `sessions/<id>.revisions.jsonl`；实时 root 用户会重新加载
`revisionCount` / `activeRevision`，寻呼机可以恢复任何存档
    分支，并且切换分支永远不会重写修订文件
14. 完成和失败的回合自动创建一个持久通知；
    重复的终端更新不会重复它，中止的轮次不会创建任何内容，
    最新的 200 上限在重启后仍然存在
15.通知list/unread、标记已读、标记所有读、清除和会话
    级联删除使用记录的 indexes/transactions 而不进行更改
    转动或转录数据
16. Schema v7 首先到达 v8，然后使用受保护的 v8→v11 路径。的
    v8→v11 迁移是一个带有 WAL 检查点和精确的原子事务
    在进行破坏性工作之前可读 `pi.sqlite.v8.bak`；架构 v9 和 v10
    接收 `pi.sqlite.v9.bak` / `pi.sqlite.v10.bak`。持续会话，
    应用程序默认值和预定的 `chat`
    值映射到 `plan`、sessions/transcripts 和 `plan_approvals` 工件/
    执行字段保留，`plan_approvals.kind` 添加到现有行
    默认为 `plan`，并且应用程序 settings/scheduled 配置格式错误，
    无效的模式或无效的默认 shell 无法通过预迁移关闭
    模式完好无损
17. SubmitPlan 和 SubmitGoal 将精确的 Markdown 字节写入唯一的
    `.pi/plan/*.md` 或 `.pi/goal/*.md` 文件
    具有 SHA-256 和大小； title/question 保持结构化并重新加载渲染器
    仅保留待处理行和原始绝对截止日期
18.全流程重启标志着pending/queued/running审批行中断，
    中止关联的回合，不执行重播，将待处理的会话保留在其
合约模式，
    保留已批准的中断会话 Agent，并拒绝过时的响应
19. 计划的或无人值守的 Plan **或 Goal** 运行在 provider/artifact/ 之前失败
    使用 `PLAN_REQUIRES_INTERACTIVE_SESSION` 进行队列工作；无背景路径
    自动批准任一类型
