# E-drive native DNS and subagent deployment

Date: 2026-11-08
Status: Deployed; isolated installed-application acceptance passed.

## Installed target

- Executable: `E:\PI-Desktop\PI-Desktop.exe`
- Application build marker: `personal-workflow-dns-subagent-20261108`
- Backup: `E:\PI-Desktop-backups\dns-subagent-20261108T070040Z`
- The running `D:\PI-Desktop` installation was not replaced, stopped, or restarted.
- To use this build, fully quit the D-drive application, including its tray process, then launch the E-drive executable. Do not run both installations against the real user database simultaneously.

This deployment supersedes the **not deployed** state of the earlier [source verification snapshot](dns-subagent-recovery-verification.md). That snapshot remains unchanged as historical evidence.

## Replacement scope

Only these three resource units were replaced, after confirming that E had no running processes:

1. `resources/app.asar`
2. `resources/agent-runtime` (complete, matching entry and chunk set)
3. `resources/bin/pi-desktop-host-core.exe`

The deployed replacement set contains 88 files; the rollback set contains 87 files. Both sets were read back against SHA-256 manifests after installed-app acceptance. The existing Electron executable, external native dependencies, and all 11 ASAR-unpacked files were preserved. The archive contains 587 files, with application output rebuilt from the unified worktree and existing dependencies preserved.

No installer, NSIS executable, ZIP, or plugin package was generated. No installation or dependency installation was performed. The Git index, HEAD, paused rebase, and lockfile were preserved.

Real user settings, DNS preferences, provider credentials, subagent definitions, and conversation databases were not edited. The original development plugin at `G:\pi\pi-masquerade-lite` remained read-only. Its existing bootstrap was preserved; the new original sidecar, complete chunks, and injection-state hashes were updated together. Recovery's read-only reconciliation check passed without requesting a bootstrap rewrite.

## Installed hashes

| Resource | SHA-256 |
| --- | --- |
| `resources/app.asar` | `80d442b08070e304a40363eba269df73dd8af089a34ec1bdbf787216d97a163c` |
| `resources/agent-runtime/sidecar.orig.js` | `8dc658c6bd9d7544c3f035b2664c411d6c992a236a41e93074fa7de8d73b5fc0` |
| `resources/bin/pi-desktop-host-core.exe` | `80ac91f03fad0956f0568ba38159fe2255eef41ba28cbf6ce3f9941c44d85c94` |

The host was taken from the newly built `target/release` output, not the stale explicit-target directory. Its imported DLL list contained Windows system libraries; the existing supplementary DLL was left untouched. The installed host started successfully during acceptance.

## Fresh installed-app acceptance

The test launched the actual E-drive executable three times against one isolated test profile, including an immediate-exit/restart scenario. Final result: **33 checks passed, exit code 0; 29 loopback model-fixture requests; no fixture-service or unhandled renderer errors**.

Verified paths:

- Native DNS UI is present in the installed renderer.
- Enabling DNS and editing the endpoint persist through renderer, IPC, and native host.
- An unrelated settings patch preserves strict DNS; disabling DNS retains its endpoint and fallback preference.
- DNS preferences survive an installed-app restart.
- User-created and model-created children can be stopped and continued.
- Old delegation IDs resolve the latest successor through TaskList, TaskRead, and TaskWait, both live and after restart.
- Stopping an active parent leaves the delegated child stream alive.
- The parent session accepts another prompt while that detached child remains active; the child's eventual result is persisted.
- First-reply interrupted user-created and model-created children continue after restart using their saved original task.
- The preserved injection bootstrap loads the new runtime and reports a patched model-context adapter to an isolated control listener.
- Normal teardown completes without unhandled renderer errors. Final process inspection found no running E-drive process.

### Model and data isolation

The test used an environment-variable allowlist, temporary home/profile/data/database/agents directories, an empty model configuration, and an explicitly configured unauthenticated loopback provider. MCP enumeration was asserted empty. Injection logs and the control listener used separate temporary paths and a dynamically allocated loopback port, not port 8800.

All 29 model requests reached `http://127.0.0.1:56654`; the injection control fixture used port 56653 with an empty route table. No real provider was configured or invoked by the acceptance test. No background model delegation was used to carry out this deployment. The assistant conversation itself continues to use the user's selected conversation model.

### Earlier acceptance attempts

Failures remain in the evidence rather than being overwritten:

1. The first attempt timed out on an English settings label because direct IPC settings changes had not refreshed the renderer language. It made zero model requests. The harness now restarts after initial language setup.
2. The second attempt started a new parent turn while an undetached child still owned the current turn, correctly receiving `AGENT_BUSY`. The harness was corrected to test an active parent that delegates a child and is then stopped. Production concurrency rules were not weakened.
3. The final attempt passed all 33 checks.

An initial assembly check also referenced an absent plugin `package.json`. This was corrected to protect its absence; the failed receipt remains available. No E-drive files were replaced until the corrected assembly checks passed.

## Backup and evidence

The backup contains the original three resource units, `resource-manifest.json`, `deployment-journal.json`, `deployment-readback.json`, and a `verification` directory. These records include old/new file hashes, build receipts, final acceptance results, failed attempts, injection heartbeat evidence, and the bounded acceptance script. Evidence hashes are recorded in `verification/SHA256SUMS.json`.

To roll back manually:

1. Fully exit PI-Desktop and confirm no executable from `E:\PI-Desktop` is running.
2. Preserve the current three replacement units in a separate folder if desired.
3. Restore `app.asar`, the **entire** `agent-runtime` directory, and `bin\pi-desktop-host-core.exe` from the backup into `E:\PI-Desktop\resources`.
4. Do not merge old and new runtime chunks. Do not alter the real user-data directory or the D-drive installation.

Backup contents were hash-verified. A destructive rollback was not performed after successful acceptance.

## Remaining limitations

- This is an isolated installed-app acceptance, not a live-data migration or a real external provider/DoH-endpoint test.
- The preceding source-level Chromium DoH fixture passed seven checks; this deployment test verifies the installed DNS UI and persistence, not an external resolver.
- Some existing subagent definitions reference a provider that is no longer configured. This deployment does not silently change those model bindings; the user must choose an available provider/model for affected definitions.
- No overnight or 35-minute plugin stability soak was completed.
- Historical unrelated full-suite failures, missing Rustfmt/Clippy, and unsigned release/signing gates remain as recorded in the source verification snapshot. This deployment does not claim those gates passed.
