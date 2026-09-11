# ADR 0149: Keep composer drafts for the renderer lifetime

- Status: Accepted
- Date: 2026-09-04
- Related: ADR 0137, decision D288, E2E-011c

## Context

Composer text and file-reference snapshots are keyed by session, but the cache
lives inside one `Composer` React instance. Route changes and empty/transcript
layout transitions can unmount that instance, discarding every unsent draft
even though the renderer process and its sessions remain alive.

## Decision

1. Keep the session-keyed `ComposerDraftSnapshot` cache at module lifetime in
   the renderer rather than inside one component instance.
2. A Composer restores its current key when it mounts and snapshots its live
   text and file references when it unmounts. Session switches retain their
   existing save/restore path.
3. Do not serialize the draft on every keystroke. Live refs supply the latest
   values at switch and unmount boundaries.
4. Successful dispatch clears only the submitting key, including asynchronous
   completion after navigation. Failed dispatch retains the draft, and deleted
   sessions are pruned.
5. Drafts remain renderer-memory-only. This decision adds no host schema, IPC,
   localStorage, restart restoration, or prompt-content persistence.

## Consequences

- Unsent text and file-reference chips survive session, project, empty-state,
  and route navigation for the lifetime of the renderer process.
- A renderer reload or application restart still clears every unsent draft.
- Existing smart-stop snapshots and queued prompts remain separate because they
  represent submitted content rather than an active editor draft.
- The measured typing path keeps its no-per-keystroke-serialization property.

## Alternatives rejected

### Persist drafts in host storage or localStorage

Rejected because route navigation only requires renderer-lifetime ownership.
Persisting prompt text introduces privacy, retention, scratch-reference, and
schema concerns outside this fix.

### Update the cache on every keystroke

Rejected because the existing typing path deliberately avoids per-keystroke
serialization. Live refs plus switch/unmount snapshots preserve the behavior
without restoring that cost.

## References

- `apps/desktop/src/components/Composer.tsx`
- `apps/desktop/src/components/ChatSurface.tsx`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
