# ADR 0267 — Deny-first permission rules

- **Status**: Accepted for implementation
- **Date**: 2026-09-15
- **Related**: D115, D433, `03-runtime/03-tools-and-permissions.md` §6, `03-runtime/05-host-core-rust.md` §6, `03-runtime/06-host-rpc-protocol.md` `tools.execute`, `07-plugins/02-plugin-manifest-schema.md` §4–5, `07-plugins/04-plugin-security.md` §3.3, `07-plugins/13-plugin-permissions-matrix.md`

## Context

The host already has three permission modes (`ask`, `accept-edits`, `auto`)
that decide how high-risk tool calls are approved (D115). `auto` is the
Claude Code YOLO equivalent: Write, Edit, Bash, plugin tools, and explicit
outside-workspace paths all execute without a card. Session grants and
low-risk auto-allow sit on the same path.

That is not enough for two jobs this product already claims:

1. **A user-owned always-deny overlay.** Claude Code lets a user name tools,
   paths, and command prefixes that stay denied even in YOLO. PI-Desktop had
   no such list, so `auto` was an all-or-nothing posture.
2. **A plugin that can only tighten the overlay.** Policy, secret-scanning,
   and workspace-guard plugins need to contribute extra deny globs. They must
   not be able to delete the user's rules or introduce an allow list — a
   plugin that could widen `auto` would be a privilege escalation.

Plan and Goal already hard-deny Write/Edit and plugin tools without
`planSafeActions`. That contract-mode gate is a different question (which
tools exist in this operating mode) and must stay first. Deny-first is the
next gate: which of the remaining calls are forbidden regardless of mode.

## Decision

Keep the mode enum as `ask | accept-edits | auto`. Deny-first is an overlay,
not a fourth mode.

### Schema

`AppSettings.permissionDeny` and `contributes.permissionDeny` share one
object:

```ts
type PermissionDenyRules = {
  tools?: string[];
  paths?: string[];
  commands?: string[];
};
```

Unknown keys are rejected. `null` or `{}` is an empty overlay. Each list is
at most 256 entries; each entry is a non-empty string of at most 512
characters. Settings writes are validated in host-core; a corrupt persisted
object is skipped at evaluation time so a hand-edit cannot stall every tool
call. Shallow settings merge overwrites the whole `permissionDeny` key.

### Matching

Host-core compiles globs with `globset` 0.4. The SDK and the settings UI
only check shape.

- **tools** — glob against the tool name (`literal_separator`). `Bash`
  denies every Bash call; `plugin_*` denies every plugin tool.
- **paths** — glob against `path` / `file_path` / Edit `MV` dest (any tool
  that sends those keys, including Read/Write/Edit/Glob/Grep). Matching
  uses the trimmed string, `~` expansion (user home, not the workspace),
  Windows `/c/...` and `\\?\` spellings, the file name, the lexically
  resolved absolute form against the session tool root (project, or
  scratch when the session has no project), and the same
  dangling-symlink ancestor resolver execution uses
  (`resolve_external_path`). A `../.env`, `~/.ssh/config`, or Write
  through a dangling workspace symlink therefore hits the same rule as
  the path execution would write. Path globs do **not** inspect Bash
  command text or Grep file contents. `\` is treated as `/`; a pattern
  that matches only the file name still hits (so `**/.env` and `.env`
  both deny `.env`). Path globs are case-insensitive on Windows.
- **commands** — Bash `command` only, after trim. A pattern with glob
  metacharacters (`*`, `?`, `[`) is a glob; otherwise it is a prefix
  match that must be the whole command or be followed by whitespace.
  This is a string match, not argv. Prefix matching is case-insensitive
  on Windows.

A hit is `PermissionDecision::Deny`. Execution returns the existing
`TOOL_DENIED` code; there is no new error.

### Evaluation order

Inside `permissions.evaluate`, after the durable session mode is resolved:

1. Plan/Goal hard deny (Write/Edit, plugin tools without `planSafeActions`,
   unknown tools).
2. **Deny-first match** against the merged overlay.
3. Explicit outside-workspace path exception (`auto` allows; otherwise ask).
4. Low-risk auto-allow, `accept-edits` Write/Edit auto-allow, `auto`,
   session grants, then the confirmation card.

Scratch-directory writes remain prompt-free **after** this evaluation, so a
deny hit still wins. Contract-mode hard deny still precedes the overlay: a
Plan `Write` stays `*_IN_PLAN`, not a deny-rule miss.

### Merge and plugin contribution

The overlay is the union of:

- the user's `AppSettings.permissionDeny`;
- `contributes.permissionDeny` from every **enabled** plugin that has been
  granted `agent.permission.deny` and whose `ActivationScope` matches the
  session workspace (`global` always; project-scoped only when the session
  has a project and the scope hits). Scratch is not treated as a project
  for this match.

Plugins are deny-only. There is no `allow` key. A plugin cannot remove a
user rule. Host-core reads `manifest.json` at evaluation time rather than
caching the lists on `PluginSummary`, so a disable, a revoke, or a scope
miss drops the contribution on the next call. Unreadable, invalid, or schema-invalid plugin JSON is skipped with a warning.

`contributes.permissionDeny` requires `agent.permission.deny` even when the
object is empty, matching `windowAppearance`. Risk is **medium**. The name
is not in `HIGH_RISK_PERMISSIONS`; unknown-permission checks still go
through the SDK `PLUGIN_PERMISSIONS` set.

### Settings UI

Settings → AI → Permissions, under the mode select: a JSON textarea that
commits on blur. Empty / `{}` clears the overlay. Invalid JSON is not
written; the host remains the source of truth for schema errors.

## Consequences

- `auto` is no longer an unbounded YOLO: a user (or a granted plugin) can
  name tools, secrets paths, and command prefixes that stay denied.
- Plugin authors have a supported contribution for policy packs. The grant
  is visible at install and revocable; the overlay can only shrink what the
  agent may do.
- The mode enum, confirmation card, session grants, and `TOOL_DENIED` stay
  as they are. Remote approval vocabulary does not grow.
- Evaluation now reads enabled plugin manifests on the tool path. The lists
  are capped, and a broken plugin is skipped, so the extra I/O is bounded.
- A deny hit is indistinguishable from a user card denial at the protocol
  layer. That is deliberate: the model should not be taught which glob
  fired.

## Alternatives

- **Add a `deny` permission mode.** Collapses the overlay into a global
  posture and cannot express "auto, except these paths". Claude's model is
  mode plus deny list, not a fourth mode.
- **Let plugins contribute allow rules.** A plugin could then undo the
  user's overlay or widen `auto`. That is a privilege escalation.
- **Compile globs in the SDK.** The SDK has no `globset` and is not the
  enforcement point. Shape checks belong there; matching belongs in
  host-core.
- **Cache contributed lists on `PluginSummary`.** Avoids a manifest read,
  but disable/revoke/scope changes would need a second cache-invalidation
  path. Reading the file at evaluation time keeps the runtime vector as
  the source of truth.
- **New `PERMISSION_DENIED_BY_RULE` error.** Splits the fail-closed path
  the sidecar already handles as `TOOL_DENIED`, and leaks the overlay to
  the model.
