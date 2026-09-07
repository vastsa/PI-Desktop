# 04. Builtin Commands

## 1. Goal

Define the five first-party command palette entries available without plugins.
The same entries are available in the composer `/` menu.

Shortcut: **Cmd/Ctrl + Shift + P** (D014)

## 2. Command ID convention

```text
builtin.<domain>.<action>
```

## 3. Core builtin catalog

The builtin registry intentionally contains exactly these five commands. Plugin
commands extend the searchable command list dynamically; app navigation,
project management, settings, plugin management, and diagnostics are not
builtin command contracts.

| id | title | keywords | category | risk | behavior |
|---|---|---|---|---|---|
| `builtin.session.new` | New Task | new, chat, task | Session | low | reuse the latest empty session in the current group or create a durable empty session, then focus the composer |
| `builtin.agent.compact` | Compact Conversation Context | compact, context, tokens | Session | low | create a model-context checkpoint for the idle active session |
| `builtin.mode.agent` | Switch to Agent | mode, agent | Session | low | set the idle session mode to Agent |
| `builtin.mode.plan` | Switch to Plan | mode, plan, planning | Session | low | set the idle session mode to Plan |
| `builtin.mode.goal` | Switch to Goal | mode, goal, objective, autonomous | Session | low | set the idle session mode to Goal |

## 4. Visibility and execution rules

- The five IDs are the complete first-party registry. Removed IDs are not
  palette results and are not renderer dispatch cases; plugin commands remain
  independently discoverable.
- `New Task` uses the current project or temporary group. It selects the
  group's most recent empty session when present; otherwise it reveals the
  empty home on the first frame and creates the durable empty session. The
  action is idempotent within a group.
- `Compact Conversation Context` is available while the active session is idle;
  an active turn or checkpoint remains busy according to the existing compaction
  contract.
- Mode commands use the same active-session configuration path as the Composer
  Agent/Plan/Goal chip. They update an idle session immediately. With no active
  session, they update the persisted default for the next session; a running
  session or pending approval is not changed.
- `SubmitPlan` and `SubmitGoal` are model tools, not palette commands. There is
  no Chat mode or request-changes alias.
- The former app/project/settings/plugin/log commands remain available through
  their dedicated surfaces where applicable, but are not part of the command
  palette or the composer builtin namespace.

## 5. Execution results

Commands return:

```ts
type CommandExecutionResult =
  | { ok: true; navigation?: string; message?: string }
  | { ok: false; error: AppError }
```

## 6. Acceptance

1. The builtin registry contains exactly five unique, prefixed IDs.
2. Palette search matches each title and keyword set.
3. Mode switch commands update the idle session mode immediately; Plan, Goal,
   and Agent refer to the same pi Agent.
4. Compact works while idle and returns `AGENT_BUSY` during an active
   turn/checkpoint.
5. Removed IDs and the legacy `newChat`, `openProject`, and `openSettings`
   dispatch aliases do not appear in the registry or renderer switch.

## 7. Composer slash aliases (D123, ADR 0024, ADR 0106)

Builtin commands surface in the composer `/` menu through short aliases defined
in the same registry that feeds palette search
(`electron/main/builtin-commands.ts`); execution reuses the renderer switch.

| alias | palette id |
|---|---|
| `/new` | `builtin.session.new` |
| `/compact` | `builtin.agent.compact` |
| `/agent-mode` | `builtin.mode.agent` |
| `/plan-mode` | `builtin.mode.plan` |
| `/goal-mode` | `builtin.mode.goal` |

Aliases share one namespace with template and plugin command names; builtin
aliases win collisions, then project templates, then user templates, then
plugin commands. Selecting an alias inserts `/alias `; sending `/new` or
`/compact` alone executes locally without creating an empty prompt. The
Agent/Plan/Goal aliases also support a prompt body:
`/agent-mode <prompt>`, `/plan-mode <prompt>`, or `/goal-mode <prompt>` switches
the idle session (or the next-session default) and sends `<prompt>` through the
normal prompt path. A mode alias sent with no body remains a local mode switch.
The prompt body remains the visible user turn; a failed dispatch does not clear
the composer draft. Former builtin aliases are no longer resolved and are
handled as ordinary unknown slash text unless supplied by another command
source.
