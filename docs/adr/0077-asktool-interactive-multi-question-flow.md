# ADR 0077: Add an interactive multi-question asktool

- Status: Accepted for implementation
- Date: 2026-08-12
- Deciders: PI-Desktop core
- Related: E2E-123

## Context

The model needs a structured way to collect several user decisions without
turning them into chat prose or permission approvals. The user may answer one
question at a time, choose multiple options, provide custom text, skip a
question, or decline the complete prompt.

## Decision

1. Add a built-in `asktool` to every operating mode.
2. The request carries an ordered array of question text, option labels, and an
   optional multi-select flag.
3. The renderer owns draft selection state and displays one question at a time.
4. The runtime formats the resolved values as normal tool content: each line is
   `question：answer`, multiple questions use `\n---\n`, and null answers use an
   empty value after the separator.

## Consequences

- The model receives a deterministic, compact tool result rather than UI state.
- The interactive wait is outside host permission policy and cannot grant a
  workspace capability.
- The request is additive to the existing agent event envelope and does not
  require a protocol version bump.
- Aborting a turn completes the outstanding tool call with skipped values so a
  pending card cannot strand the runtime.

## Amendment — 2026-09-27: Render asktool content as Markdown

`question`, selectable option text, and optional option descriptions may use
CommonMark/GFM. The renderer uses a safe phrasing-content projection: raw HTML
is ignored, links are non-interactive, and images do not load.
