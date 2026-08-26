# Composer Prompt Enhancement

## 1. Scope

The prompt-enhancement capability supports a one-shot `Enhance prompt` request
for a non-empty draft. The Composer renders it as a standalone Sparkles action
between the combined model × reasoning selector and the single Stop/Send
submit slot. When invoked, the request rewrites only the draft text with the
model currently displayed in the Composer. File-reference chips remain
unchanged.

This is a v1 utility action, not an agent turn: it does not append a message,
read session history, run tools, or persist a transcript row.

## 2. Availability and interaction

The Sparkles action is enabled only when all of the following are true:

- the draft is non-empty after trimming;
- the effective displayed provider/model is enabled and authenticated, using
  the same readiness predicate as Send; and
- the trimmed draft does not start with `/`.

While the request is running, the action is disabled and shows the shared
`.tool-spinner` plus the localized `Enhancing…` label. Sending remains allowed.
The Composer sends `providerId`, `modelId`, and `thinkingLevel` from the
currently displayed model selector; main validates those values and falls
back through session, draft, global, and provider defaults when a snapshot is
missing or stale.

On success, the trimmed result replaces the text, the caret moves to the end,
and a single `Undo enhancement` action restores the exact pre-enhancement text.
Any user edit, send, or Composer session switch clears the undo action.
There is no multi-level history, keyboard shortcut, or cancel action.

## 3. Request and provider boundary

Renderer requests use the allowlisted `pi-desktop/prompt/enhance` invoke
channel. Electron main resolves the effective provider/model through the same
runtime launch resolver used for agent turns, reads API credentials only in
main, and invokes agent-runtime's one-shot completion helper. Vendor OAuth
providers receive a short-lived `ModelAuth` through the existing main-owned
resolver; no key or refresh token crosses into the renderer.

The completion context contains exactly:

1. the static `PROMPT_ENHANCEMENT_SYSTEM_PROMPT` from
   `packages/agent-runtime/src/prompt-templates.ts`; and
2. one user message, `Draft:\n<draft>`.

No prior conversation, tools, attachments, or configurable template are
included. The selected thinking level is passed to pi-ai, and provider setup
retries use the existing bounded retry controller. Model output is consumed as
plain text and trimmed. Empty or whitespace-only output is a
`PROMPT_ENHANCEMENT_EMPTY` failure.

## 4. Failure and race handling

Failures preserve the current draft and render a dismissible Composer error
bar containing the classified error message and code. Existing provider codes
such as `PROVIDER_UNAUTHORIZED`, `NETWORK_ERROR`, and `TIMEOUT` are reused.

The renderer captures the draft key and an edit generation when starting a
request. If the draft changes, is sent/cleared, or the user switches sessions
before the response arrives, the response is discarded and cannot overwrite
the newer draft. File chips are not included in the rewrite and are not
removed by success or failure.
