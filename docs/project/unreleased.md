# Unreleased changes

- Resuming a subagent no longer selects another definition's private model
  binding. On-demand delegation permissions are checked again on the next parent
  turn, so revoking automatic delegation takes effect without restarting the runtime.
- Trusted extension cancellation now retires SDK commands, tool updates,
  subprocesses and queued or visible prompts. Late hook payload mutations are
  isolated; legitimate long commands and tools retain their runtime budget.

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

## Project memory

- Enable automatic recording per project to let the agent remember durable
  preferences or corrections during chat, with no background extraction model.
- Manage all saved notes in one list without source categories. The user and
  agent work on the same project memory, protected against stale writes.
- Turning recording off stops agent writes but keeps existing memory available
  in chats. Users decide what to edit or delete. Cancel discards note drafts;
  the recording switch takes effect immediately.
- All notes follow the existing project-memory configuration-sync rules,
  including notes recorded by the agent. Recording permission is local opt-in.

These changes are not part of a released version yet. The in-app changelog
continues to list only shipped releases.
