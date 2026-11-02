# 21. Durable Memory Store

## 1. Scope

Host-owned, durable memory that outlives a session: facts, preferences,
decisions, pitfalls and procedures the agent or the user chose to keep.
Storage, dedupe, supersession and keyword recall are specified here;
automatic extraction and decay are future stages (§9).

Anchored by [ADR 0371](../../adr/0371-memory-store.md).

## 2. Ownership

| Concern | Owner |
|---|---|
| table, indexes, FTS index | Rust host-core (`crates/host-core/src/memory.rs`) |
| RPC surface | `crates/host-core/src/rpc/memory_rpc.rs` (`memory.*`) |
| template injection into prompts | `packages/agent-runtime` (stage 2) |
| list/edit/delete UI | renderer, through RPC only |

The renderer never reads SQLite. The Node runtime never writes memory rows
directly; it calls `memory.*`.

## 3. Data model

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

Indexes:

| Index | Query it serves |
|---|---|
| `idx_memories_dedupe (content_hash, scope, ifnull(project_path,''), ifnull(session_id,''))` UNIQUE | dedupe lookup |
| `idx_memories_scope_created (scope, created_at DESC)` | "recent memories in this scope" |
| `idx_memories_project_used (project_path, last_used_at DESC, created_at DESC)` | per-project list ordering |
| `idx_memories_session_created (session_id, created_at DESC)` | session panel |
| `idx_memories_pinned (use_count DESC) WHERE pinned = 1` | pinned injection |
| `idx_memories_live (scope, created_at DESC) WHERE superseded_by IS NULL` | live-only listings |

### 3.1 Scopes

| scope | requires | injected / recalled for |
|---|---|---|
| `global` | neither path nor session | every project and session |
| `project` | `project_path` | sessions whose project path matches |
| `session` | `session_id` | that session only |

The two `CHECK`s make an inconsistent row impossible, so recall filtering in
SQL cannot accidentally match a malformed row.

### 3.2 Time

`created_at` / `updated_at` = when the agent learned it. `valid_from` /
`valid_until` / `superseded_by` = when the fact is believed true. A correction
calls `supersede_memory(old, new)`: the old row keeps its text, gets
`valid_until = now` and `superseded_by = new`, and leaves recall. Nothing is
overwritten, so historical reasoning stays auditable.

### 3.3 Dedupe

`content_hash` is SHA-256 of `title + "\n" + body`, both trimmed. Writing the
same text again *in the same scope window* refreshes the existing live row
(`confidence = max(old, new)`, `pinned` sticky) and returns
`{ deduped: true }`. Identical text in another project is a different memory
by design.

## 4. Write path

1. Validate: non-empty title/body, title ≤ 200 chars, body ≤ 8 000 bytes,
   `0 ≤ confidence ≤ 1`, and the scope/path/session coherence rules.
2. Look up an existing live row by `content_hash` inside the scope window.
3. If found → refresh (see §3.3), rebuild its index row, return `deduped: true`.
4. Otherwise insert the row, then insert the normalised text into
   `memories_fts` keyed by the row's `rowid`.
5. Pinning respects `MAX_PINNED = 32`: pinning beyond the budget unpins the
   least-used pinned memory rather than failing.

Writes are model-free and synchronous. Extraction (stage 2) calls this path.

## 5. Retrieval

Index text is **normalised**: every CJK ideograph becomes its own token, Latin
words stay whole, whitespace collapses.

```
"上下文压缩"  →  "上 下 文 压 缩"
"keepRecentTokens 20000" → "keepRecentTokens 20000"
```

The query is normalised the same way and every term is quoted, then AND-ed, so
FTS5 operators typed by a user (`*`, `-`, `:`, `OR`) are inert:

```
memory.recall("压缩 20000") → MATCH '"压" AND "缩" AND "20000"'
```

Recall SQL filters scope **inside** the statement:

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

Returned hits bump `use_count` and `last_used_at`, which stage 2 decay reads.

### 5.1 Size and latency budget

Measured on the development machine (SQLite + WAL + FTS5, synthetic corpus):

| rows | db size | recall (rare term) | recall (common term, ~10 k matches) |
|---|---|---|---|
| 10 000 | 15 MB | ~3 ms | ~20 ms |
| 100 000 | 88 MB | ~3 ms | ~22 ms |

Design target: **≤ 100 000 rows / ≤ 100 MB**, with decay keeping the live set
smaller. Indexes must match the query shape; an index on the wrong column
turns a 0.1 ms "recent 20" query into 130 ms.

## 6. RPC surface

| Method | Params | Returns |
|---|---|---|
| `memory.remember` | `scope`, `kind`, `title`, `body`, `projectPath?`, `sessionId?`, `tags?`, `source?`, `confidence?`, `pinned?` | `{ memory, deduped }` |
| `memory.recall` | `query`, `scope?`, `projectPath?`, `sessionId?`, `limit?` (≤ 50) | `{ memories: [{ memory, score }] }` |
| `memory.list` | `scope?`, `kind?`, `pinned?`, `projectPath?`, `sessionId?`, `includeSuperseded?`, `limit?`, `offset?` | `{ memories, total }` |
| `memory.update` | `id` + any of `title`, `body`, `tags`, `confidence`, `pinned` | `{ memory }` |
| `memory.forget` | `id` **or** `sessionId` | `{ removed }` |
| `memory.tidy` | `maxAgeDays?`, `minConfidence?`, `maxLive?`, `expire?` | `{ removed, expired, overflow }` |
| `memory.stats` | — | `{ stats: { total, live, pinned, byScope, byKind } }` |

Errors use `INVALID_PARAMS` for validation failures and `MEMORY_NOT_FOUND` for
an unknown `id`.

## 7. Forget semantics

- `forget(id)` — hard delete, index row removed in the same call.
- `forget(sessionId)` — removes every memory tied to that session
  (`session_id = ?` or `scope='session' AND session_id = ?`), matching "forget
  everything from that conversation".
- Superseded rows are *not* deleted by forget-by-session; they belong to the
  history of the memory that replaced them.

## 8. Migration

Schema version 27 → 28 (`migrate_v27_to_v28_tx`) creates the table, indexes and
FTS table from `MEMORIES_DDL`, the same DDL the fresh schema uses, so a fresh
database and an upgraded one cannot drift. The step also re-asserts
`sessions.fast_mode` (schema v27, ADR 0334) when it is missing, because a
database stamped 27 by the pre-merge memory build carries the memory tables
without that column. A backup of the previous version is written by
`create_migration_backup` before the transaction commits, and a v26 database
walks v26 → v27 → v28 in one launch.

## 9. Not specified here (later stages)

| Stage | Content |
|---|---|
| 2b | confidence decay; periodic tidy-up; automatic extraction after a completed turn |
| 3 | optional embeddings (`embedding` column + `sqlite-vec`) fused with BM25 via reciprocal rank |
| — | markdown export/import so memories are readable by other agents |

### 9.1 Stage 2a: recall injection and the `Remember` tool (implemented)

- **Recall runs per turn** (`packages/agent-runtime/src/memory-context.ts`): the
  user prompt (first 2 000 chars) is sent to the host's optional
  `memoryRecall` member, with the session's `projectPath` / `sessionId`, up to 5
  hits, rendered into one `<memory_context>` block capped at 3 000 chars
  (≈800 tokens).
- **`memoryRecall` is an optional host member**, not a generic `call` entry: a
  host that does not implement it (an older sidecar, a test stub that only
  stubs `call`) gets no memory block, and recall never appears in the RPC
  sequence those callers assert on.
- **The block enters the user message, never the system prompt.** A system
  prompt change rewrites the provider prompt-cache prefix (ADR 0337) and recall
  changes every turn. The transcript keeps the user's original text, so the UI
  shows what the user typed while the model sees the memory block.
- **Recall is bounded and best effort**: 2 s timeout, empty/error/timeout all
  yield no block and never fail the turn; Agent mode only (Plan and Goal turns
  declare a denial-only tool set before any host action, and project
  instructions already carry their context).
- **`Remember` tool** (`memory-tool.ts` + `rpc/memory_tool.rs`): the agent writes
  one memory per call. Scope never comes from `args`; it defaults to the
  session's project, can be `session` or `global`, and falls back to `session`
  when the session has no project. Risk class is `low` (it only writes the
  agent's own store). Stage 2a advertises it in Agent mode.

### 9.2 Stage 2b: retention (implemented)

`memory/tidy.rs` applies two rules; both are explainable and neither can touch
a pinned row.

| Rule | Removes | Never removes |
|---|---|---|
| **Expiry** | `pinned = 0 AND superseded_by IS NULL AND use_count = 0 AND confidence < 0.4 AND created_at < now - 90d` | pinned rows, superseded history, anything ever recalled |
| **Overflow** | above `max_live = 50 000` live rows: `ORDER BY use_count ASC, confidence ASC, created_at ASC` | pinned rows |

- Defaults: 90 days, `min_confidence 0.4`, `max_live 50 000`, `expire: true`.
  Every field is overridable per call (`memory.tidy`).
- **"Never recalled" is the deciding signal**, not age: a memory the agent keeps
  using survives regardless of age, and superseded rows stay as history until an
  explicit `memory.forget`.
- Removal drops the FTS row in the same transaction, so an expired memory cannot
  be recalled afterwards.
- The host runs the rules **at most once a day** at startup
  (`boot_maintenance → daily_memory_tidy`, throttled through
  `kv['memoryTidy']['lastRunAt']`). Failures are logged and ignored: retention is
  housekeeping, never a startup blocker.
- Automatic extraction after a turn (stage 2c) is **not implemented**: it needs a
  provider/model and a per-turn budget decision from the product owner. Until
  then the agent writes memories through the `Remember` tool.

Stage 1 shipped storage, dedupe, supersession and recall only.
