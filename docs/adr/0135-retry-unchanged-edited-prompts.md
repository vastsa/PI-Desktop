# ADR 0135: Retry unchanged edited prompts

- Status: Accepted
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Related: D137, D274, E2E-073, issue #23
- Amends: D137

## Context

The user-message editor is an edit-and-resend workflow, but its primary action
was labeled Send and treated an unchanged prompt as a no-op. That made a
confirmation with the original text appear broken even though the user had
explicitly asked to replay the selected turn.

## Decision

1. Confirming a valid user-prompt edit always dispatches the existing
   `editUserMessage` / Regenerate path, whether or not the trimmed prompt text
   differs from the original.
2. The inline primary action is localized as Retry (`重试` in zh-CN); its
   in-flight label is Retrying… (`重试中…`).
3. Retry retains the existing attachment handling, slash-command expansion,
   identity-based truncation, and D109 revision archive.

## Consequences

- Replaying an unchanged prompt creates a fresh assistant turn and archives the
  replaced answer tail in the existing revision pager, matching the action's
  resend semantics.
- The inline labels distinguish retrying the selected turn from sending a new
  composer prompt and from cancelling the edit.
- A user can still abandon the edit without changing the transcript through
  Escape or Cancel.

## Alternatives

### Keep unchanged edits as a no-op

Rejected. It is the behavior reported in issue #23 and makes an explicit resend
confirmation appear inert.

### Keep the primary label as Send

Rejected. The action does not append a new ordinary prompt; it replays the
selected prompt through the Regenerate path.

## References

- `apps/desktop/src/components/ChatTranscript.tsx`
- `packages/i18n/src/locales/en/index.ts`
- `packages/i18n/src/locales/zh-CN/index.ts`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-073)
- `docs/spec/08-meta/decisions-log.md` (D274)
