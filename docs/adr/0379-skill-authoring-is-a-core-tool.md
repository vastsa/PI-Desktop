# ADR 0379: Skill authoring is a core tool

- Status: Accepted
- Date: 2026-11-04
- Amends: ADR 0377 — it keeps the review loop and the single store, and replaces
  that ADR's "the `skill_manage` tool is not ported" clause.
- Related: [ADR 0371](0371-memory-store.md), [ADR 0377](0377-skill-learning-in-core.md)

## Context

ADR 0377 moved skill learning into core and deliberately did **not** port the
plugin's `skill_manage` tool. The stated reason was that the loop is fully
automatic, so the agent does not need a way to manage the library by hand.

The background review is a good backstop and a poor primary writer. It runs
after the turn is persisted, at best one pass per session every 120 seconds, and
only for a turn that ran at least three tools. What it produces is a
*reconstruction*: a cheaper model reads the transcript and guesses which part of
the work was reusable. The knowledge the agent actually held — the flag that
mattered, the command that failed first, the decision and its reason — is
second-hand by the time the review sees it.

Hermes, the reference implementation, gives the agent the pen. The model records
what the turn taught while it still has the context, and a background pass exists
beside that, not instead of it.

## Decision

`skill_manage` is a core tool, offered in Agent mode, with Hermes' five actions
mapped onto the host RPCs the library already exposes:

| action | host RPC | notes |
| --- | --- | --- |
| `create` | `skills.create` | name + description + body; a duplicate name is refused so the model patches instead |
| `patch` | `skills.read` + `skills.update` | `old_string` must occur exactly once; matching runs in the runtime, which is where the tests are |
| `write_file` | `skills.writeFile` | writes `references/<topic>.md` beside `SKILL.md` |
| `remove_file` | `skills.removeFile` | **new RPC**; removes one reference, never the document |
| `delete` | `skills.remove` | removes a whole skill |

Two things this ADR does **not** change:

- **The read path.** The catalog already lists the user's own skills beside the
  plugin-taught ones (`activeUserSkills`), and the `Skill` tool already loads a
  user document by id before falling back to a plugin. No second index, no second
  loader, no second prompt section.
- **The write path's owner.** Every action is an RPC. Nothing in the runtime
  touches the filesystem, so the store keeps one writer and one path rule
  (`references/<name>.md`, validated host-side).

## Consequences

- The library now has two writers — the turn-time tool and the background review —
  and they cannot corrupt each other: both go through `skills.*`, and a review
  pass never rewrites a document the tool just patched without reading it first.
- A skill written during a turn is listed in the system prompt from the **next**
  session: the index is a frozen snapshot, the same way memory is. The tool's own
  result reports what it changed, which is what keeps the frozen index usable
  mid-session.
- The quality bar is the single constant the review already uses
  (`SKILL_AUTHORING_GUIDE`), so "a thin draft is a prompt problem, not a store
  problem" stays true for both writers.
- `remove_file` is scoped to `references/`; deleting the skill itself stays
  `delete`, so a resource path can never take the document with it.
- An image of the library is not re-derived by hand: `skill_manage` reports the
  id the host returned for `create` (a slug of the name), because the host owns
  id derivation.
