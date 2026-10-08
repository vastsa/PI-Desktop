# Optional Composer Text Actions

## 1. Scope

Composer text transforms are opt-in plugin contributions. The host ships no
built-in prompt-enhancement action or settings card, and does not install the
prompt-enhancement plugin by default. Users install that plugin explicitly
from its separate repository or a configured plugin catalog.

A plugin declares one or more `contributes.composerTransforms` entries and the
`composer.transform` permission. Each entry supplies the action label and
optional undo label. The host shows actions only while the plugin is enabled,
loaded, and granted that permission. The plugin owns its transformation,
settings, and any model request it chooses to make.

## 2. Invocation and data boundary

The action appears in the Composer toolbar after the model selector. The host
invokes the declared plugin callback only after a user selects that action. The
callback receives `{ id, text, modelKey? }`: the draft text and, when available,
the current Composer model key. It receives no conversation history, session
identifier, attachment, or file path. The host strips inline file-reference
tokens before the call and restores those references after a successful result.

The transform is not an Agent turn: it does not send a message, run tools, or
write a transcript row. The callback must return a string. The host caps input
and output at 100,000 characters, applies the plugin-call timeout, checks the
permission and manifest declaration on every invocation, and audits success
and failure. A missing plugin, undeclared action, revoked permission, invalid
result, timeout, or unload leaves the draft unchanged.

On success, the returned text replaces the draft and the caret moves to its
end. One undo action restores the exact prior draft. Editing, sending, or
changing sessions invalidates the pending result and undo state. Unloading the
plugin invalidates a pending result. A late result cannot overwrite a newer
draft or another session's draft.

## 3. Prompt-enhancement plugin and settings migration

The standalone `pi.prompt-enhancement` plugin contributes the former
enhancement action. Its implementation and settings live in the plugin
repository; the host provides only the generic Composer transform contract.
Installing and granting the plugin is required before the action appears.

On the first load of this plugin, Electron copies valid legacy host preferences
to the plugin's private settings before the plugin's `onLoad` callback. Existing
plugin values win. The one-time migration maps the former model, thinking level,
and enabled custom template. Invalid or inactive templates are skipped. A
private migration marker prevents re-import after a user later clears a plugin
setting. The host leaves legacy values intact for rollback and downgrade
compatibility; they are not used by Composer or Settings after migration.

The migration does not run for other plugins and does not make the plugin
available by default. If the plugin is not installed, the host has no prompt
enhancement action or related settings UI.
