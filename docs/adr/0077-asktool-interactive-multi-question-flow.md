# ADR 0077: Add an interactive multi-question asktool

- Status: Accepted for implementation (amended 2026-09-27: question and option
  text render as Markdown for display only)
- Date: 2026-08-12
- Related: E2E-123

## Context

The model needs a structured way to collect several user decisions without
drafting chat prose or permission requests. The user may answer one question at a
time, select multiple options, add custom text, skip, or decline the prompt, and
an unanswered call still needs a stable tool output.

## Decision

1. A built-in `asktool`, available in every operating mode, emits a typed
   `asktool_request` event and pauses the runtime until the renderer resolves it
   through `pi-desktop/agent/askTool/resolve`.
2. The request carries ordered question text, option labels, and an optional
   multi-select flag; the renderer adds a custom text-input option and shows one
   question at a time.
3. Skip and decline resolve to `null`, answers carry selected labels and custom
   text, and there is no timeout.
4. Resolved values become tool content: `question：answer` per line, `\n---\n`
   between questions, empty for null answers.

Question and option text may use CommonMark or GFM, projected as safe phrasing
content; selection and tool output keep the normalized source strings.

## Consequences

- The model receives a compact, deterministic tool result.
- The wait sits outside host permission policy and cannot grant a capability.
- Aborting a turn completes the pending call with skipped values.
