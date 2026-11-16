# ADR 0135: Retry unchanged edited prompts

- Status: Accepted
- Date: 2026-08-31
- Related: D137, D274, E2E-073, issue #23
- Amends: D137

## Context

The user-message editor is an edit-and-resend workflow, but its primary action
was labeled Send and treated an unchanged prompt as a no-op, so an explicit
request to replay a turn appeared inert.

## Decision

Confirming a valid user-prompt edit always dispatches the existing
`editUserMessage` / Regenerate path whether or not the text changed, with the
inline primary action localized as Retry and Cmd/Ctrl+Enter invoking it, while
Escape and Cancel keep their cancel behavior. Retry retains the existing
attachment handling, slash-command expansion, identity-based truncation, and
D109 revision archive, and adds no IPC, storage, host-protocol, or runtime
contract change.

## Consequences

- Replaying an unchanged prompt creates a fresh assistant turn and archives
  the replaced answer tail in the existing revision pager.
- The labels distinguish retrying a turn from sending a new prompt and from
  cancelling the edit.

## Alternatives

- Keep unchanged edits as a no-op: rejected, it is the behavior reported in
  issue #23.
- Keep the primary label as Send: rejected, the action replays the selected
  prompt through Regenerate rather than appending a new one.
