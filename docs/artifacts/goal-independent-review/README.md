# Goal input independence: acceptance evidence

Goal execution is independent of the Composer input preference. This is a PR
review candidate, not a release or an installation over the daily application.
All images show the actual built Windows Desktop with isolated data and a
loopback-only model fixture; their task content is synthetic.

## Behavior verified

| User path | Expected result | Evidence |
| --- | --- | --- |
| Submit a Goal | Start explicitly, then return input to Agent | Capture 01; send-path regression |
| Select Plan/Goal/Agent while running | Preserve the Goal claim and status | Capture 02; Host/Rust mode regressions |
| Save an objective edit | Header updates immediately; current Host round keeps activeScope; next claim adopts the edit | Capture 03; multi-request fixture and old-scope completion rejection |
| Send ordinary FIFO or immediate guidance | Accept user information without pausing; preserve autonomous continuation | Capture 04; real Host/sidecar fixture |
| Pause, finish an Agent task, then Resume | Resume directly from Agent input; no GOAL_MODE_REQUIRED | Capture 05; real Desktop/Host path |
| Explicitly submit a replacement Goal | Replace active or paused unfinished work with fresh identity/counters; drain retired work first | Captures 06/07; late-accounting tests |
| Press Header Pause / Composer Stop | Finish-round pause / immediate stop respectively; preserve accepted startup messages | Capture 08; smart-Stop regressions |
| Provider cannot continue | HTTP 402 fixture blocks further autonomous admission, with an observable error | Real Host/sidecar failure fixture |

Saved edits never pause or resume work. Unsaved edits have no effect. Per-Goal
budgets apply after settlement and do not change defaults or authorize resume.
Optional internal planning remains read-only and self-reviewed, without a user
approval stage or added permissions. Different root Host turn IDs remain distinct
assistant rounds without fake user messages. Restart still pauses without replay.

## Submission revalidation

The submission worktree starts at main
`0ba8cfd57cdc6baa4c1dbf16a617eb933ad3e0ee` and preserves PR head
`e91a26555c42bbb3597dec6e5e78ebfbed371362` as an ancestor. Its complete source and
specification set was compared with the previously accepted local candidate
before publication. The accepted local source digest was
`fda1d69f20a3e5b64479f6257f940f02b6aa1ad19fc5a0a224768b4da8e44ed5`;
Git may normalize text line endings, so it is not a remote-tree digest.

Fresh submission checks: AgentHost 101 passed, runtime Goal 99 passed,
HostRuntime targeted 31 passed, Desktop affected 111 passed, Rust Goal 77 passed.
TypeScript builds, Desktop typecheck, production Electron, Rust fmt/build and
standard Clippy passed. Clippy retains three existing warnings. Counts overlap
with the broader accepted-candidate runs below and must not be summed.

The real cross-process fixture covers eight successful requests and six real
user messages, plus a separate one-request/one-user insufficient-balance session.
The actual Desktop fixture covers six held requests and eight captures. The eight
autonomous scenarios and both control fixtures also protect completion audit,
finite/unlimited budgets, pause/Stop, deletion/restart and chat/todo retention.

Broader source-equivalent local validation: AgentRuntime 1762 passed / 1 skipped;
HostRuntime 168 passed / 1 filesystem-index 5-second timeout / 3 skipped, with
that file rerun unchanged (3 passed). The original full run was not all green.
Filtered Rust migrations, queue, Plan, permissions, Todo, mode, native Plan and
scheduled-tool suites passed. Full Rust/Desktop Windows baseline failures from
previous reports are not claimed fixed or rerun by this submission.

Schema 32 backs up schema 31, removes the mode-pause trigger, and adds frozen
claim scope, immutable execution binding and optional queued startup identity.
It preserves old claims, queue rows, late usage and restart safety. Plan restrictions,
owner checks, permission cancellation and plugin boundaries remain enforced.

No paid-provider task, Linux/macOS, release packaging/installation, or forced-
compaction Goal E2E is claimed locally. Remote CI is tracked on PR #1999; old
head results are not proof for a later head. No verify:ui:* command or daily-app
attachment is part of this validation. Only the summary and selected images are
published here; raw machine logs, databases and build outputs remain local.

## Reproduce the targeted paths

With the repository toolchain and dependencies provisioned, build the packages
and Host, then run from the repository root in Git Bash on Windows:

```bash
export PI_SCRATCH_DIR="$(mktemp -d)"
export PI_HOST_CORE_BINARY="$(pwd)/target/debug/pi-desktop-host-core.exe"
node scripts/e2e-goal-independent.mjs
node scripts/e2e-goal-controls.mjs
node scripts/e2e-goal-live-controls.mjs
PI_DESKTOP_HOST_BIN="$PI_HOST_CORE_BINARY"   PI_GOAL_ARTIFACT_NAME=goal-independent-reproduction   node scripts/e2e-goal-independent-ui.mjs
```

The UI runner refuses to overwrite an existing artifact directory. The checked-in
captures below originate from the source-equivalent accepted build; submission
candidate reruns are kept separately from this gallery.

## Actual built Desktop images

1. [Submitted Goal; input returned to Agent](01-running-agent-input.png)
2. [Plan selected; Goal remains active](02-plan-selection-goal-running.png)
3. [Saved edit shown without pausing](03-live-header-next-round-edit.png)
4. [Immediate guidance without pausing](04-immediate-guidance.png)
5. [Resumed after ordinary Agent task](05-resumed-after-agent-task.png)
6. [Running Goal replaced](06-active-replacement.png)
7. [Paused Goal replaced](07-paused-replacement.png)
8. [Explicit Stop, narrow light layout, no draft error](08-stopped-agent-light-narrow.png)

See the [user guide](../../autonomous-goals.md) and
[lifecycle specification](../../spec/03-runtime/10-session-state-machine.md).


## CI contract follow-up

The first publication run exposed two legacy migration-fixture failures, stale
Main RPC test doubles, and a transcript probe that inferred Planning without a
Plan session. The follow-up changes tests only, not production migrations or
execution policy. The v25 single-step test retains exact schema/data/file/backup
checks and separately checks full-open core data and immutable backups. The v15
fixture removes the trigger absent from that schema. Main doubles now implement
session.getTurnMode and assert its execution mode reaches the runtime. The real
transcript probe explicitly checks Agent/Goal Working and Plan Planning, including
runtime-activity priority. The 42 affected Main tests and the 4/12 Rust module
suites passed locally after reproducing their failures. Current remote checks are
shown on PR #1999; the earlier failed run is not represented as green.
