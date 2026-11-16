# ADR: User-definable modes as staged workflows

::: v-pre

- Status: Implemented candidate
- Date: 2026-11-07
- Supersedes: hard-coded `Mode = "plan" | "goal" | "agent"` behavior
  (contract-mode grouping D198). The Plan approval flow in ADR 0053 is
  re-expressed, not removed.
- Credits: the durable run engine (claims, CAS revisions, budgets, pause
  closeout, idempotent settlement) is ported from new-Beginner's
  PR #1999 / #2140 / #2141 (issue #1995).

## Context

Plan, Goal and Agent are closed, hard-coded modes. Their behavior is spread over
the mode prompt table, runtime tool gating, Rust `is_contract_mode` /
`plan_mode_allows`, Plan approval and (in #2141) a Goal-specific loop.

## Decision

### 1. A mode is one Markdown file

`~/.pi/modes/<name>/mode.md` holds YAML frontmatter and a Markdown body. The
body is the shared system prompt.

Builtins `agent`, `plan` and `goal` use the same format and ship with the app.
The builtin ids are reserved: a user document that uses one is reported in
settings and is not loaded.

```markdown
---
name: review
label: Review
description: Read-only code review
permission: contract
---
Review the current changes for defects. Do not modify files.
```

```markdown
---
name: feature
label: Feature
description: Spec, implement and verify one feature
artifacts:
  spec:
    path: .pi/runs/{{run.id}}/spec.md
    template: templates/spec.md
    requiredHeadings: [Goal, Acceptance criteria]
budget: { maxTurns: 30 }
stages:
  design:
    permission: contract
    prompt: Write the spec for {{run.input}}.
    exit:
      - require: artifact:spec
      - ask: user
    next: implement
  implement:
    permission: agent
    loop: true
    prompt: Implement the approved spec.
    on:
      compaction: [{ inject: artifact:spec }]
    exit:
      - run: pnpm test
        onFail: { retries: 3 }
---
Follow the repository conventions.
```

### 2. Fields

| Level | Field | Meaning | Default |
| --- | --- | --- | --- |
| mode | `name`, `label`, `description` | Identity shown in the mode picker | `name` = directory name |
| mode | `permission` | `agent` or `contract`, inherited by stages | `agent` |
| mode | `artifacts` | `id → { path, template?, requiredHeadings? }` | none |
| mode | `budget` | `{ maxTurns?, maxTokens? }` for one run | `maxTurns: 20`, tokens unlimited |
| mode | `returnTo` | Mode that the session uses after the run ends | `agent` |
| mode | `stages` | Ordered map; the first stage starts the run | none, which makes a simple mode |
| stage | `prompt` | System section while the stage is active | none |
| stage | `permission` | Overrides the mode level | mode value |
| stage | `loop` | The Host continues the stage across turns | `false` |
| stage | `on` | `enter` / `compaction` → list of `inject` | none |
| stage | `exit` | Ordered gates | none |
| stage | `next` | Next stage; when absent, the stage is final | none |

Variables are `{{run.id}}`, `{{run.input}}` (the message that started the run)
and `{{artifacts.<id>.path}}`. Substitution is text-only.

### 3. Run semantics

- **Stage brief.** On every turn the Host adds a generated section to the stage
  system prompt.
- **Templates.** When a stage is first entered, the Host writes the template of
  each missing artifact, with variables substituted.
- **Finishing a stage.** The model calls `CompleteStage { summary, artifacts?,
  report? }`.
- **Blocked reports.** Optional structured reports preserve per-criterion `met`
  / `unmet` / `unverified` evidence, remaining work and a blocker reason.
- **Completion-channel failure.** The sidecar proxy admits only
  `modes.completeStage` and `modes.gateResult`, not user control methods.
- **Gate failure.** The failure goes back to the model as the `CompleteStage`
  tool result, for example the missing heading or the command exit code with the
  output tail.
- **Transition.** When all gates pass, the run moves to `next` and the Host
  starts that stage's first turn.
- **Turns.** A loop stage continues until `CompleteStage` passes, a blocked
  report or execution error stops continuation, or the budget is exhausted.
- **Budget.** `maxTurns` and `maxTokens` limit only the turns the Host starts by
  itself.
- **Run states.** The states are `running`, `waiting` (for an approval, after
  retries are exhausted, or after a non-loop stage stops), `paused`,
  `budget_exhausted`, `finished` and `stopped`.
- **Editing a run.** `modes.update` changes an open run's input (the objective)
  and its `{ maxTurns, maxTokens }` budget.
- **Remote workspaces.** Staged runs are not available in remote workspaces in
  this version.
- **Mode switch.** Selecting another staged mode while a run is active asks the
  user to stop the run first.

### 4. Actions

| Action | Where | Effect | Authority |
| --- | --- | --- | --- |
| `require: artifact:<id>` | `exit` | The file exists inside the workspace and contains the required headings | Host |
| `run: <command>` or `run: { command, timeoutMinutes }` | `exit` | Bash in the workspace root through the normal permission prompt (allow-for-session applies); a non-zero exit fails the gate; default timeout 10 min | Host gate |
| `ask: user` | `exit`, must be last | The turn ends and the run waits. Approve continues the transition. Reject keeps the stage, and the user's feedback becomes a normal user message | Host |
| `inject: artifact:<id>` or text | `on` | Adds a system notice with the current file content or the text; never a fake user message. After compaction, the notice follows the summary | Runtime |

Completion handling is the final stage's `exit` gates. Compaction handling is
`on.compaction`.

### 5. Validation and limits

- The frontmatter must be strict YAML: maps, lists, strings, numbers and
  booleans, with no anchors, aliases or tags.
- The parser rejects the whole definition when it finds an unknown key, event,
  action or stage reference, a `goto` cycle without a `loop` or `ask` stage, an
  `ask` that is not the last gate, or an artifact path outside the workspace.
- Limits: 16 stages, 8 gates per stage, 10 retries, 64 KB per file, 8 KB of
  command output returned to the model, and a `run` timeout of at most 60 min.

### 6. Permission narrows, never widens

- `contract` keeps today's Plan hard deny: the allowlist plus plan-safe plugin
  actions (ADR 0211).
- `Computer` and scheduled-task tools are available only in the builtin `agent`
  mode.
- Builtin Goal keeps the session's selected permission on every claimed turn,
  including Host continuation.
- No action grants a permission, a session grant or an external path.

### 7. Ownership

| Layer | Owns |
| --- | --- |
| shared | Schema, parser, defaults, limits, variable substitution, wire types (`modeId: string`) |
| agent-runtime | Discovery, the stage brief, per-stage prompt and tool catalog, the `CompleteStage` tool, `inject` on enter and compaction |
| host-core | Authority: definition snapshot per run, tool policy from that snapshot (never the mode claimed by the runtime), the stage state machine, artifact writes and checks, gate results, the run engine (claim / CAS / budget / pause / settlement from #2141) |
| renderer | Mode picker, run status bar, source editor with validation in settings |

Only the Host records a gate as passed and moves the run to another stage.

### 8. Persistence

Desktop attaches the catalog definition to the additive `session.create`
`modeSnapshot` input. The Host validates and stores it in the same transaction
as the session, rather than configuring an already-visible session in a second
RPC.

One migration after the current schema:

- `sessions.mode` keeps its column.
- `mode_snapshots (hash, json)`: an immutable definition per run, so editing a
  mode never changes a running run.
- `mode_runs`: generalized from #2141 `session_goals`.
- `mode_gate_results`: run, stage, gate index, action, result, evidence and
  timestamp.
- Existing `plan_approvals` rows stay valid.

### 9. Builtins and compatibility

- `agent`: a simple mode.
- `plan`: a simple `contract` mode that keeps the ADR 0053 proposal pipeline
  unchanged (EnterPlanMode, SubmitPlan, approval, queued execution).
- `goal`: stage `work` (`agent`, `loop`, artifact `goal` from a template seeded
  with `{{run.input}}`, `inject` on compaction, gate `require: artifact:goal`
  with headings Objective, Acceptance criteria and Evidence).

The Goal input preference and execution identity are deliberately separate.
Relabeling the executing turn as Agent would lose the snapshot's authority;
keeping the picker on Goal would make ordinary follow-ups ambiguous.
- IPC / RACP `mode` stays a string.

## Consequences

- The hard-coded mode-name branches collapse into the registry and the Host
  policy table.
- A user creates a simple mode with a prompt, or a staged workflow with
  artifacts and checks, in one file.
- One tool (`CompleteStage`) and four actions cover Plan approval, Goal
  completion and custom workflows.
- A misconfigured definition can only make a mode stricter or fail to load.
- `run` gates execute commands only when a stage finishes, behind the existing
  Bash approval, and the transcript shows them.

## Alternatives

1. Merge #2141 as a third hard-coded mode.
2. A flat list of checkpoints without stages.
3. Evaluating gates after every turn.
4. Project-level definitions.

:::
