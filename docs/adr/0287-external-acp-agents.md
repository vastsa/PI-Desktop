# ADR 0287: external ACP agents as a second session backend

- Status: Accepted
- Date: 2026-09-25
- Related: `packages/acp-client`, `packages/racp` (ADR 0285),
  `packages/agent-runtime`, `packages/host-runtime`

## Context

Every turn in the desktop app runs on the app's own agent stack: a provider row
from SQLite becomes a pi-ai `Model`, and `streamSimple` drives it. There is no
seam for a session whose backend is somebody else's program.

That excludes a real category of setup. An agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) over stdio — `opencode
acp`, and the ACP builds of other agents — owns its own models, its own
credentials and its own provider catalogue. The host should not have to
replicate any of that to use it. Zed, JetBrains and Avante.nvim already connect
to agents this way.

There is a second reason that matters for this app specifically. Some model
endpoints gate free tiers on the calling client, and a host that re-implements
an agent's request shape by hand will keep losing that gate. Speaking the
protocol lets the agent make its own calls instead of the host guessing at
them.

## Measured protocol surface

The contract below was taken from a live `opencode acp` v2.0.15 handshake on
this machine, not from the protocol draft. Two details are load-bearing and are
the kind of thing a draft-based implementation gets wrong:

- Session settings are written with **`configId`**, not `optionId`. The draft's
  spelling returns `-32602 Invalid params` with
  `data.configId._errors: ["Invalid input: expected string, received undefined"]`.
- `session/new` already carries the agent's whole model picker in
  `configOptions`, so the host does not need a separate catalogue source.

Client → agent: `initialize`, `authenticate`, `session/new`, `session/list`,
`session/load`, `session/resume`, `session/close`,
`session/set_config_option`, `session/prompt`, `session/cancel`.

Agent → client: `session/update` (notification), `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`, and terminal methods the desktop
host does not implement yet.

A turn is one long-lived `session/prompt` request. `session/update`
notifications stream alongside it — `agent_message_chunk`, `agent_thought_chunk`,
`tool_call` / `tool_call_update`, `plan`, `usage_update`,
`available_commands_update`, `current_mode_update` — and the request resolves
with a `stopReason` and a usage block. Updates are filtered by `sessionId`, so
concurrent sessions never cross-talk.

## Decision

1. **`packages/acp-client` owns the protocol, and nothing else.** It is a
   dependency-free client: JSON-RPC framing, request correlation, the update
   queue, and the agent → host dispatch. It knows nothing about pi-ai, about
   the renderer, or about the database.

2. **The transport is injected.** `AcpClient` takes a spawner;
   `spawnAcpProcess` is the node implementation. Session and streaming logic
   are therefore testable against an in-memory transport, and the same suite
   runs one integration case against a real agent.

3. **`prompt()` is an async generator of `session/update`.** The turn's
   lifetime is the generator's lifetime: it ends when the agent answers and
   throws when the turn failed. Walking away from the generator early is not an
   error — a cancelled turn is a normal outcome.

4. **The host answers the agent's callbacks, not the reverse.** File reads and
   writes go to the host's own filesystem layer, and `session/request_permission`
   goes to the existing approval dialog. An unimplemented callback answers
   `-32601` rather than leaving the turn hanging.

5. **The agent's own identity is its own.** The host does not restate or
   override the agent's `User-Agent`, `x-opencode-client` or
   `x-opencode-session`. Those are the agent's to send, and the app already
   injects its own identity for its own requests
   (`packages/agent-runtime/src/opencode-session-headers.ts`). Per-provider
   custom headers stay a provider-row feature and are not reused here.

6. **The host discloses the access model and asks once; it does not pretend
   to mediate it.** An external agent runs with the project folder as its
   working directory and edits that folder with its own tools. That is
   measured, not assumed: `packages/acp-client/scripts/acp-tool-probe.ts` asked
   a live `opencode acp` to create and read back a file and counted the client
   callbacks — `read=0 write=0 permission=0`, while the file was created. The
   agent never asks, so a host-side `request_permission` refusal gates nothing.

   The first wiring refused every `request_permission` and described that as
   failing closed. That was the wrong shape: the refusal implied a control the
   host does not have, while the agent went on writing to the project. The
   refusal stays as the default answer for an agent that does ask — nothing
   about that behaviour changes — but the section no longer claims to be a
   boundary. The control the host can actually exercise is the one it always
   had: the user is told what the agent can reach, and the row cannot be saved
   until they say they understand. Consent is dialog state and is not stored,
   so it is re-given when the row is edited rather than outliving the decision
   it recorded; changing the command drops it, because consent was given for
   one program.

## Consequences

- The package is reusable for any ACP agent, so the feature is not a
  vendor-specific integration.
- A turn driven by an external agent is not identical to an app-native turn:
  the host observes messages, tool calls, plans and usage, but the agent
  decides model, provider and prompt assembly. The UI has to say which
  backend produced a transcript.
- The agent process is long-lived and its death is visible to the user. Startup
  and crash handling are part of the wiring work, not an afterthought.

## Wiring checklist

The protocol layer is done and proven against a live agent. What remains is
joining it to the app, in this order. Each step is independently shippable.

1. **Agent settings.** A service row that stores a command and args instead of
   a base URL. `validateAcpAgent` is the gate: blocking errors stop the save,
   shell warnings are shown next to the field. The stored row keeps the
   provider table's shape so nothing else has to learn a new table.

2. **Model catalogue.** `session/new` returns `configOptions` with the agent's
   own model picker. The composer menu should read that instead of a static
   list, and the selection is written back with
   `session/set_config_option` (`configId`, not `optionId`). A backend of this
   kind therefore contributes no rows to the model-catalog tables.

3. **Turn execution.** One turn is one `session/prompt` request with
   `session/update` notifications streaming beside it. The generator ends when
   the agent answers. Breaking out early is a cancel, not an error.

4. **Event translation.** `agent_message_chunk` and `agent_thought_chunk`
   become message parts; `tool_call` / `tool_call_update` become the tool-call
   shape the transcript already renders, keyed on `toolCallId`. An ACP `plan`
   is rendered as assistant content, not as `planning_state`: that event
   describes a host-owned *proposal* the approval flow acts on, and mapping a
   narration onto it would fabricate a proposal the host never made. `usage`
   lands on the closing assistant message. Unknown `sessionUpdate` values are
   ignored rather than fatal — agents will add variants, and a transcript that
   drops an unknown block beats a turn that dies on it.

5. **Permissions and files — disclosed, not mediated.** The pi runtime does not
   mediate its own tool calls: they go through host-core, which owns the
   permission decision and the containment rules. An external agent runs its
   tools inside its own process with the project folder as its working
   directory, so host-core cannot sit in that path and the host cannot allow or
   deny any of it. `request_permission` still answers "cancelled" when an agent
   asks, and `-32601` on the file callbacks keeps a turn from hanging, but
   neither is a boundary — an agent that ignores the callback is unaffected.

   So the wiring states the access model in the section itself and requires an
   explicit acknowledgement before the row saves, rather than implying a
   mediation that does not exist. The remaining gap is that nothing repeats
   this while a session runs: the UI still does not say which backend produced
   a transcript. That is the next piece, and it belongs in the chat surface
   rather than in Settings.

6. **Process lifecycle.** One long-lived process per agent, started lazily on
   first use. On exit, reject in-flight turns, mark the agent offline in the UI, and
   offer a restart. A dead agent must never look like a hung turn.

7. **Identity.** The app keeps its own `User-Agent`, `x-opencode-client` and
   `x-opencode-session` for its own requests. It does not restate or override
   them for an external agent: those headers are the agent's to send, and
   `opencode acp` sends its own.

## Status

Shipped for text turns. The chain is in place and verified end to end, not only
unit tested:

- `packages/acp-client` — protocol client, executable resolution, event
  translation, session runtime. Unit tests cover the framing, the streaming
  queue, cancellation, concurrent sessions and the translation contract.
- `packages/agent-runtime/src/sidecar.ts` — `agent.*` dispatch resolves a
  second backend. The pi map is untouched; every ACP entry point is an explicit,
  greppable branch. pi-only features (`compact`, `steer`, `asktool`,
  approved plans) answer `UNSUPPORTED_FOR_BACKEND` rather than pretending.
- `crates/host-core` — the agent definition lives on the provider row in
  `config_json.acp`, read and written alongside headers and models.
- `apps/desktop` — an advanced section in the provider dialog, translated in
  all ten locales. The row cannot be saved until the user acknowledges what the
  agent can reach, and the acknowledgement is dropped when the command changes
  (`apps/desktop/src/components/settings/acp-draft.ts`,
  `apps/desktop/test/acp-agent-consent.test.mjs`).

Two integration checks drive the real processes:

```
pnpm -C packages/agent-runtime bundle
node packages/agent-runtime/test/acp-sidecar-smoke.mjs
node packages/host-runtime/test/acp-provider-roundtrip.mjs
```

The first spawns `opencode acp` through the bundled sidecar and asserts a
complete turn (`message_start` … `agent_end`) on a free contributor model. The
second writes and clears a provider row against a throwaway data directory.

## Two things this design had to get right

**Clearing the agent.** `Option<Option<T>>` does not work: serde maps a JSON
`null` to `None`, so "not supplied" and "remove it" become indistinguishable and
a provider could never stop being an agent. host-core clears on an **empty
command** instead, matching how an empty header map clears headers, and the
Electron IPC layer translates the dialog's `null` into that shape. The
round-trip test is what caught this; the sidecar test passed throughout because
the two live in different processes.

**Streaming is not a snapshot.** ACP streams deltas while `message_start`
wants a full `UiMessage`, so the translator is stateful: it opens a message
empty and delivers the first chunk as a delta, keyed on the agent's own
`messageId`. Getting the id off the content block instead of the update turns
one reply into one transcript row per chunk.
