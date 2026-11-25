# Scoped memory design and source analysis

Status: implemented in plugin 0.9.1. Research checked on 2026-10-30
(Asia/Shanghai). This plugin changes no PI host database, IPC, or SDK contract.

## Research

GitHub stars below were read from the public repository API during research;
they are a dated qualification of the references, not a maintained counter.

| Project | Stars at inspection | Source inspected |
|---|---:|---|
| [Mem0](https://github.com/mem0ai/mem0) | 68,056 | `26cdefb46600c0fa5953c4b5ee5003c125539fc4` |
| [Open WebUI](https://github.com/open-webui/open-webui) | 157,148 | `f7ac7ee10962ddec0017f5c29b6740d9b9c5faca` |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 44,103 | Current official JavaScript Stores documentation |
| [Letta](https://github.com/letta-ai/letta) | 25,289 | Historical `archive` branch, `56ba9c25552605eec89de8ed3dc6394b625c1993` |

### Mem0: context-bound scopes

Mem0's shared agent integration uses project, session, and global scopes with
user/app/run identities. Its Pi integration delegates tools to this shared
layer. The scope resolver prevents an unrequested promotion to global scope.
The OSS client can store already-selected text without LLM inference.
See the fixed [scope resolver](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/integrations/agent-plugin-core/typescript/src/scoping.ts),
[Pi memory tools](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/integrations/pi-agent-plugin/src/memory/tools.ts),
and [OSS memory client](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0-ts/src/oss/src/memory/index.ts).

Applied here: the model chooses a level but cannot supply an owner identity.
Every record has an explicit scope and exact owner. A user-only search never
means all project/session records for that user. Directory basenames are not
used as project identity because unrelated projects can share a name.

### Open WebUI: user control and model tools

Open WebUI exposes manual management alongside native model memory tools.
Records can be edited or deleted by identity; types and paths organize memory.
The system distinguishes access controls, model tools, and prompt injection,
and bounds the injected content. Its backend applies user ownership checks.
See [official memory documentation](https://docs.openwebui.com/features/chat-conversations/memory/),
[CRUD routes](https://github.com/open-webui/open-webui/blob/f7ac7ee10962ddec0017f5c29b6740d9b9c5faca/backend/open_webui/routers/memories.py),
and [memory rendering](https://github.com/open-webui/open-webui/blob/f7ac7ee10962ddec0017f5c29b6740d9b9c5faca/backend/open_webui/utils/memory.py).

Applied here: one service validates both manual and AI operations, backend
switch checks cover every tool call, records remain manually manageable while
AI use is off, and retrieval has an explicit content budget. Unlike its full
web application, this plugin does not implement a server or background review.

### LangGraph: separate session state and namespaced facts

LangGraph separates thread checkpoints from a Store for cross-thread values.
A Store namespace can represent user/project identity, and records have their
own keys. Embedding search is optional. Its namespace search defaults to
prefix matching and backend-dependent ordering.
See [official JavaScript Stores documentation](https://docs.langchain.com/oss/javascript/langgraph/stores).

Applied here: small versioned records with a distinct owner, exact matching
before ranking, and deterministic ordering. There is no need to introduce the
graph runtime or a vector database for a bounded local store.

### Letta: bounded memory blocks, historical reference

Letta's historical implementation combines labeled core memory blocks with
searchable archival memory. Blocks have explicit capacity, and their rendering
distinguishes structure from content. See [memory block documentation](https://docs.letta.com/v1-sdk/memory/memory-blocks/)
and the [archived renderer](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/schemas/memory.py).
The current repository states that the old V1 server is retired, so this is a
historical design reference. The three projects above supply active references.

Applied here: clear descriptions of each level and a hard recall budget. The
host does not expose a general prompt hook for sandboxed plugins, so this
plugin returns memories as on-demand tool results instead of claiming to add
always-present core memory blocks.

## Implemented contract

### Ownership and switches

- User owner is `local-user`, within the current plugin-private PI profile.
- Project owner is `path:<normalized-project-path>`, where normalization is the
  host sidebar's own rule: slashes are unified, the Windows extended-length
  prefix is stripped, and trailing slashes go except after a drive letter. Two
  spellings of one folder are therefore one owner. Project groups are not
  consulted: the sidebar treats each folder as its own project, so two roots of
  one group keep separate memories.
- The session level is deliberately absent. Mid-task context already lives in
  the transcript; a second copy only added staleness, and it shared a key with
  the session-switch race. Only user and project levels exist.
- Missing context never maps to an `unknown` shared bucket or an unrelated
  visible workspace.
- AI execution requires a host-bound session and that session must remain
  selected. The panel carries its displayed project context on mutations; stale
  contexts are refused. Asynchronous host reads are checked again before use.
- Master enablement, two level switches, AI reads, and AI writes are distinct
  booleans. The master and AI writes default off. Successful switch changes
  apply to all following operations in the serialized queue.
- Disabled memory remains editable in the manager. Switching off stops future
  tool reads/writes; it cannot retract text already returned into a transcript.
- AI writes are denied in Plan/Goal. Only `recall` is declared plan-safe.
- A user-level `save` from the assistant returns a proposal instead of mutating.
  Only the panel writes user memory, because a user preference shapes every
- A user-level `save` from the assistant is a proposal, never a mutation. The
  proposal is stored in the document's `proposals` list and appears under
  **Awaiting your confirmation** in the panel, so it survives a reload instead of
  vanishing with the tool result that carried it. The user saves or dismisses it;
  accepting writes a normal `source: manual` entry and supersedes a same-label
  entry. This exists because a user preference shapes every future conversation.
  Project writes from the assistant are direct and marked `source: ai`.
- At most 20 proposals are held. Repeating the same content returns the pending
  proposal instead of queueing a second copy. Accepting a proposal that already
  matches an active entry discards the proposal rather than duplicating it.

`memory.v1.json` is ordinary private JSON, not a secret store. Its schema is:

```text
schemaVersion: 3
settings: five boolean switches
entries: [{id, scope, owner, title, content, revision, source,
            createdAt, updatedAt, validUntil, supersededBy}]
proposals: [{id, title, content, createdAt}]
```

`createdAt`/`updatedAt` record when we wrote the entry; `validUntil` records
when it stopped applying. The two axes never overwrite each other, so a retired
row can still answer "what did we believe then".

The service serializes settings, reads, and writes to avoid stale snapshots.
It writes a unique mode-0600 temporary file in the same directory, syncs its
contents, rechecks context/cancellation, then renames it into place. The cached
snapshot changes only after rename succeeds. Unload cancels pending work and
waits for the queue. This assumes one live plugin writer per private data
directory; concurrent independent PI processes sharing that directory are not
supported. File sync plus rename protects against partial writes; directory
metadata is not separately fsynced, so power-loss durability is OS dependent.

Invalid JSON, invalid record shapes, excessive size, or an unsupported schema
version produces a visible error without resetting the store. I/O failures
retain the prior snapshot and do not log memory content or host paths. The
original enhancement settings remain in their existing settings record.
There is no migration of the host database or existing enhancement settings.

Updates and deletions require the currently visible ID, exact scope/owner, and
expected revision. Duplicate additions in one owner scope are idempotent. A
save whose label matches an active entry at the same level supersedes it: the
old row gets `validUntil = now` and `supersededBy = <new id>` and stays on disk,
while recall and the panel show active rows only. Deletion is the same
mechanism with a null successor, so nothing is destroyed. Cross-owner guessed
IDs do not grant access. Atomic writes leave neither the cache nor the file
reporting an uncommitted mutation.

### Retrieval and trust

Retrieval first filters exact scope/owner, active rows, and enabled levels, then
orders by project/user level, lexical match score, descending update time, and
stable ID. English words and Chinese bigrams are normalized for matching. This
is lexical search; synonyms require an appropriate query. Empty queries list
recent entries within level order. Exact duplicate content is omitted from
combined recall. Conflicting statements remain visible rather than being
semantically rewritten.

Limits are per level, because a user entry is far more expensive than a project
entry: 500 UTF-16 code units and 50 entries / 4,000 characters for the profile,
2,000 code units and 100 entries / 32 KB per project. A recall returns 512 query
characters maximum, 20 entries and 6,000 content characters (default 10).
`truncated` reports omitted matching records; JSON metadata is additional to the
content budget. Exceeding a level's capacity is an explicit `MEMORY_CAPACITY`
error rather than silent truncation. No memory text is promoted to a system
role, evaluated, or rendered as HTML. Tool guidance explains that current user
instructions override stored facts. Model selection and writing quality remain
model dependent.

Moving a project folder, or opening one folder through a path spelling that
normalization cannot collapse (a symlink, a different drive mapping), produces a
new owner. Project records persist until superseded or the plugin is uninstalled;
there is no TTL or automatic deletion hook.

### Schema versioning

The document carries `schemaVersion: 3`. This build reads and writes exactly
that shape and nothing else: a document from any other version is refused with
`MEMORY_STORAGE_INVALID` and left byte-identical on disk.

That refusal is the whole contract, and it is deliberate. Silently reshaping a
document whose fields are not known is how records disappear; a visible error
keeps the data recoverable by an older build. The feature is still in
development, so there is no upgrade path to maintain and no half-migrated file
to reason about.

## Acceptance and verification

Run from the request worktree using the existing PI toolchain/dependencies:

```bash
node --test --test-timeout=60000 scripts/memory.test.mjs scripts/memory-host.test.mjs
node --test --test-timeout=60000 scripts/memory-ui.test.mjs
node scripts/smoke.mjs
node scripts/build-css.mjs
node build.mjs
node --test --test-timeout=60000 scripts/build.test.mjs
```

The first command tests real temporary private files through the service and
plugin entry points. The renderer test runs the actual React component in a
hidden Electron window with an isolated profile and a fake host bridge. It
never attaches to a running PI instance or calls a provider. Each test suite
has a 60-second bound; the Electron child is killed after 55 seconds.

Representative scenarios:

1. In settings, manually save one record at each level while AI is off. Enable
   recall, retrieve both levels, enable writes, then update/delete through the
   AI tool and verify the same manager shows the result.
2. Change project: retain only user entries. Group roots share host identity;
   same-named unrelated paths remain separate. A session with no project gets
   `MEMORY_NO_PROJECT` and never inherits an unrelated visible workspace.
3. Save twice with the same label: recall and the panel show only the new body,
   while the file keeps the retired row with `validUntil` and `supersededBy`.
4. Ask the assistant to save at user level with AI writes on: it returns a
   proposal and the store is unchanged until the user accepts it in settings.
5. Disable any level, recall, or writes, then repeat tool calls. Disabled data
   is excluded/refused while manual management continues to work.
6. Save concurrently, edit with a stale revision, supply guessed foreign IDs,
   switch context during an await, cancel queued/in-flight work, or unload.
   No operation lands in another scope or corrupts later queue operations.
7. Restart the plugin and recall durable records. A document from another schema
   version is refused with its bytes intact; corrupt files are preserved on error;
   a failed rename retains old disk/cache state.
8. In the renderer, add/edit/search/delete with confirmation; verify empty
   states, independent switches, save errors, context clearing, unavailable
   levels, late response rejection, missing grant guidance, EN/zh-CN locale
   changes, text escaping, and listener cleanup.

Live installed-plugin/provider behavior is a separate manual acceptance step:
load this folder or its built package in PI, grant `agent.tool.register`, enable
memory, add a project rule, and explicitly ask the model to recall it. This
step needs an actual provider and is not part of the isolated automated tests.

The generated HTML also has a syntax regression test: template replacement
must insert JavaScript literally. Passing a bundle as a string replacement
interprets dollar replacement tokens and can corrupt React's emitted code. The
builder now uses callback replacements; the regression test fails on the old
builder and passes on the new one.
