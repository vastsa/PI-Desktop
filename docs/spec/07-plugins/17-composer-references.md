# Composer completion and reference contracts

## Scope

This contract implements slots 7 and 14 of issue #545 through a trusted
`renderer` entry. See [the architecture decision](../../adr/trusted-renderer-composer-references.md).
Other renderer component slots are outside this contract.

## Entry and trust

`renderer` is an optional package-relative path to a self-contained ES module
exporting `default(api: PiRendererApi)`. Activation may return a disposer.
The entry derives a high-risk `ui.renderer` grant; installing, updating or
reloading a plugin must review any newly requested trust. A missing grant means
no renderer entry is exposed. Source is limited to 1 MiB, and symlink escapes
are refused. Only enabled plugins active in the current project load.

The API has an abort signal. Disable, unload, entry replacement, project change
and renderer shutdown abort activation and dispose all registered providers.
Activation is bounded to five seconds. The host cannot preempt synchronous code
running in its own realm.

## Completion providers

`composer.registerCompletion(id, provider)` registers one punctuation trigger,
static `items`, optional asynchronous `search(query, signal)`, `resolve`, and
optional `onRemove`. It returns an unregister function.
`composer.updateCompletion(id, items)` replaces pushed candidates.

Built-in `@` and `/` sources remain available. Slash commands precede plugin
references; the reference menu places plugin candidates before the Files group.
Plugins cannot remove built-ins or change command argument grammar.
Reference menus show at most five plugin candidates, followed by a collapsed Files
group. Clicking the group or selecting it with the keyboard toggles the matching
file candidates without changing the draft. A new trigger resets the group to
collapsed. Typing filters all candidates before the plugin display limit applies.
Other triggers have a single owner, first registration wins. A conflict leaves
the previous provider intact and appears in the plugin's diagnostics.

The host performs local fuzzy matching. Remote search has a 1.5-second deadline;
failure preserves pushed local candidates. Stale queries and IME composition
cannot overwrite a newer result.

## References

Candidates carry `{ refId, label, description? }`. Active insertion uses
`composer.reference.insert(providerId, reference)`. Both entry points share
host-owned inline chips, per-plugin identity deduplication, and deletion
notifications. Re-insertion selects the existing chip. Drafts retain identity
through session switching, remounting and rejected sends. At most 64 plugin
references can be inserted into one draft.

On submission the host calls each resolver once, independently, with a five-second
asynchronous deadline. Results contain `text` and optional existing file/image
attachment descriptors. At most 64,000 characters of reference text and 32
plugin-provided attachments are accepted per message; invalid results fall back
to their label. File and image permissions remain enforced by the ordinary
attachment resolver. Expansion occurs at enqueue time so queued turns have a
stable snapshot.

`content` remains model-facing. Optional `composerDisplay` contains the visible
text and validated reference spans. User transcripts show those chips and copy
the visible text; plugins need not remain installed to read old labels. Queued
turns preserve the metadata across restart. Inline transcript editing starts
from visible text, so editing a sent reference makes it literal text.

Native Pi continuation and remote-host submissions currently reject references
and restore the draft rather than losing display metadata.

## Session-reference example

`examples/plugins/session-references` registers `@`. Session titles are read for
candidates; `session.readSelected` is available during resolution of that selected
session ID. This is an SDK access discipline, not an isolation boundary for
trusted same-realm code.

The example reads at most 400 recent messages, with 16,000 characters per message,
and includes up to ten completed parent Q&A turns within 24,000 characters.
Thinking, tools, delegate messages, incomplete answers and nested expansions
are excluded. The text explicitly identifies the excerpt as bounded historical
reference material. This example does not implement the percentage budget UI
proposed in PR #447.
