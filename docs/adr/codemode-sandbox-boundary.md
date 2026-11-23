# ADR: Codemode sandbox execution boundary

- Status: accepted
- Date: 2026-11-21
- Related: issue #2498, [pi-coding-agent design review](../project/pi-coding-agent-design-review.md#codemode), [tool abort](tool-abort-abandons-host-call.md)

## Context

Multi-step investigations, large-log filtering, and chains of MCP calls cost
one model round trip per tool call, and every intermediate result enters the
context. Pi 1.x ships a QuickJS-WASI sandbox (`@earendil-works/pi-codemode`)
that lets a model write a short script which calls tools locally and returns
only its own output. The coding-agent extension that uses it is bound to
`AgentSession`, which would add a second session, permission, and usage
authority beside Desktop's runtime and Host.

## Decision

1. Desktop adds an opt-in `codemode` tool in `packages/agent-runtime` on a
   narrow adapter over `pi-codemode` (`src/codemode/`). It does not use
   `AgentSession` or the coding-agent extension runtime. The setting is
   `AppSettings.codemodeEnabled`, off when absent, and Electron main forwards it
   only for Agent sessions. When on, the tool is declared up front.
2. Scripts run in a QuickJS-WASI worker thread with a 256 MiB heap cap, a
   default 120 s and maximum 600 s deadline, a 64 KiB source cap, at most 256
   nested calls, a bounded call record (8 KiB arguments per call, 32 KiB in
   total) and a bounded output budget. At most two sandbox workers run per
   sidecar; a worker slot is held until the worker actually exits. The module,
   worker and WASM load on the first script.
3. The sandbox holds no host function, credential, binding, or header. A
   nested `tools.<name>()` call is dispatched through pi-agent-core
   `runToolCall` with the session's own `beforeToolCall`/`afterToolCall`, so
   argument validation, ToolSearch activation, mode policy, trusted-extension
   hooks, path instructions, Host permission/approval, file admission, audit,
   and mutation recovery are exactly those of a direct call. Only the session's
   currently active tools (core plus ToolSearch-activated, allowed in the mode)
   are present in the sandbox. Discovery, `asktool`, mode and stage control,
   `new_context`, delegation lifecycle, and `codemode` itself are never callable.
   QuickJS isolation does not grant permission to anything.
4. Tools that are not parallel-safe run one at a time in call order across all
   scripts of a session; Read, Glob and Grep may overlap and still pass Host
   admission. Each nested call is its own one-call batch and releases its Host
   batch state when it settles.
5. The script's `AbortSignal` reaches every nested call. Stop therefore sends
   the existing `tools.abort` for an in-flight nested Host call. A failed script
   states which nested calls already ran; side effects are never described as
   rolled back.
6. Nested calls emit ordinary `tool_start`/`tool_update`/`tool_end` events with
   id `<codemodeCallId>/<n>` and `nestedParentToolCallId` set to the script's
   call. `parentToolCallId` remains reserved for `Task` ownership, so the two
   lineages never mix. Nested rows are transcript and review data only: they
   are excluded when the model context is rebuilt, because the model saw only
   the script's result. Delegates never inherit `codemode`.
7. `models.*` globals expose allowlisted metadata only (id, account id, name,
   limits, modalities): `models.list()`, `models.complete()` on the session's
   own binding, `models.classify()` through TypeSafe Jev when it is enabled, and
   `models.generateImages()` as a nested `GenerateImages` call when that tool is
   callable. Model calls share a limit of four in flight per script. Every
   physical request emits its own identified usage (operation id, physical
   account and model), so the Host ledger records and deduplicates it.
8. The sidecar bundle ships `chunks/codemode-worker.js` and
   `chunks/quickjs.wasm`; a bundled runtime resolves only these and fails the
   script rather than falling back to node_modules.

## Consequences

Scripts can batch and filter tool output locally while every effect still
crosses the same Host boundary. The feature is invisible until enabled.
`agent-runtime` takes a direct dependency on `@earendil-works/pi-codemode`
(already in the lockfile through coding-agent). Script state (`store`/`load`)
is not persisted across scripts in this version. Codemode is not offered in
contract modes or to delegates; extending it there needs a lineage-aware binding
for each owner.

## Alternatives

- Adopt coding-agent's `AgentSession` codemode extension: rejected, it creates a
  second session, permission and ledger authority.
- External plugins (`context-mode`, `rtk`): can shrink one output, but cannot
  combine built-in tools, MCP and auxiliary models in one execution.
