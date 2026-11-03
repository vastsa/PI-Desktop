# Immediate Goal pause and queued-message acceptance

PR review evidence, not a release or an installation over the daily application.
Screenshots show the actual built Windows Desktop, isolated Host data and a
loopback-only model. Task/answer content is synthetic.

## Verified user paths

| Requirement | Evidence and result |
| --- | --- |
| Ordinary queued input during Goal | Actual queue strip waits for the current Host execution round, not Goal completion; the message runs before autonomous continuation (captures 01/02) |
| Immediate pause | Header and persisted state are already paused while the provider response is still held; clock stops, Resume waits for settlement (capture 03) |
| Inform current model | A private current-turn control validates persisted owner intent and steers a fixed system handoff notice, with no fake user row (capture 04) |
| Quick bounded closeout | Cooperative model ends in one reply; uncooperative tool loop ends after three subsequent model requests, with a hard refusal at the fourth request |
| Safe paused state | New substantive work and TaskWait denied; pending questions canceled and pending tool approvals denied only in this session; progress reports cannot resume/complete paused work |
| Preserve controls | Explicit Resume succeeds after settlement; Composer Stop immediately interrupts; edits, pending budgets, replacement and usage/restart behavior remain covered (captures 05/06) |

A Host execution round may contain multiple provider/tool iterations. The cap is
three subsequent Agent model requests, not three more autonomous Host rounds and
not a requirement to manufacture extra replies. Existing provider/tool operations
are not retroactively undone; their latency is not a fixed-second guarantee.
Composer Stop remains the immediate interruption path. No paid-provider speed
claim is made. An older runtime without closeout support is safely stopped.

## Implementation and integration

Rust immediately persists paused/user_paused. The original claim plus
pauseRequested permits only closeout validation, progress and idempotent usage
settlement, never native/plugin execution or a new runtime turn. Settlement clears
closing intent, applies pending limits and remains paused. Stop/Cancel/Delete,
replacement and restart retain revocation/no-replay guarantees. Existing schema-32
fields are reused; no new migration or permission widening is introduced.

Main uses object-identity control credentials; cloned requests cannot forge them.
Headless and Desktop share AgentHost admission. The integration conflict keeps
latest-main session-operation locking and the replacement-only abort credential.

Submission starts at main `7e6141715d2442856cea3f11bb3909506a848eb8`, preserving
PR head `5e87077b60c2c69b765463305426f03d3a1eac3b` as an ancestor. The accepted
input source digest was
`48e4824285e1bce7207d115c272766f49ac2238fa4743922f0a7893a9bf8a6bf`.
223 input source hashes and 3886 source/spec files were checked during migration;
new main plugin documentation was preserved by a clean three-way merge. The
input digest is not the eventual remote Git tree digest.

## Verification

Fresh submission-worktree checks: AgentHost 106 passed, runtime Goal 104 passed,
HostRuntime 182 passed / 3 existing skipped, Desktop affected 101 passed, Rust Goal
88 passed. TypeScript builds, Desktop typecheck, production Electron, Rust fmt,
build and standard Clippy passed; three existing Clippy warnings remain.

The source-equivalent accepted local candidate additionally ran the whole runtime
suite (1764 passed / 1 existing skipped before final narrow guard additions),
permissions 23 and Plan 19. These overlap targeted tests and must not be summed.
The final guards and fourth-request refusal have separate red/green coverage.

The real Host/sidecar fixture covers eight requests, FIFO-before-continuation,
one-reply/three-request handoff, no fake users and no automatic resume. The actual
built Desktop fixture covers five requests and six captured states. Both control
fixtures and the independent-input scenario protect edit/budget/Stop, replacement,
ordinary guidance, restart deletion and chat/todo retention. Submission candidate
E2E is recorded against its tested commit and base in PR #1999.

Only selected images and portable summaries are published here. Raw machine logs,
databases and build outputs remain local. Local full Rust/Desktop platform suites,
Linux/macOS, paid-provider tasks, release packaging/installation and forced-
compaction Goal E2E are not claimed. No verify:ui:* command, dependency installation,
force push, local-main merge, daily-app attachment or automatic PR merge is part
of this submission. Remote checks on PR #1999 are authoritative for the new head;
old-head green checks are not proof for new commits.

## Reproduce focused flows

With existing dependencies/toolchain provisioned and candidate packages, Host and
Desktop built, run from the repository root in Git Bash on Windows:

```bash
export PI_SCRATCH_DIR="$(mktemp -d)"
export PI_HOST_CORE_BINARY="$(pwd)/target/debug/pi-desktop-host-core.exe"
node scripts/e2e-goal-pause-steering.mjs
node scripts/e2e-goal-live-controls.mjs
PI_DESKTOP_HOST_BIN="$PI_HOST_CORE_BINARY" \
  PI_GOAL_ARTIFACT_NAME=goal-pause-reproduction \
  node scripts/e2e-goal-pause-steering-ui.mjs
```

The UI runner refuses to overwrite an existing gallery. The selected images
originate from the source-equivalent accepted build; candidate reruns are kept
separately. Host execution and renderer content are real, not a standalone mock UI.

## Actual built Desktop images

1. [Queued input during Goal](01-queued-during-goal.png)
2. [FIFO sent, then Goal continued](02-fifo-sent-goal-continued.png)
3. [Paused before provider response returns](03-paused-before-provider-return.png)
4. [Model receives internal pause notice](04-model-receives-pause.png)
5. [Handoff settled, paused and resumable](05-paused-settled.png)
6. [Immediate Stop, narrow/light](06-light-narrow-stopped.png)

See the [Goal guide](../../autonomous-goals.md) and
[lifecycle specification](../../spec/03-runtime/10-session-state-machine.md).
