# 21. 持久记忆存储

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/21-memory-store) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 1. 范围

宿主持有的、寿命长于会话的持久记忆：Agent 或用户选择保留的事实、偏好、决定、坑与流程。此处规定存储、去重、取代与关键词召回；自动抽取与衰减属于后续阶段（§9）。

锚点为 [ADR 0371](../../../adr/0371-memory-store.md)。

## 2. 归属

| 关注点 | 归属 |
|---|---|
| 表、索引、FTS 索引 | Rust host-core（`crates/host-core/src/memory.rs`） |
| RPC 面 | `crates/host-core/src/rpc/memory_rpc.rs`（`memory.*`） |
| 向提示词注入模板 | `packages/agent-runtime`（阶段 2） |
| 列表 / 编辑 / 删除 UI | 渲染层，只经 RPC |

渲染层从不读 SQLite。Node 运行时从不直接写记忆行；它调用 `memory.*`。

## 3. 数据模型

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('global', 'project', 'session')),
  project_path  TEXT,
  session_id    TEXT,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'fact', 'preference', 'decision', 'pitfall', 'procedure')),
  title         TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 200 AND instr(title, char(0)) = 0),
  body          TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 8000 AND instr(body, char(0)) = 0),
  tags          TEXT NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL CHECK (source IN ('agent', 'user', 'import')),
  confidence    REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  content_hash  TEXT NOT NULL CHECK (length(content_hash) = 64),
  use_count     INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  valid_from    INTEGER NOT NULL,
  valid_until   INTEGER,
  superseded_by TEXT,
  CHECK ((scope = 'project') = (project_path IS NOT NULL)),
  CHECK ((scope = 'session') = (session_id IS NOT NULL))
);
```

索引：

| 索引 | 它服务的查询 |
|---|---|
| `idx_memories_dedupe (content_hash, scope, ifnull(project_path,''), ifnull(session_id,''))` UNIQUE | 去重查找 |
| `idx_memories_scope_created (scope, created_at DESC)` | 「该作用域内最近的记忆」 |
| `idx_memories_project_used (project_path, last_used_at DESC, created_at DESC)` | 按项目列出时的排序 |
| `idx_memories_session_created (session_id, created_at DESC)` | 会话面板 |
| `idx_memories_pinned (use_count DESC) WHERE pinned = 1` | 置顶注入 |
| `idx_memories_live (scope, created_at DESC) WHERE superseded_by IS NULL` | 只要未失效行时的列举 |

### 3.1 作用域

| scope | 要求 | 注入 / 召回到 |
|---|---|---|
| `global` | 既不需要路径也不需要会话 | 每个项目和会话 |
| `project` | `project_path` | 项目路径匹配的会话 |
| `session` | `session_id` | 仅该会话 |

这两条 `CHECK` 让不一致的行无法存在，因此 SQL 里的召回过滤不可能意外命中畸形行。

### 3.2 时间

`created_at` / `updated_at` = Agent 得知它的时刻。`valid_from` / `valid_until` / `superseded_by` = 该事实被认为成立的时间。一次更正调用 `supersede_memory(old, new)`：旧行保留自己的文本，被写上 `valid_until = now` 与 `superseded_by = new`，并退出召回。没有任何内容被覆盖，因此历史推理仍然可审计。

### 3.3 去重

`content_hash` 是 `title + "\n" + body`（两者都去掉首尾空白）的 SHA-256。在同一作用域窗口内再次写入相同文本，会刷新既有未失效行（`confidence = max(old, new)`，`pinned` 保持）并返回 `{ deduped: true }`。相同文本出现在另一个项目按设计算作另一条记忆。

## 4. 写入路径

1. 校验：标题/正文非空，标题 ≤ 200 字符，正文 ≤ 8 000 字节，
   `0 ≤ confidence ≤ 1`，以及 scope/路径/会话的一致性规则。
2. 按 `content_hash` 在作用域窗口内查找既有的未失效行。
3. 命中 → 刷新（见 §3.3），重建其索引行，返回 `deduped: true`。
4. 否则插入该行，随后把规范化文本以该行的 `rowid` 为键插入
   `memories_fts`。
5. 置顶遵守 `MAX_PINNED = 32`：超出预算时取消使用次数最少的置顶记忆，
   而不是失败。

写入不依赖模型且同步。抽取（阶段 2）调用这条路径。

## 5. 检索

索引文本是**规范化**的：每个 CJK 表意文字各自成为一个 token，拉丁词保持完整，空白合并。

```
"上下文压缩"  →  "上 下 文 压 缩"
"keepRecentTokens 20000" → "keepRecentTokens 20000"
```

查询以同样方式规范化，每个词都被引号包住，然后按 AND 连接，因此用户键入的 FTS5 运算符（`*`、`-`、`:`、`OR`）都是惰性的：

```
memory.recall("压缩 20000") → MATCH '"压" AND "缩" AND "20000"'
```

召回 SQL 在语句**内部**过滤作用域：

```sql
SELECT m.*, bm25(memories_fts) AS score
  FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
 WHERE memories_fts MATCH ?1
   AND m.superseded_by IS NULL
   AND (?2 IS NULL OR m.scope = ?2)
   AND (m.scope = 'global'
        OR (m.scope = 'project' AND m.project_path = ?3)
        OR (m.scope = 'session' AND m.session_id = ?4))
 ORDER BY m.pinned DESC, score ASC, m.use_count DESC, m.created_at DESC
 LIMIT ?5
```

返回的命中会抬升 `use_count` 与 `last_used_at`，阶段 2 的衰减会读它们。

### 5.1 容量与时延预算

在开发机上实测（SQLite + WAL + FTS5，合成语料）：

| 行数 | 库大小 | 召回（罕见词） | 召回（常见词，约 1 万次命中） |
|---|---|---|---|
| 10 000 | 15 MB | ~3 ms | ~20 ms |
| 100 000 | 88 MB | ~3 ms | ~22 ms |

设计目标：**≤ 100 000 行 / ≤ 100 MB**，并由衰减让未失效集合更小。索引必须匹配查询形状；把索引建在错误的列上，会把一次 0.1 ms 的「最近 20 条」查询变成 130 ms。

## 6. RPC 面

| 方法 | 参数 | 返回 |
|---|---|---|
| `memory.remember` | `scope`、`kind`、`title`、`body`、`projectPath?`、`sessionId?`、`tags?`、`source?`、`confidence?`、`pinned?` | `{ memory, deduped }` |
| `memory.recall` | `query`、`scope?`、`projectPath?`、`sessionId?`、`limit?`（≤ 50） | `{ memories: [{ memory, score }] }` |
| `memory.list` | `scope?`、`kind?`、`pinned?`、`projectPath?`、`sessionId?`、`includeSuperseded?`、`limit?`、`offset?` | `{ memories, total }` |
| `memory.update` | `id` 加上 `title`、`body`、`tags`、`confidence`、`pinned` 中的任意项 | `{ memory }` |
| `memory.forget` | `id` **或** `sessionId` | `{ removed }` |
| `memory.tidy` | `maxAgeDays?`、`minConfidence?`、`maxLive?`、`expire?` | `{ removed, expired, overflow }` |
| `memory.stats` | — | `{ stats: { total, live, pinned, byScope, byKind } }` |

错误使用 `INVALID_PARAMS` 表示校验失败、`MEMORY_NOT_FOUND` 表示未知 `id`。

## 7. 遗忘语义

- `forget(id)` —— 硬删除，索引行在同一次调用中移除。
- `forget(sessionId)` —— 移除与该会话相关的每一条记忆
  （`session_id = ?` 或 `scope='session' AND session_id = ?`），对应「忘掉
  那次对话里的一切」。
- 被取代的行**不会**被按会话遗忘删除；它们属于取代它的那条记忆的历史。

## 8. 迁移

Schema 版本 27 → 28（`migrate_v27_to_v28_tx`）从 `MEMORIES_DDL` 建表、建索引与
FTS 表，用的就是全新 schema 的同一份 DDL，因此全新库与升级库不会漂移。该步骤
还会在 `sessions.fast_mode`（schema v27，ADR 0334）缺失时补上它，因为被 merge 前
的记忆构建盖上 27 号戳的库带着记忆表却没有那一列。事务提交前由
`create_migration_backup` 写入上一版本的备份，v26 库一次启动即走 v26 → v27 → v28。

## 9. 此处未规定（后续阶段）

| 阶段 | 内容 |
|---|---|
| 2b | 置信度衰减；周期性清理；一轮完成后自动抽取 |
| 3 | 可选嵌入（`embedding` 列 + `sqlite-vec`）与 BM25 通过倒数排名融合 |
| — | markdown 导出/导入，使记忆可被其他 Agent 读取 |

### 9.1 阶段 2a：召回注入与 `Remember` 工具（已实现）

- **召回每轮执行**（`packages/agent-runtime/src/memory-context.ts`）：用户提示词
  （前 2 000 字符）连同会话的 `projectPath` / `sessionId` 交给宿主可选的
  `memoryRecall` 成员，最多 5 条命中，渲染成一个封顶 3 000 字符
  （≈800 token）的 `<memory_context>` 块。
- **`memoryRecall` 是可选宿主成员**，不是通用的 `call` 条目：没有实现它的宿主
  （更旧的 sidecar、只 stub `call` 的测试替身）拿不到记忆块，召回也从不出现
  在那些调用方断言过的 RPC 序列里。
- **该块进入用户消息，绝不进入系统提示词。** 系统提示词变化会重写提供方的
  提示缓存前缀（ADR 0337），而召回每轮都在变。转录保留用户的原文，因此 UI 显示
  用户键入的内容，模型看到的是记忆块。
- **召回有界且尽力而为**：2 秒超时，空/出错/超时都只意味着没有块，绝不导致该轮失败；
  仅 Agent 模式（Plan 与 Goal 轮在任何宿主动作前就声明了只含拒绝的工具集，而项目
  指令本身已带上下文）。
- **`Remember` 工具**（`memory-tool.ts` + `rpc/memory_tool.rs`）：Agent 每次调用写
  一条记忆。作用域从不来自 `args`；它默认取会话的项目，可以是 `session` 或
  `global`，会话没有项目时回退为 `session`。风险等级为 `low`（它只写 Agent 自己
  的存储）。阶段 2a 在 Agent 模式下声明它。

### 9.2 阶段 2b：保留策略（已实现）

`memory/tidy.rs` 应用两条规则；两条都可解释，且都不能碰置顶行。

| 规则 | 移除 | 从不移除 |
|---|---|---|
| **过期** | `pinned = 0 AND superseded_by IS NULL AND use_count = 0 AND confidence < 0.4 AND created_at < now - 90d` | 置顶行、被取代的历史、任何被召回过的内容 |
| **溢出** | 超过 `max_live = 50 000` 条未失效行时：`ORDER BY use_count ASC, confidence ASC, created_at ASC` | 置顶行 |

- 默认值：90 天、`min_confidence 0.4`、`max_live 50 000`、`expire: true`。
  每个字段都可以按调用覆盖（`memory.tidy`）。
- **「从未被召回」才是决定信号**，而不是年龄：Agent 一直在用的记忆不论多旧都会存活，
  而被取代的行作为历史保留，直到显式 `memory.forget`。
- 移除在同一次事务里删掉 FTS 行，因此过期的记忆之后不可能被召回。
- 宿主在启动时**每天至多跑一次**这些规则
  （`boot_maintenance → daily_memory_tidy`，用
  `kv['memoryTidy']['lastRunAt']` 节流）。失败只记日志并忽略：保留策略是
  日常维护，永远不是启动阻塞项。
- 一轮之后的自动抽取（阶段 2c）**未实现**：它需要提供方/模型以及产品负责人
  对每轮预算的决定。在它到来之前，Agent 通过 `Remember` 工具写记忆。

阶段 1 只交付了存储、去重、取代与召回。
