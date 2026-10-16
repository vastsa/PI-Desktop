# Opt-in streaming plugin fences

Status: Proposed. Isolated renderer validation is covered; full Desktop acceptance is pending.

## Context

The existing `blockRenderer` contract gives a plugin the completed fence source
once. It carries no session or message identity. GenUI needs completed JSON
components to appear during a reply and needs interactions to return to the
message's original session, including after the user switches sessions.

## Decision

Add an optional boolean `streaming` registration flag. Default registrations
keep their existing closed-fence, props-once contract. Opt-in registrations
receive growing source, `closed`, `streaming`, `sessionId`, `messageId`, and a
message-relative `fenceId`. They receive terminal lifecycle updates even when
the source text is unchanged. Identity comes from the host's transcript and
parser offsets, never from JSON authored by a model.

Keep namespaced fence ownership and the `renderer.extension` trust grant.
Keep source search anchors, unload fallback, error fallback and the 4000px
host bound. Observe opt-in mounts for overflow after asynchronous rendering.

GenUI runs as a separately loaded plugin. Its actions use `plugin.call` and
the existing `desktop.control`-gated `agent/prompt` operation. There is no
new runtime, database, network permission, hidden file queue or automatic
message retry. Admission errors remain visible in the block.

## Alternatives

A DOM observer could replace host code-block elements but would bind the
plugin to private DOM structure and compete with React ownership. An
`entryExtra` slot could display the same content below a reply, but cannot
preserve the placement of text around the fence. Keeping static fences cannot
provide progressive rendering. An opt-in public contract preserves existing
plugins while supporting the actual message workflow.

## Consequences

Opt-in plugins own partial-source parsing and resource bounds. State keys
combine host identity with final content, so repeated fences do not share
answers. A large block may constrain its own viewport below the host bound.
Legacy renderers still receive exactly their original two props.
