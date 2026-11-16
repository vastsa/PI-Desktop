# ADR: Preserve chronological model system state

- Status: Accepted
- Date: 2026-10-01
- Issue: #1285
- References: [Pi PR #9548](https://github.com/earendil-works/pi/pull/9548),
  [Pi model authority](pi-ai-core-0991-authority.md)
- Updates: ADR 0039 catalog refresh, ADR 0225 deferred-tool restoration

## Context

Moving new tool declarations to the beginning of a conversation changes its
cached prefix. Rebuilding from visible chat alone also loses the chronology of
instruction and tool changes.

## Decision

Keep Pi's provider-neutral system messages in chronological order. Use the
existing Host-owned transcript writer and optional versioned `modelSystem`
metadata on hidden system rows, acknowledging writes before dispatch.

Separate Desktop's runtime instructions, skill catalog and contextual guidance
into replaceable sections. The skill-loading header uses `skills`, and each
catalog entry uses `skill:<exact-id>`; a change or removal appends only that
entry's replacement or null tombstone.

## Fixed declarations for the verified Flash route

For the exact official `deepseek-flash` / `openai-completions` binding with
verified chronological system support, declare the complete current tool catalog
in deterministic name order from the first request. ToolSearch changes execution
activation only.

Keep activation separate from declarations in a versioned `tool_activation`
system section. The section records active deferred names and a SHA-256 identity
of the account, model, API, endpoint, declarations and deferred-name set.

## Alternatives and consequences

Prepending a reconstructed snapshot was rejected because it changes history on
ordinary continuation.

The added records consume transcript storage.
