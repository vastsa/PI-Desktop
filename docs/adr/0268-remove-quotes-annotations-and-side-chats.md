# ADR 0268: Remove quotes, annotations, and side chats

- Status: Accepted; supersedes ADR message-quotes-and-side-chats, ADR
  response-annotations, and ADR floating-annotation-index; amends ADR 0254
- Date: 2026-09-16
- Related: D097, D128, D134, D209, D254, D261, D301, ADR 0023, ADR 0254

## Context

Three renderer-owned surfaces grew around the transcript and composer: the quote action
with a selected-text overlay and docked side chats, the response-annotation attachment
sent to the model in a generated `# Response annotations:` block, and the floating
annotation index with badges, highlights, and a comment editor. Two of them recovered
excerpts from rendered DOM, annotations added a second prompt serialization every display
surface must reverse, and a side chat is a second session lifecycle whose only durable
artifact — the forked child — `session.fork` already produces, while copy, edit, fork,
and retry cover the rest.

## Decision

Remove **Quote**, **Annotate**, and **Open/Ask in side chat** from the message action row
while Copy, Edit and Delete, Fork, and Retry/Regenerate keep their place, behavior,
labels, and shortcuts. Remove the selected-text toolbar and composer quote prefill, the
comment editor, floating index, source badges and highlights, composer annotation chip,
annotation store slice, and anchor modules, so a `:codex-annotation{index="N"}` directive
renders as ordinary Markdown text. `api.prompt` and `enqueuePrompt` send the user's text
as written, with no `# Response annotations:` heading, instruction sentence, or
`<response-annotations>` payload, so an older stored prompt containing the block is shown
verbatim. Remove the side-chat draft lifecycle, the renderer projection, the `sidechat:`
work-panel tab type and `SideChatTab`, its registration, release, and cascade cleanup,
and the availability blocked-reason reporting, leaving `session.fork` with the Fork
action as its only entry point. Host protocol stays v11 and storage schema v15 — no new
IPC channel, permission, protocol or schema bump, and no Rust change — and the retired
identifiers that must never be reused are `D-LOCAL-message-quotes`,
`D-LOCAL-selection-overlay`, `D-LOCAL-response-annotations`,
`D-native-sidechat-stream`, `E2E-CHAT-quote-prefill`, `E2E-CHAT-selection-markdown`,
`E2E-CHAT-selection-side-chat`, `E2E-CHAT-annotation-attachments`,
`E2E-CHAT-annotation-session-state`, `E2E-CHAT-annotation-source-index`,
`E2E-CHAT-annotation-ack-and-steering`, `E2E-CHAT-side-chat-fork`,
`E2E-CHAT-side-chat-stream`, `E2E-CHAT-side-chat-add-to-main`,
`E2E-CHAT-side-chat-promote`, `E2E-CHAT-side-chat-close`, and
`E2E-SESSION-native-side-chat-fork-survives-close`, with the superseded ADR files kept as
history.

## Consequences

- Users lose quote reuse inside the composer and the side-chat panel, substituted by
  copy/paste or forking a session, and a stored annotated prompt shows the generated
  heading as plain text.
- D134 / `session.fork` still resolves a durable child from an anchor message, D209 /
  D301 keep draft restoration, and D097 / D128 / D254 / D261 keep work-panel role,
  sizing, identity keying, neighbor-close, and per-session switching; a session forked
  earlier from a side chat stays an ordinary session.
- The renderer sheds renderer-only code and tests, and nothing crosses a process
  boundary.

## Alternatives

- Hide the entry points and keep the code: dead branches would still own store slices,
  i18n keys, CSS, and the block parser.
- Turn side chats into a child-session tab: that is Fork plus the session list, keeping
  the lifecycle for a fourth route to the same child.
