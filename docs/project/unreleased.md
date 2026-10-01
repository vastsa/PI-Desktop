# Unreleased changes

- `/compact` and automatic context compaction work again on a gateway that
  fronts a Codex backend. The summary request of a checkpoint now carries the
  conversation identity every other turn of the session sends
  (`prompt_cache_key`), instead of being the one request the gateway answers
  with `400 invalid codex request`.

- Claude models on a GitHub Copilot account no longer fail with "missing
  required Authorization header". Their Anthropic Messages requests now
  authenticate with `Authorization: Bearer` instead of sending the Copilot
  token as `X-Api-Key`.

- Google Gemini rows send requests again. A provider row on the native
  generative-AI endpoint no longer hands pi-ai's Google adapter the internal
  response-capture `fetch` it refuses before the request leaves, custom provider
  headers still reach Google, and an adapter refusal now fails the turn instead
  of spending all ten transient retries on it (issue #1072).

- Deleting a provider no longer leaves a dangling image-generation default.
  An image default or marked candidate whose provider row is gone is dropped
  on the next settings read or write, instead of staying stored as a binding
  every generation request rejects as an unavailable model.

- Subagent topology cards and their live process rows now follow the main
  conversation's responsive width behavior: long descriptions, paths,
  commands, and summaries wrap inside the dock instead of requiring repeated
  divider dragging to read them.

- Resuming a subagent no longer selects another definition's private model
  binding. On-demand delegation permissions are checked again on the next parent
  turn, so revoking automatic delegation takes effect without restarting the runtime.
- Trusted extension cancellation now retires SDK commands, tool updates,
  subprocesses and queued or visible prompts. Late hook payload mutations are
  isolated; legitimate long commands and tools retain their runtime budget.

- Copy individual Markdown tables, download them as CSV, or expand them for
  reading without leaving the conversation.

- A stored hosted web-search record that cannot be replayed no longer fails every
  later request in that conversation: the message continues without search replay,
  so histories written before the contract change stay usable.

- Hosted web search now has a complete replay and estimation contract, including
  tool/Task continuation and restart recovery. Context rebuilding preserves
  system-prefix semantics, and structured local preparation failures no longer
  masquerade as retryable provider failures. Existing search histories need no migration.

- Trusted extension startup, shutdown, and notification handlers now have
  bounded waits. Stop cancels pending hook waits before a model request, and
  disposal ignores late results and runs shutdown once. Deferred event
  registrations now appear in plugin diagnostics.

- The Composer reasoning slider now moves smoothly to clicked or
  keyboard-selected levels, follows dragging immediately, and respects
  reduced-motion settings. Rapid clicks redirect the animation; failed saves
  restore the confirmed selection. Opening the menu no longer leaves a
  press-animation offset that jumps on the first selection.
- The reasoning slider's filled track covers the entire starting dot, so
  its left cap no longer leaves a gray half-dot exposed.
- Hovering a reasoning stop or its label highlights the corresponding label.
  Only unfilled dots brighten and enlarge; filled dots and the current thumb
  keep their appearance.
- OpenAI Codex OAuth models can now opt into provider-hosted native web search.
  The feature remains off by default and search history is replayed only for
  the same Codex model.

- A Live Voice call bound to a work session now shows a waiting request instead
  of only saying it must be handled on the desktop: the compact bar keeps a
  waiting line, and Call Details shows the question, the tool awaiting
  permission, or the plan awaiting approval together with an action that opens
  that exact session. The decision itself still belongs to the session's own
  card, so answering or approving from the call remains impossible.

- A Live Voice work call can now answer the bound session's open AskTool
  question by voice: the question and its own options are read out, and the
  spoken answer may only select among those options. Permission, Plan, and Goal
  approvals remain desktop decisions, and an answer that does not match an
  offered option (or a session without exactly one open question) is refused
  and sent back to the card instead of guessing.

- Reloading the desktop renderer no longer drops the AskTool and permission
  cards a session is still waiting on: the pending interactive requests are
  read back from Host state and the cards come back.
