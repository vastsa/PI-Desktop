# Composer Prompt Enhancement

## 1. Scope

The prompt-enhancement capability supports a one-shot `Enhance prompt` request
for a non-empty draft. The Composer renders it as a standalone Sparkles action
between the combined model × reasoning selector and the single Stop/Send
submit slot. When invoked, the request rewrites only the draft text with the
model currently displayed in the Composer. Inline file-reference chips,
including pasted image chips, remain unchanged and do not disable the action.

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

The completion context is a system prompt plus one user message. Both come from
templates that default to `packages/shared/src/prompt-enhancement.ts` and can be
overridden in Settings (see §5). The user template carries a `{{draft}}`
placeholder; every occurrence is replaced with the draft text, and the default
template keeps the draft inside `<draft>` tags so draft text reads as content
to improve rather than as instructions. The default system prompt states the
role, the rewrite principles, an explicit do-not list (including leaving code,
commands, file paths, identifiers, and other proper nouns exactly as written),
language-following rules that forbid language meta notes, a length brake, and
the output contract.

No prior conversation, tools, attachments, or session state are included. The
renderer removes its inline file-reference chip tokens before the request and
restores those chips in their original order and relative position after the
text response; the model is not trusted to preserve opaque renderer sentinels.
The selected thinking level is passed to pi-ai, and provider setup retries use
the existing bounded retry controller. When the resolved provider is OpenCode Go
(or another `opencode.ai` host), the one-shot forwards the Composer session id
as `x-opencode-session`; a request with no session gets a per-call id. Model
output is consumed as plain text, has one matching pair of wrapping quotation
marks removed, and is trimmed. Empty or whitespace-only output is a
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


## 5. Configurable templates and enhancement model

Settings → AI hosts a Prompt enhancement card controlling four `AppSettings`
fields:

| Field | Effect when empty |
|---|---|
| `promptEnhancementSystemPrompt` | the built-in system prompt |
| `promptEnhancementUserTemplate` | the built-in user template |
| `promptEnhancementProviderId` + `promptEnhancementModelId` | follow the Composer's current model |

Each template field shows the built-in default when no override is stored, so
the value on screen is the value in force, and `Restore all defaults` clears
both overrides in one write. Editing a field back to the exact default text also
clears the override rather than storing a frozen copy, so later improvements to
the defaults still reach users who never customized them. Never persisting the
default text is deliberate.

The user-template field offers an insert action that writes the draft variable
at the caret, and a save that would leave the template without it is refused
locally with a message. host-core enforces the same rules for any writer:
`promptEnhancementUserTemplate` must contain `{{draft}}` when non-blank, each
template must be a string within `PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH`, and a
blank value is stored as absent rather than as an empty string.

When `promptEnhancementProviderId` is set, main prefers that pin and logs a
warning plus falls back to the Composer's current model if the pin cannot be
resolved. A pinned model is a preference, so a stale pin never disables the
action.
