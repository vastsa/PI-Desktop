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

Plan, Goal and Agent are closed, hard-coded modes. Their behavior is spread
over the mode prompt table, runtime tool gating, Rust `is_contract_mode` /
`plan_mode_allows`, Plan approval and (in #2141) a Goal-specific loop. About
40 non-test files branch on the literal mode names. Users cannot create a mode,
split work into stages, require an artifact, or act when the context is
compacted or the work completes.

Subagents already use a Markdown definition with frontmatter, a shared parser
with safe defaults, and global-only discovery (D202). Modes use the same shape.

## Decision

### 1. A mode is one Markdown file

`~/.pi/modes/<name>/mode.md` holds YAML frontmatter and a Markdown body. The
body is the shared system prompt. Optional artifact templates live next to it
in `templates/`.

Builtins `agent`, `plan` and `goal` use the same format and ship with the app.
The builtin ids are reserved: a user document that uses one is reported in
settings and is not loaded. To change a builtin, duplicate it under a new id.
Discovery is global only, so a cloned repository cannot provide a mode.
Settings read the directory again each time they load the catalog, so a
document written by another editor shows up without a restart. A document
whose `name` differs from its directory keeps that file: settings read, save
and delete it in place, and a new mode never writes into a directory that
already holds another mode.

A definition has one of two levels of complexity.

**Simple mode**: a prompt and a permission level, without stages and without a
run.

```markdown
---
name: review
label: Review
description: Read-only code review
permission: contract
---
Review the current changes for defects. Do not modify files.
```

**Staged mode**: stages, artifacts and gates. Sending the first message in this
mode starts a run.

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

- **Stage brief.** On every turn the Host adds a generated section to the
  stage system prompt. It contains the current stage, the declared artifacts
  with their paths and required headings, the gates, and how to finish. A mode
  author writes only the intent.
- **Templates.** When a stage is first entered, the Host writes the template
  of each missing artifact, with variables substituted.
- **Finishing a stage.** The model calls `CompleteStage { summary, artifacts? }`.
  `artifacts` maps an artifact id to Markdown, and the Host writes that content
  to the artifact path. A contract stage can produce its artifact without
  Write permission this way. The Host then evaluates the gates in order.
  A stage without gates and without `loop` also finishes when its turn ends.
- **Gate failure.** The failure goes back to the model as the `CompleteStage`
  tool result, for example the missing heading or the command exit code with
  the output tail. The model continues in the same turn. `onFail.retries`
  caps the failed attempts in the stage (default 2). When that limit is
  reached, the run waits for the user. `onFail.goto: <stage>` ends the turn
  and moves the run to that stage instead.
- **Transition.** When all gates pass, the run moves to `next` and the Host
  starts that stage's first turn. When the final stage passes its gates, the
  run ends and the session switches to `returnTo`.
- **Turns.** A loop stage continues until `CompleteStage` passes or the budget
  is exhausted. A non-loop stage whose turn ends without finishing waits for
  the user. A user message during a run is input to the current stage and
  starts no new run. Queued user messages run before any Host-started turn.
- **Budget.** `maxTurns` and `maxTokens` limit only the turns the Host starts
  by itself. A user message can always continue an open run.
- **Run states.** The states are `running`, `waiting` (for an approval, after
  retries are exhausted, or after a non-loop stage stops), `paused`,
  `budget_exhausted`, `finished` and `stopped`. The status bar shows the mode,
  the stage, turns or budget, and the controls Pause, Resume, Edit, Remove and
  Stop. Pause is persisted immediately and blocks Host-started turns. A turn
  already running closes out: Electron main tells its runtime
  (`agent.modeTurnNotice` `closeout`), which adds a system notice asking for a
  short handoff and ends the turn after at most 3 more model requests; the
  notice is never a user message and the next turn starts without it. Stop
  ends the run, revokes the claim and interrupts the active turn. Remove ends
  the run the same way but does not interrupt: the runtime drops the run
  context (`release`) and the turn finishes as an ordinary turn of the
  `returnTo` mode, with no Host-started turn after it. The composer Stop
  button interrupts the turn and pauses the run. After a restart, a run whose
  turn was in flight is paused, never replayed.
- **Editing a run.** `modes.update` changes an open run's input (the
  objective) and its `{ maxTurns, maxTokens }` budget. Both apply from the
  next claim. The turn holding the claim keeps the input it started with;
  its `CompleteStage` carries that input and the Host answers
  `MODE_INPUT_CHANGED` when it is no longer current, which ends the turn.
  A raised budget does not resume a `budget_exhausted` run; Resume does.
- **Remote workspaces.** Staged runs are not available in remote workspaces in
  this version. Simple modes are.
- **Mode switch.** Selecting another staged mode while a run is active asks the
  user to stop the run first. Selecting a simple mode leaves the run paused.

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
  Settings shows the diagnostic and the picker shows the mode as unavailable. A
  rejected definition never falls back to a weaker check.
- Limits: 16 stages, 8 gates per stage, 10 retries, 64 KB per file, 8 KB of
  command output returned to the model, and a `run` timeout of at most 60 min.

### 6. Permission narrows, never widens

- `contract` keeps today's Plan hard deny: the allowlist plus plan-safe plugin
  actions (ADR 0211). `agent` uses the Agent policy. Host writes of artifacts
  through `CompleteStage` are limited to the declared paths.
- `Computer` and scheduled-task tools are available only in the builtin
  `agent` mode.
- Turns that the user starts, or that follow a user approval in `ask: user`,
  keep the session permission mode. Turns that the Host starts by itself
  (loop continuation, `onFail.goto`) run at most `accept-edits`, even when the
  session uses `auto`.
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

One migration after the current schema:

- `sessions.mode` keeps its column. Its values become mode ids, and the
  existing values `agent`, `plan` and `goal` map to the builtins. A session
  whose mode no longer exists falls back to `agent`; an active run keeps its
  snapshot.
  When a run closes, the Host returns the session to `returnTo` without a
  snapshot; Electron main then settles it through `modes.settleReturn`,
  attaching the return mode's current definition, or moving the session to
  `agent` when that mode was deleted during the run.
- `mode_snapshots (hash, json)`: an immutable definition per run, so editing a
  mode never changes a running run.
- `mode_runs`: generalized from #2141 `session_goals`. Each row stores the mode,
  snapshot hash, input, current stage, state, budget, usage, revision, active
  claim, retries and rounds completed.
- `mode_gate_results`: run, stage, gate index, action, result, evidence and
  timestamp.
- Existing `plan_approvals` rows stay valid. The builtin `plan` reads them in
  the existing Plan proposal pipeline.

### 9. Builtins and compatibility

- `agent`: a simple mode.
- `plan`: a simple `contract` mode that keeps the ADR 0053 proposal pipeline
  unchanged (EnterPlanMode, SubmitPlan, approval, queued execution). Its
  behavior, tool names and stored approvals stay exactly as before, and the
  existing contract tests are the proof. Expressing Plan as a staged mode is
  left for a later change, because it would rewrite a released approval flow.
- `goal`: stage `work` (`agent`, `loop`, artifact `goal` from a template
  seeded with `{{run.input}}`, `inject` on compaction, gate
  `require: artifact:goal` with headings Objective, Acceptance criteria and
  Evidence). Completion stays a model self-report, as in #2141. A new Goal run
  takes its budget from the `goalBudget` app setting (Settings → Agent
  behavior) when it is set and valid, otherwise from the definition (20 turns,
  unlimited tokens); a running run keeps its own. While a Goal run is open the
  composer's Todo / background-task dock is hidden; its data stays and the dock
  returns when the run ends. The legacy
  Goal negotiation (`EnterGoalMode`, `SubmitGoal`) is no longer offered, and
  the Host rejects new Goal proposals with `PLAN_GOAL_ACTIVATION_DISABLED`.
  Old Goal approval rows stay readable, expire normally and never become
  autonomous authorization.
- IPC / RACP `mode` stays a string. Old clients that send `plan`, `goal` or
  `agent` keep working. Builtin labels are localized; user labels are shown as
  written.

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
- Delivery is one PR with reviewable commits: the registry refactor, the stage
  and gate engine, the ported run engine, then the settings source editor.
  Ported commits keep their original author, and the rest of the ported code
  carries `Co-authored-by: new-Beginner`. PR #1999, #2140 and #2141 will be
  closed with a pointer to this ADR.

## Alternatives

1. Merge #2141 as a third hard-coded mode. Rejected because every new workflow
   would repeat the cross-layer branching.
2. A flat list of checkpoints without stages. Rejected because it cannot
   express phases, backtracking or per-phase permission.
3. Evaluating gates after every turn. Rejected because commands would run on
   every turn and stage completion would have no clear signal.
4. Project-level definitions. Rejected because of the repository-supplied
   workflow risk (same reason as D202).

:::
