# ADR 0380: The agent writes its own memory as a flat entry list

- Status: Accepted
- Date: 2026-11-04
- Amends: the "later stages" table in `docs/spec/03-runtime/21-memory-store.md`
  (it keeps the scored store, its decay and its retention rules)
- Related: [ADR 0371](0371-memory-store.md), [ADR 0234](0234-project-owned-memory-context.md),
  [ADR 0377](0377-skill-learning-in-core.md)

## Context

The first memory design was a scored, scoped, searchable store: a `memories`
table with `kind`, `scope`, `confidence`, supersession, FTS recall, confidence
decay and a retention pass, written by a `Remember` tool that took one memory per
call, and — as "stage 2c" — by an automatic extraction pass after every turn.

That shape did not survive contact with the part that matters: the notes are the
model's own working record, and the model can only curate what it can read and
rewrite directly. A scored record the agent appends to and hopes recall finds
later is not a note file. Stage 2c never landed either, because a per-turn
extraction pass needs a provider/model and a budget decision from the product
owner, and nobody owns it.

The reference implementation (Hermes) takes the simpler shape: a short flat list
of declarative facts, the whole list in the system prompt, edited in place by the
model through its own tool.

## Decision

Agent memory is **two flat entry lists**, not a scored record store:

- `memory` — the agent's own notes about how a project works, what failed and
  why, decisions and their reasons.
- `user` — who the user is: preferences, language, role, standing instructions.

| Property | Value |
| --- | --- |
| Budget | hard, whole-store: `MEMORY_CHAR_LIMIT` 2 200 / `USER_CHAR_LIMIT` 1 375 |
| Injection | one snapshot frozen at session start; a write this session is visible from the **next** session, and the tool echoes the new list so the model is never editing a document it cannot see |
| Editing | the agent's own `memory` tool: `add` / `replace` / `patch` / `remove` / `batch` |
| Where the semantics run | the runtime (`memory-store.ts`): which entry did the model mean, and does the batch fit the budget |
| Host surface | `memory.entries` (read) and `memory.writeEntries` (one atomic whole-list write per call) |
| Recall | unchanged: a bounded per-turn block injected into the **user** message, never the system prompt |

Two things are retired by this decision:

- The **automatic extraction pass** after a turn. Memory is written while the
  turn still holds the context, by the agent, not reconstructed later by another
  model reading a transcript.
- The **`Remember` tool**. Nothing declares it any more (the RPC and its body
  remain in host-core for the store they belong to).

## Recorded gaps

These are known and deliberately written down rather than left to be rediscovered:

1. **Recall still reads the scored store.** The per-turn recall path queries
   `memories` (the ADR 0371 store), which nothing writes any more, so a note the
   agent writes reaches the next session through the prompt snapshot but **not**
   through per-turn recall. Pointing recall at the entry lists — or retiring the
   scored store — is a separate change with its own compatibility question
   (project-scoped memory, ADR 0234, still lives there).
2. **The entry store was undocumented.** `docs/spec/03-runtime/21-memory-store.md`
   described the scored store only; its §9 now describes the entry lists the
   agent actually writes.

## Consequences

- The only cap is the budget, and the model owns it: `batch` applies several
  operations against the *final* size, so pruning stale entries and adding new
  ones is one call, and a refused write lists the current entries so the model
  can fix it in the same turn.
- An entry is a line of text, not a record with confidence, scope or provenance.
  Project-scoped knowledge belongs in project memory (ADR 0234) or in a skill;
  a durable fact about the user belongs in `user`; everything else is a note.
- Retention (`memory/tidy.rs`, stage 2b) is unaffected: it still runs on the
  scored store at most once a day, and it never touches entry lists.
- A session cannot yet rely on recall surfacing what it wrote earlier in the same
  session — the snapshot is frozen, and gap 1 means recall sees a different store.
