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

The completion context is a built-in system prompt plus one user message built
from a user template. The template defaults to
`packages/shared/src/prompt-enhancement.ts` and can be overridden in Settings
(see §5). It carries a `{{draft}}` placeholder; every occurrence is replaced
with the draft text, and the default template keeps the draft inside `<draft>`
tags so draft text reads as content to improve rather than as instructions. The
system prompt is not user-editable and states the role, the rewrite principles,
an explicit do-not list (including leaving code, commands, file paths,
identifiers, and other proper nouns exactly as written), language-following
rules that forbid language meta notes, a length brake (do not expand beyond
roughly twice the draft's length; a long draft may stay long), and the output
contract.

No prior conversation, tools, attachments, or session state are included. The
renderer removes its inline file-reference chip tokens before the request and
restores those chips in their original order and relative position after the
text response; the model is not trusted to preserve opaque renderer sentinels.
The selected thinking level is passed to pi-ai, and provider setup retries use
the existing bounded retry controller. When the resolved provider is OpenCode Go
(or another `opencode.ai` host), the one-shot forwards the Composer session id
as `x-opencode-session`; a request with no session gets a per-call id. Model
output is consumed as plain text, has one matching pair of wrapping quotation
marks removed, has a leading rewrite label such as `Enhanced:` stripped, and is
trimmed. Empty or whitespace-only output is a `PROMPT_ENHANCEMENT_EMPTY`
failure.

The handler bounds one request with a 60-second ceiling. On expiry it aborts
the in-flight request (best-effort: the transport consults the signal between
provider retries) and races the promise so the caller is released. The action
fails with `TIMEOUT`. It does not silently retry on the session model: the user
chose the pinned model, and a hidden second attempt would double the wait.

## 4. Failure and race handling

Failures preserve the current draft and render a dismissible Composer error
bar containing the classified error message and code. Existing provider codes
such as `PROVIDER_UNAUTHORIZED`, `NETWORK_ERROR`, and `TIMEOUT` are reused.

The renderer captures the draft key and an edit generation when starting a
request. If the draft changes, is sent/cleared, or the user switches sessions
before the response arrives, the response is discarded and cannot overwrite
the newer draft. File chips are not included in the rewrite and are not
removed by success or failure.


## 5. Configurable user template, model, and reasoning

Settings -> AI hosts a Prompt enhancement card. One row carries a switch —
`Use a custom template` — and the settings icon button the subagent rows use for
editing, which opens an editor sheet. The sheet holds the user template and
saves on `Save`, so closing it abandons the edit; `Cancel` and `Escape` close it,
and a click on the sheet backdrop closes it only when no save is in flight.

| Field | Effect when off or empty |
|---|---|
| `promptEnhancementCustomTemplate` | the built-in user template applies |
| `promptEnhancementUserTemplate` | the built-in user template |

The switch is the gate, not the text, and it is enabled only once a usable
custom template exists. With no saved template it renders disabled with a hint
that saving one unlocks it, because it would otherwise choose between two
identical states. Saving a template turns the switch on, since the user just
wrote one.

Turning the switch off keeps `promptEnhancementUserTemplate`, so turning it back
on restores the user's text instead of discarding it. A stored template with the
switch off, or an enabled switch whose template cannot be found, both resolve to
the built-in template.

The system prompt is not editable and exposes no field. It is part of the
feature contract (proper-noun preservation, language following without meta
notes, the length brake, the output contract), so changing it is a source change
that updates this spec. host-core drops a stored system-prompt override written
by an earlier build, so the store cannot hold a value nothing reads.

The template field shows the built-in default text when no override is stored,
so the editor opens on the value in force. Editing the field back to the exact
default text clears the override rather than storing a frozen copy, so later
improvements to the default still reach users who never customized it. Never
persisting the default text is deliberate.

The field offers an insert action that writes the draft variable at the caret,
and a save that would leave the template without it is refused locally with a
message. host-core enforces the same rules for any writer: a non-blank
`promptEnhancementUserTemplate` must contain `{{draft}}`, the value must be a
string within `PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH`, and a blank value is
stored as absent rather than as an empty string.

### Enhancement model and reasoning

Which model runs the rewrite, and with how much reasoning, live on the same
Settings -> AI Prompt enhancement card as the template, as two rows below the
custom-template switch. The model row is titled `Default model` and uses the
same anchored, searchable menu as Settings -> Models' default-model row.

| Field | Effect when empty |
|---|---|
| `promptEnhancementProviderId` + `promptEnhancementModelId` | follow the Composer's current model |
| `promptEnhancementThinkingLevel` | `off` |

Both destinations therefore offer one kind of model picker. Both rows read
`Default model`; the card heading (Prompt enhancement vs Models Defaults) is
what separates the conversation's default from the enhancement's. When
`promptEnhancementProviderId` is set, the row still shows that pin even if the
provider is gone or disabled, with an unavailable hint. Main prefers the pin
and logs a warning plus falls back to the Composer's current model if it cannot
be resolved: a stale pin is a preference that cannot be honoured, never a
failure that disables the action.

The reasoning row lists the levels the selected model actually supports, using
the same resolution the Composer applies to a turn: the model binding's
`thinkingLevels`, then the live catalog, then the provider default. A model
without reasoning therefore offers only `Off (no reasoning)` and disables the
row, rather than presenting a ladder it cannot run. With no model pinned the
request follows the conversation's model, whose ladder is not knowable here, so
every canonical level is offered.

The row defaults to `Off`, with no follow-the-session option: the enhancement
never inherits the conversation's effort, because a rewrite rarely benefits from
reasoning and reasoning is the slow path. Changing the model re-clamps the stored
level onto the new model's ladder, and the value written is the clamped one, so a
stored level is always one the model can run. Round-tripping the displayed value
through the same resolver keeps the row and the store in step.
