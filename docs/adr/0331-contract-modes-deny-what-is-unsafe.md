# ADR 0331: Contract modes deny what is unsafe

- Status: Accepted
- Date: 2026-10-15
- Deciders: PI-Desktop core
- Amends: ADR 0052 §3, ADR 0053 §1, ADR 0211 §4
- Related: ADR 0064, ADR 0089, `mcp-tool-approval-risk`

## Context

Plan and Goal must keep direct mutation tools unavailable without making
read-only capabilities inaccessible. Shell commands and opaque MCP tools cannot
be classified reliably by their names or self-reported risk. Mode prompts
provide guidance; permission checks decide whether a call may execute.

An earlier revision of this policy classified builtins by an explicit read-only
allowlist: a builtin absent from the list was denied until it was classified.
That asks the question from the wrong side. It refuses read-only local tools
that change nothing, it makes every newly added builtin an immediate contract
mode regression, and it obscures the property that actually matters, which is
the effect of a call rather than the provenance of its name.

## Decision

Contract modes are effect-scoped rather than capability-scoped: the gate asks
what a call does, not where its name comes from.

- A contract mode denies the builtins that act on state instead of inspecting
  it: the ones that write files or session state (`Write`, `Edit`, `TodoWrite`,
  `GenerateImages`, `PluginScaffold`, `PluginPack`, the `ScheduledTask*` tools),
  the delegation family that spawns and controls work (`Task*`), and
  `JevClassify`, whose paid provider call must not run from a reference retained
  across a mode switch. A builtin that reaches the network on its own belongs on
  this list too; `Bash` and a user MCP tool are absent because a permission card
  already covers what they can do.
- Every other builtin is admitted by the gate and falls through to the ordinary
  permission path, which still applies risk, the effective permission mode,
  session grants, and the external-path rule. `Read`, `Glob`, `Grep`,
  `BrowserPreview`, and a builtin nobody classified take that path. `asktool`,
  `new_context`, `ToolSearch`, and the submit tool belonging to the current mode
  are runtime-local and never reach the host gate.
- `Bash` and user MCP tools require explicit approval in every permission mode,
  including `auto`. An exact-tool `allow-session` grant suppresses subsequent
  prompts only in that session.
- Plugin tools require a non-empty `planSafeActions` list. Admission does not
  grant permission: ordinary risk, external-path, and session-grant rules still
  apply. The plugin runtime rejects unlisted actions before dispatch.
- Plugin-contributed MCP tools have no supported `planSafeActions` declaration.
  Their execution callback rejects Plan and Goal independently of caller-supplied
  admission metadata.
- Trusted-extension tools remain unavailable in contract modes, including
  through references retained before a mode change. They execute outside the
  host permission path, so the host gate never sees them.
- MCP tools remain discoverable through existing ToolSearch and explicit
  selections. Admission does not make every MCP schema a core declaration.
- Refusing an approval card returns `TOOL_DENIED`; a contract-mode hard denial
  retains its existing `_IN_PLAN` error code in both Plan and Goal.
- The deny list is the contract. `crates/host-core/src/permissions.rs` and
  `packages/agent-runtime/src/mode-tool-access.ts` mirror it in two languages,
  and `mode-tool-access.test.ts` fails when the two copies drift apart.

## Consequences

Plan and Goal can use MCP capabilities after user approval without a separate
server allowlist. `auto` no longer automatically permits their Bash or MCP calls.
Agent-mode permission behavior is unchanged.

A builtin added later is admitted by omission. That is the accepted cost of
answering by effect: the alternative refused read-only tools and turned every
new builtin into a contract-mode incident. The exposure is bounded but not
closed: a contract mode never builds the eight denied tools it does not declare,
it refuses the six declarations it retains (`Write`, `Edit`, and the `Task*`
family) before any host action, and the drift test keeps the two languages in
step. None of those catches a state-changing builtin nobody added to the list,
so it stays reachable in Plan until someone classifies it. Deciding what a new
builtin does to state is part of adding it.

The gate admits names the allowlist never listed: `ToolSearch`, `PluginCheck`,
`Skill`, and any builtin added later. What a contract mode declares to the model
barely moves: `ToolSearch` is the one addition, because an MCP tool stays
deferred behind it, and `PluginCheck` and `Skill` pass the gate without ever
being built in a contract mode. The exposure sits in the gate, so the deny list
is the contract, not the runtime's declaration set.

Approval is not filesystem isolation: an approved shell command or opaque MCP
call may mutate state. This policy controls authorization, not the effects of
arbitrary code. Plugin authors remain responsible for the semantics of actions
they declare plan-safe.

## Alternatives

- The read-only allowlist this ADR replaces: it refused read-only local tools,
  required a classification decision for every new builtin, and still could not
  classify `Bash` or an opaque MCP tool.
- Parsing shell commands cannot reliably establish whether they mutate files.
- Trusting MCP risk annotations lets remote code classify its own access.
- Gating on a tool's declared risk: the same remote code supplies it.

## References

- `crates/host-core/src/permissions.rs`
- `packages/agent-runtime/src/mode-tool-access.ts`
- `apps/desktop/electron/main/plugin-runtime.ts`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
