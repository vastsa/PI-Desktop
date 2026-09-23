# Permissions and automatic review

## Unreleased change

Permission review is independent of permission mode. The default is still
manual review. Existing conversations and native Pi sessions do not silently
enable an additional model call after upgrading.

Ask requests approval for gated actions. Accept edits automatically permits
ordinary workspace edits but still gates other actions. Auto skips approval
and automatic review; it is not a safer form of Auto review.

In Permissions settings, choose User or Auto review and either follow the conversation's
model or select a fixed reviewer model. A session override takes precedence
over the global reviewer. Following the global default is distinct from
pinning User explicitly. A fixed reviewer that becomes unavailable falls back
to human approval, never to a different provider.

### Edit the review policy

Open Settings → Permissions and find the approval reviewer, review model, and
custom-policy input. The input starts empty and says that leaving it blank uses
the default policy. Enter text and pause or leave the field to save it
automatically; the saved text replaces the built-in policy. Clear the input to
restore the built-in policy. There is one active policy, not a custom paragraph
layered over an uneditable copy of the default. Changing the model preserves
your saved policy. Without a fixed reviewer model, thinking shows `off`; a
fixed model offers `off` and only its configured reasoning levels.

For example, add a requirement that dependency installation always needs your
approval. Policy changes invalidate pending old-policy approvals; they do not
undo already completed actions. Keep secrets out of the text because the
configured policy is sent to your chosen review model.

The model must still produce the required structured result without tools.
Host hard restrictions and expired/canceled request checks cannot be removed
by a prompt. Editing the policy is not a way to disable those restrictions or
create an OS sandbox. Policy is local safety configuration, not portable sync.

Automatic review sends necessary action and authorization context to the
selected model and incurs additional usage. It has no execution tools and can
approve only the current action. An uncertain, unavailable, timed-out, or
invalid review returns control to the permission card. The original approval
deadline still applies. Use Take over to cancel review and decide manually.

For example, a conversation using Ask with Auto review may automatically
approve a clearly requested bounded operation. A later operation with unclear
consequences still asks you. Choosing Auto instead bypasses both reviewers;
the UI explicitly shows this distinction.

## Session grants

Allow for session shows the specific action scope. File grants name their
canonical target and operation; command grants identify the complete command,
working directory, and shell; external tools bind their configuration and
arguments. A grant belongs to the requesting agent, not every delegate in the
conversation. Automatic review never creates one.

Review active grants from the session permission controls, revoke an individual
grant, or clear all. Changing permission mode or reviewer clears session grants,
and restarting does not restore them. Revocation affects future operations; it
cannot undo a command or file write that has already executed.

## Limits

Plan and Goal remain planning states with their existing tool restrictions;
they are not OS-enforced read-only profiles. Shell and trusted Node plugin code
still run with local-user privileges in this increment. Automatic review is a
decision aid, not a filesystem or network sandbox. Separate follow-up work
covers OS isolation, plugin capability isolation, and native Pi tool bridging.
