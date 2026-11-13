# E-drive write admission and detached-child deployment

Status: deployed and verified on the installed E build.
Date: 2026-11-10.
Target: `E:\PI-Desktop` (only). D stays untouched and running.
Marker in the deployed `package.json`: `personal-workflow-detached-write-wait-20261110`.

## Delivered behavior

1. Writes and edits no longer fail with `HOST_OVERLOADED` because an unrelated
   search is running. `ToolBudget` gives an exclusive request
   `MUTATION_QUEUE_WAIT_MS` (ten minutes) while shared calls keep
   `TOOL_QUEUE_WAIT_MS` (30 seconds), and the RPC dispatcher cap no longer
   undercuts the tool budget's own bound
   (`MAX_IN_FLIGHT_TOOLS + MAX_QUEUED_TOOLS + 32`).
2. `HostProcess` retries a pre-execution saturation rejection for about 30
   seconds (50, 100, …, 9 000 ms) instead of 0.75 s. The rejection is produced
   before the Host handles the request, so no retry can replay an executed
   write.
3. A subagent's own events no longer drive the parent session's running state,
   so a child that outlives its parent turn cannot leave the composer stuck in
   "running" with no way to type.
4. A child that outlives its parent turn now reads as **running (detached)** in
   the transcript and in the Session subagents tab alike, instead of stopped in
   one and running in the other. The marker clears when the child settles.

## Root cause and failure evidence

Read-only projection of the real data directory (`~/.pi-desktop`, no task
content, no secrets):

| Evidence | Value |
| --- | --- |
| Host `tool.log` admission rejections by tool | `Bash` 158, `Write` 59, `Edit` 16, `Read` 4, `Glob` 4, `Grep` 1 |
| Reasoning rejections by day | Oct 13: 156, Oct 15: 17, Oct 24: 17, Nov 5: 1, Nov 8: 9, Nov 9: 33, Nov 10: 9 |
| Recent transcripts with an actual failing tool result | 4 sessions (24, 18, 8, 3 occurrences); `Write` 37, `Edit` 12 |
| Failing tool error text | `host tool capacity did not become available in time` |
| Same-session tool durations at one failure | `Glob` 345 657 ms, then `Edit` 30 014 ms and 30 013 ms (both failed) |
| Pinned model of all five subagent definitions | `6aa75380-3a07-4498-b7cb-0775c8fed433/gpt-6.1-sol` |
| That provider row | exists, `enabled = 0`, `api_key_and_base_url`, 0 configured models |
| Enabled providers / their models flagged "available for AI delegation" | 3 providers, 55 models, 0 flagged |

A `Glob`/`Grep` resolves to `FileResources::fence(false)`, which conflicts with
every write (`FileResources::conflicts`), so a search over a large tree holds the
file domain for its whole scan. The write could not have started earlier — the
fence was doing its job — so the 30-second deadline reported progress as
failure: the user saw `HOST_OVERLOADED` and the model retried into the same
fence.

The "empty model" report is configuration, not a code defect: every subagent
definition pins a provider that is disabled and has no models, and no model is
flagged for delegation, so the child-continuation model picker has no options.

## Fresh source checks

| Check | Result |
| --- | --- |
| `cargo test -p host-core --locked` (full) | 1211 passed, 19 failed, 1 ignored — same 19 pre-existing git/worktree/remote environment failures |
| New Rust test `tool_budget::tests::a_write_waits_out_a_running_search_instead_of_failing_the_edit` | RED first (`a write must keep waiting while a domain-fenced search runs`), then green |
| `tool_budget` module tests | 34 passed |
| New Host transport test `packages/host-runtime/src/host-overload-retry.test.ts` | RED first (`expected { … } to be 'ok'`), then 3 passed |
| Agent runtime: `parent-stop-independent`, `delegation-history`, `subagent-control-runtime`, `runtime` | 505 passed |
| Agent runtime full suite | 131 files, 1830 passed, 1 skipped, 1 file timeout that passes alone in 941 ms |
| Desktop subagent/stop/transcript/work-panel tests | 98 passed |
| Desktop `node --test` detached-display and child-event tests | 30 + 8 passed |
| `packages/shared`, `packages/agent-runtime`, `packages/host-runtime` TypeScript no-emit | exit 0 |
| Desktop TypeScript no-emit | exit 0 |
| Five packages compile, desktop build, runtime bundle, native release build | all exit 0 |
| `git diff --check` | exit 0 |

## Fresh installed-executable acceptance

Executed against `E:\PI-Desktop\PI-Desktop.exe` with an isolated
home/workspace/data/agents profile, an empty model list, one loopback provider
and an isolated injection control port; no real provider or key was used.

| Scenario | Result | Evidence directory |
| --- | --- | --- |
| Subagent stop/continue, old-id successor read/wait/list, main-agent stop independence, detached child completion, interrupted-first-reply restart recovery, DNS persistence, injection patched | `PASS_ALL` 33 checks, 29 loopback requests | `deployed-e-acceptance-R1y8kj` |

## Replaced resources and integrity

| Resource | SHA-256 |
| --- | --- |
| New `app.asar` | `9ca865110599a914b5ee0b3276f82f0c7cf02309e9414f6aac28dd0ea5e49b93` |
| New `agent-runtime/sidecar.orig.js` | `4cb84f038425d1a693dc171f7e225104bb3e56d0faec2393be04eb3378976667` |
| New Host `bin/pi-desktop-host-core.exe` | `e87918b0cdf5c3700de879d985de6133ba391becdf67cc671b121e2107141e18` |
| Preserved injection `sidecar.js` | `13bdfde564e25ba3f843b06a4518a3d096a5c905766ea39a35eefdad478c90d7` |
| Backed-up previous `app.asar` | `4ac9f1f2e2e5940da4a7bed2e98238afa1f2dd2f5882866464034014ce3b2eea` |
| Backed-up previous `sidecar.orig.js` | `00e57375e75f8a7421f4708aeb50ad155f204a155955aa0852ac0f8b043c31ea` |
| Backed-up previous Host | `80ac91f03fad0956f0568ba38159fe2255eef41ba28cbf6ce3f9941c44d85c94` |

Backup: `E:\PI-Desktop-backups\detached-write-wait-20261110T094116Z`
(89 backed-up files, 90 deployed files, 12 protected files unchanged).

## Use and rollback

Fully exit the running instance (including the tray) and start
`E:\PI-Desktop\PI-Desktop.exe`. Keep D closed while E runs, as in previous
rounds.

To roll back, from the round scratch directory:

```bash
node deploy-e-resources.mjs rollback
```

## Limits

- The two-page state consistency is covered by node-level renderer tests
  (`subagent-topology`, `session-runtime-updates`), not by installed UI
  automation; the installed run covers the runtime behavior (child survives a
  parent stop, main session accepts another prompt).
- The five subagent definitions still pin a disabled provider. Fixing that is a
  change to user configuration and was left to the user; until it is done, those
  definitions show an empty model and cannot bind one.
- `rustfmt` and `clippy` are not installed in this environment, so neither was
  run.
- The 19 pre-existing host-core failures, the historical desktop/native
  failures, and the unsigned release gate are unchanged and unverified.
