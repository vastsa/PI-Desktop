# pi-coding-agent 0.99.1 design review

Scope: reference evaluation alongside the pi-ai/pi-agent-core migration. This
review does not enable Codemode, virtual models, or replace Desktop's tool
runtime. The installed 0.99.1 JavaScript and declarations are the evidence;
no third-party account or paid request was used.

## Tool composition

`core/agent-session.js` separates registered, callable, and declared tools.
`_getCallableTools` and `_applyToolLoadout` honor exposure and `prepareLoadout`.
The tool-search extension ranks names, descriptions, namespaces, and schema
properties with BM25 and activates deferred tools. Transcript loadouts restore
activation across resume and branches.

Adopt the separation of declaration from execution when consolidating Desktop's
existing deferred tool search. A visible declaration must never grant execution
permission. Search, direct invocation, delegates, and nested invocation should
resolve against the same session inventory and pass Host authorization. Preserve
Desktop's existing ToolSearch names and persisted activation history.

Do not import private AgentSession methods or add exports by patching Pi. The
installed package does not expose an independent ToolComposition API; the
composition is coupled to session state, extension hooks, and Pi session storage.
Replacing Desktop's own session manager to obtain it would expand this migration
and complicate removing pi-coding-agent later.

## Codemode

`extensions/codemode/execute.js` uses pi-codemode's QuickJS sandbox, a worker,
a 256 MiB VM heap cap, output limits, and a four-call model concurrency limiter.
It strips model headers before exposing metadata to scripts. `execute.lazy.js`
defers sandbox loading. Script tool calls go through `ctx.executeTool` rather
than obtaining host functions or credentials directly.

`core/nested-tool-calls.js` records the immediate parent, routes each call through
`runToolCall`, and serializes tools that require exclusive execution. Arguments
are bounded to 8 KiB per call and 32 KiB total, with at most 256 recorded calls;
usage is collected even when a record is omitted. Errors describe completed side
effects instead of implying rollback.

These are useful design constraints for a future Desktop Codemode implementation.
Keep Task ownership distinct from the immediate nested parent, preserve operation
identities when aggregating usage, propagate cancellation to every host call, and
bound both output and execution. The current migration already preserves separate
lineage fields and physical usage identities without requiring AgentSession.
Pi's additive usage totals alone are insufficient for Desktop's replayable ledger.

Prefer a future narrow sandbox adapter to adopting the coding-agent extension
runtime. Adoption requires an ADR for the execution boundary, tests proving Host
permission enforcement and cancellation, and a standalone production bundle test
covering worker/WASM assets from outside node_modules. QuickJS isolation does not
itself grant permission to tools. No Codemode execution is enabled by this review.

## Virtual routing

`core/model-runtime.js`, `core/virtual-models.d.ts`, and `docs/virtual-models.md`
separate virtual selection from physical dispatch. Routing gets a request reason
(user, continuation, retry, direct), previous/failed physical responses, an abort
signal, and JSON-serializable branch state. It rejects unavailable or virtual
routing targets and clamps effort to the physical model. The session persists
router state and checks context against the dispatched model.

Borrow these contracts if Desktop introduces automatic routing: retain the user's
selected route, attribute requests and price to physical account/model IDs, pin
continuations and retries unless policy explicitly switches, use dispatched
context limits, and restore route state on resume/fork. A classifier request is
an additional physical operation with its own latency and usage.

Do not add routing now. `ModelRuntime.create` builds its own provider/config/auth
composition; its public creation options do not accept Desktop's existing
account-scoped Models collection. Direct adoption would introduce a second
account authority. A future router should take allowed physical bindings from
the existing pi-ai account collections and return a resolved physical binding;
it must not silently broaden the account or provider allowlist.

## Recommendation

Complete the pi-ai/pi-agent-core migration first. Keep coding-agent as the
existing compatibility dependency for compaction/file utilities, with no new
session-runtime dependency. Record the above patterns for follow-up work; first
consolidate tool inventory, then evaluate the sandbox independently, and add
routing only with a product policy and persistence contract. None of these
follow-ups is a migration acceptance requirement.
