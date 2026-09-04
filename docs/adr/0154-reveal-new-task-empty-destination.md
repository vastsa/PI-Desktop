# ADR 0154: Reveal the New Task empty destination before host IO

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D252, D305, ADR 0113, ADR 0137, E2E-011a, E2E-011d, E2E-011g

## Context

ADR 0113 made New Task persist a durable empty session (or reuse the group's
latest empty row). The renderer implemented that by awaiting `session.list`,
then `session.create`, then another `session.list`, then `session.get` before
changing the visible transcript. During that chain the previous conversation
stayed on screen: a cold-switch rule (ADR 0137) is correct for opening an
existing session, but for a brand-new empty destination it felt like the click
did nothing, then the chat jumped.

`session.list` was there so a first message sent moments earlier would not be
mistaken for an empty slot while `messageCount` was still 0. The renderer
already knows that case: the session is running, has live rows, or has a
submitted composer draft.

## Decision

1. **First-frame empty reveal.** Creating a session clears the previous
   transcript and retained panes synchronously, before `session.create`. The
   empty home composer is the destination. Reusing an empty slot commits an
   empty transcript on the same frame rather than waiting for `session.get`.
2. **Reuse without a list refresh.** New Task decides from the in-memory
   session list plus renderer signals (`runningSessions`, live/cached rows,
   submitted drafts). Host `messageCount` remains the durable empty
   predicate; the in-memory signals only prevent treating a just-started
   turn as empty.
3. **Commit from `session.create`.** The created summary is inserted into the
   sidebar list the way a fork child is. There is no follow-up `session.list`
   or `session.get` for a new empty session: its transcript is known to be
   empty. A superseded navigation still records the row.
4. **One in-flight create per group.** Send and paste wait for the same-scope
   New Task promise instead of materializing a second session. Keystrokes
   typed on the empty home during create move onto the new session id.

Protocol, storage, and host RPC are unchanged. `session.create` remains the
source of the durable id.

## Consequences

- New Task no longer leaves the previous conversation on screen.
- Rapid New Task clicks and first-message races stay serialized per group.
- An empty reuse still revalidates through `selectSession` after the empty
  pane is already visible.
- Spec `04-ux/09-interaction-patterns.md` §1.6, `04-ux/08-component-spec.md`
  §11, E2E-011a / E2E-011d / E2E-011g; D305 amends D252's refresh-then-select
  timing, not the reuse rule.

## Alternatives considered

- Client-generated session ids on `session.create`: first-frame id without a
  home-draft interval, but an additive protocol field and remapping if an
  older host ignores it.
- Keep the previous pane with a progress track: that is the cold-switch rule
  for existing transcripts and is the hitch this request removes.
