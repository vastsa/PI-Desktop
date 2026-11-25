# ADR: User-definable modes as staged workflows

::: v-pre

- Status: Implemented candidate; supersedes the hard-coded
  `Mode = "plan" | "goal" | "agent"` behavior and contract-mode grouping D198
  (the ADR 0053 Plan approval flow is re-expressed, not removed), and ports the
  durable run engine from PR #1999 / #2140 / #2141 (issue #1995)
- Date: 2026-11-07
- Related: D198, D202, ADR 0053, ADR 0211

## Context

Plan, Goal and Agent are closed, hard-coded modes whose behavior is spread over the
mode prompt table, runtime tool gating, Rust `is_contract_mode` / `plan_mode_allows`,
Plan approval and a Goal-specific loop. Users cannot create a mode, split work into
stages, require an artifact, or act when context is compacted or work completes, while
subagents already use a Markdown definition with frontmatter, a shared parser, and
global-only discovery (D202).

## Decision

### 1. A mode is a user-owned directory

New modes use `mode.yaml`. Its `promptFile` names a local text document;
`subagents` lists relative paths to role documents. The mode keeps the
session's selected model. Roles own their prompts, tools, primary model,
ordered `fallbackModels` and optional aligned `fallbackThinkingLevels`.
No provider secrets belong to the directory. `includeGlobalSubagents` is
off by default; enabling it adds only already-active roles and never
shadows a private role. An empty team is a valid empty delegation catalog.

Skills are discovered under `skills/`; their activation belongs to the mode,
not the skill document. A present but invalid YAML manifest is an error: it
never activates a neighboring legacy document. The following legacy format
is still supported when there is no YAML manifest.

`~/.pi/modes/<name>/mode.md` holds YAML frontmatter and a Markdown body that is the
shared system prompt, with optional artifact templates in `templates/`; builtins
`agent`, `plan` and `goal` use the same format. A document in a builtin's own folder
(`~/.pi/modes/goal/mode.md`) overrides that builtin: Settings → Modes edits it in
place and Restore default deletes the file. An override must keep the shape the
builtin's id-keyed behavior relies on (Agent and Plan stay simple at `agent` and
`contract`; Goal stays staged and returns to `agent`); an invalid one is reported and
the shipped definition stays in effect. Any other document that claims a builtin id
is reported and not loaded. Discovery is global only, and settings re-read the
directory on each catalog load. A simple mode is a prompt and a
permission level, without stages or a run:

```markdown
---
name: review
label: Review
description: Read-only code review
permission: contract
---
Review the current changes for defects. Do not modify files.
```

A staged mode declares stages, artifacts and gates; sending the first message in it
starts a run.

### 2. Fields

| Level | Field | Meaning | Default |
| --- | --- | --- | --- |
| mode | `name`, `label`, `description` | Identity shown in the mode picker | `name` = directory name |
| mode | `permission` | `agent` or `contract`, inherited by stages | `agent` |
| mode | `artifacts` | `id → { path, template?, requiredHeadings? }` | none |
| mode | `budget` | `{ maxTurns?, maxTokens? }` for one run | `maxTurns: 20`, tokens unlimited |
| mode | `returnTo` | Mode the session uses after the run ends | `agent` |
| mode | `stages` | Ordered map; the first stage starts the run | none, which makes a simple mode |
| stage | `prompt` | System section while the stage is active | none |
| stage | `permission` | Overrides the mode level | mode value |
| stage | `loop` | The Host continues the stage across turns | `false` |
| stage | `on` | `enter` / `compaction` → list of `inject` | none |
| stage | `exit` | Ordered gates | none |
| stage | `next` | Next stage; when absent, the stage is final | none |

Template variables are `{{run.id}}`, `{{run.input}}` (the message that started the
run) and `{{artifacts.<id>.path}}`, substituted as text only.

### 3. Run semantics

- **Stage brief and templates.** Each turn the Host adds a generated section to the
  stage prompt with the current stage, declared artifacts and paths, required
  headings, the gates, and how to finish, and on first entry writes the template of
  each missing artifact with variables substituted.
- **Finishing a stage.** The model calls
  `CompleteStage { summary, artifacts?, report? }`; `artifacts` maps an id to Markdown
  and the Host writes it to the artifact path, so a contract stage can produce its
  artifact without Write permission, after which the Host evaluates gates in order. A
  stage with no gates and no `loop` also finishes when its turn ends.
- **Reports and gate failure.** Structured reports keep per-criterion
  `met` / `unmet` / `unverified` evidence, remaining work and a blocker reason: a valid
  `blocked` report moves a live claimed run to `waiting/blocked`, stops autonomous
  continuation and survives restart, a `completed` report requires all outcomes met but
  never bypasses exit gates, and reports are model assertions, not verification. A gate
  failure returns as the `CompleteStage` tool result and the model continues in the same
  turn, with `onFail.retries` (default 2) then waiting for the user and
  `onFail.goto: <stage>` moving the run there instead.
- **Completion channel.** The sidecar proxy admits only `modes.completeStage` and
  `modes.gateResult`, Host ownership, live claim and frozen-input checks still apply,
  and a broken completion RPC or invalid Host outcome fails the current execution turn
  with no blind autonomous retry on transport failures.
- **Transition and turns.** When all gates pass the run moves to `next` and the Host
  starts that stage's first turn; the final stage ends the run and switches the session
  to `returnTo`. A loop stage continues until `CompleteStage` passes, a blocked report
  or execution error stops continuation, or the budget is exhausted; a non-loop stage
  whose turn ends unfinished waits for the user; a user message during a run is input to
  the current stage and runs before any Host-started turn; `maxTurns` / `maxTokens` limit
  only Host-started turns.
- **Run states.** `running`, `waiting` (approval, exhausted retries, non-loop stop),
  `paused`, `budget_exhausted`, `finished`, `stopped`; the status bar shows mode, stage,
  turns or budget, and Pause, Resume, Edit, Remove, Stop. Pause is persisted immediately
  and blocks Host-started turns, a running turn closes out through
  `agent.modeTurnNotice` `closeout`, Stop revokes the claim and interrupts, Remove drops
  the run context (`release`) so the turn finishes as an ordinary turn of `returnTo`,
  and after a restart a run whose turn was in flight is paused, never replayed.
- **Editing, remotes and switching.** `modes.update` changes an open run's input and
  budget from the next claim; the turn holding the claim keeps its input, and its
  `CompleteStage` answers `MODE_INPUT_CHANGED` when no longer current. Staged runs are
  unavailable in remote workspaces in this version. Selecting another staged mode while
  a run is active asks the user to stop it first, and selecting a simple mode leaves the
  run paused.

### 4. Actions

| Action | Where | Effect | Authority |
| --- | --- | --- | --- |
| `require: artifact:<id>` | `exit` | The file exists inside the workspace and contains the required headings | Host |
| `run: <command>` or `run: { command, timeoutMinutes }` | `exit` | Bash in the workspace root behind the normal permission prompt; a non-zero exit fails the gate; default timeout 10 min | Host gate |
| `ask: user` | `exit`, must be last | The turn ends and the run waits; Approve continues the transition, Reject keeps the stage and the feedback becomes a normal user message | Host |
| `inject: artifact:<id>` or text | `on` | Adds a system notice with the current file content or the text, never a fake user message; after compaction it follows the summary | Runtime |

Completion handling is the final stage's `exit` gates; compaction handling is
`on.compaction`.

### 5. Validation and limits

- Frontmatter must be strict YAML — maps, lists, strings, numbers and booleans, with no
  anchors, aliases or tags.
- The parser rejects the whole definition on an unknown key, event, action or stage
  reference, a `goto` cycle without a `loop` or `ask` stage, an `ask` that is not the
  last gate, or an artifact path outside the workspace; settings show the diagnostic and
  the picker shows the mode as unavailable.
- Limits: 16 stages, 8 gates per stage, 10 retries, 64 KB per file, 8 KB of command
  output returned to the model, `run` timeout at most 60 min.

### 6. Permission narrows, never widens

- `contract` keeps today's Plan hard deny — the allowlist plus plan-safe plugin actions
  (ADR 0211) — while `agent` uses the Agent policy, and Host artifact writes through
  `CompleteStage` are limited to declared paths.
- `Computer` and scheduled-task tools are available only in the builtin `agent` mode.
- Builtin Goal keeps the session's selected permission on every claimed turn, including
  Host continuation, which removes the second-turn Auto-to-Accept-edits downgrade; other
  unattended staged modes keep the `accept-edits` ceiling for `auto`.
- No action grants a permission, a session grant or an external path.

### 7. Ownership

| Layer | Owns |
| --- | --- |
| shared | Schema, parser, defaults, limits, variable substitution, wire types (`modeId: string`) |
| agent-runtime | Discovery, the stage brief, per-stage prompt and tool catalog, the `CompleteStage` tool, `inject` on enter and compaction |
| host-core | Authority: definition snapshot per run, tool policy from that snapshot (never the mode claimed by the runtime), the stage state machine, artifact writes and checks, gate results, and the run engine (claim / CAS / budget / pause / settlement from #2141) |
| renderer | Mode picker, run status bar, source editor with validation in settings |

Only the Host records a gate as passed and moves the run to another stage.

### 8. Persistence

Desktop attaches the catalog definition to the additive `session.create`
`modeSnapshot` input, and the Host validates and stores it in the same transaction as
the session, so a failed configuration cannot leave an incomplete session; legacy
callers may omit the snapshot and keep fail-closed policy. One migration follows:
`sessions.mode` keeps its column, with values becoming mode ids and `agent`, `plan`,
`goal` mapping to the builtins, a session whose mode no longer exists falling back to
`agent` and an active run keeping its snapshot. `mode_snapshots (hash, json)` stores an
immutable definition per run, `mode_runs` is generalized from `session_goals` to store
mode, snapshot hash, input, current stage, state, budget, usage, revision, active claim,
retries and rounds completed (schema 30 adds an active elapsed clock `elapsed_ms` /
`active_since_ms` that only Running time accumulates), `mode_gate_results` records run,
stage, gate index, action, result, evidence and timestamp, and existing
`plan_approvals` rows stay valid.

### 9. Builtins and compatibility

- `agent`: a simple mode. Agent and Plan prompts come from the runtime builtins unless
  an override is in effect, in which case its definition is sent with the turn; the
  Host never needs a snapshot for either.
- `plan`: a simple `contract` mode keeping the ADR 0053 proposal pipeline unchanged
  (EnterPlanMode, SubmitPlan, approval, queued execution) with the same behavior, tool
  names and stored approvals; a staged Plan would rewrite a released approval flow.
- `goal`: stage `work` (`agent`, `loop`, artifact `goal` from a template seeded with
  `{{run.input}}`, `inject` on compaction, gate `require: artifact:goal` with headings
  Objective, Acceptance criteria and Evidence), completion staying a model self-report,
  with a new run taking the definition budget. The default budget is edited in the
  Goal override file; there is no separate settings value, and an open run's budget
  is edited through `modes.update`. The legacy `EnterGoalMode` / `SubmitGoal` negotiation is no longer offered
  and the Host rejects new proposals with `PLAN_GOAL_ACTIVATION_DISABLED`, while old
  approval rows stay readable; accepted Goal input returns the composer preference to
  Agent without changing the run, its snapshot or its claim.
- IPC / RACP `mode` stays a string, so old clients sending `plan`, `goal` or `agent`
  keep working; builtin labels are localized and user labels are shown as written.

## Consequences

- Hard-coded mode-name branches collapse into the registry and the Host policy table,
  and one file expresses either a simple mode or a staged workflow.
- One tool (`CompleteStage`) and four actions cover Plan approval, Goal completion and
  custom workflows, and a misconfigured definition can only make a mode stricter or fail
  to load.

## Alternatives

- Merge #2141 as a third hard-coded mode: every new workflow would repeat the
  cross-layer branching.
- A flat list of checkpoints without stages: cannot express phases, backtracking or
  per-phase permission.

:::
