# E-drive safe steering and legacy subagent continuation deployment

- Date: 2026-11-08
- Target: `E:\PI-Desktop`
- Status: deployed and verified against the actual installed executable
- Backup: `E:\PI-Desktop-backups\safe-steering-20261108T100913Z`
- Local build marker: `personal-workflow-safe-steering-20261108`
- Previous deployment: [DNS and subagent recovery](e-drive-dns-subagent-deployment.md)

## Delivered behavior

1. Ordinary user directions sent to a running child enter the first model request
   after the active model response/tool batch completes. Already-started tools
   are not cancelled. Messages must be committed before use and preserve FIFO
   order. An explicit queued model change remains a follow-up boundary and an
   ordering barrier.
2. Continuing a legacy child retains its actual provider/model account. Old Task
   results can omit `modelKey` even when their own assistant replies contain
   `providerId` and `modelId`. History reconstruction now uses that evidence,
   without borrowing parent, sibling, or foreign-agent rows. New runs persist
   exact account identities rather than vendor/name aliases.
3. A missing, revoked, unknown, or ambiguous binding does not silently select a
   definition/session default. Resume fails before creating a successor; the
   user can explicitly select a currently authorized model in the child panel.
   Same-model matching of model-only legacy history must be unambiguous.
4. A rejected `Task(resume)` that never created a delegation is not a successor.
   Its error stays visible separately instead of replacing the original chain's
   model display and usable continuation id.

These changes retain current model authorization, context/read budgets, private
child history, parent/child execution ownership, cancellation, explicit recovery,
and the previous native DNS and plugin watcher fixes. No database migration or
real subagent-definition rewrite was required.

## Root cause and failure evidence

A bounded read-only projection of the existing session confirmed legacy Task
results without `modelKey`, with actual account identity still present on child
assistant rows. No task bodies or credentials were copied into this report.
The old runtime ignored those reply identities; it either matched an unrelated
same-named session model or fell back to the definition default. Separately,
renderer chain grouping treated rejected Task attempts as successors, so their
empty model metadata replaced the original display.

- `subagent-resume-model-red.log`: three functional failures, including valid
  original accounts rejected because an unrelated definition default was absent,
  and an unavailable original account silently replaced by the session default.
- `subagent-resume-display-red.log`: original model became an empty string after
  a rejected Task resume.
- `subagent-safe-steering/legacy-installed-red-v3.log`: the old installed E build
  requested the wrong loopback account after restoring keyless legacy history.
- `subagent-safe-steering/installed-red-v4.log`: the old installed E build accepted
  two directions while a real tool ran, but its first post-tool request omitted
  both directions.

Preparation failures are retained separately: legacy installed attempts 1 and 2
failed because of an old-window locator and asynchronous directory navigation,
not product behavior. The first combined runtime check also exposed a legitimate
same-account inheritance compatibility gap, which was fixed and retested.
The initial i18n invocation used Node rather than the package's configured
Vitest runner; the correct invocation passed.

## Fresh source checks

Counts below describe separate invocations and are not added together.

| Check | Result |
| --- | --- |
| Runtime integration: 14 selected files, including steering, legacy history, stop/restart, recovery, context, fallback and retry | 298 passed |
| Runtime resume contracts: name-filtered `runtime.test.ts` | 29 passed; 374 excluded by filter |
| Renderer/direct-control/transcript/execution tests: 4 selected files | 31 passed |
| i18n catalogs, renderer keys and user-facing copy | 31 passed |
| Runtime TypeScript no-emit | exit 0 |
| Desktop TypeScript no-emit | exit 0 |
| Shared, plugin SDK, agent runtime, host runtime and i18n compilation | exit 0 |
| Desktop build and complete runtime bundle | exit 0 |
| Git diff whitespace check | exit 0 |
| Prior source protection checks, excluding intentionally changed runtime/subagent implementation | 27 checks passed |

## Fresh installed-executable acceptance

Every launch used `E:\PI-Desktop\PI-Desktop.exe` with independent profile, data,
SQLite, home, agents and empty MCP directories; empty external models configuration;
explicit no-auth loopback providers; an environment allowlist; and a separate
injection control port/log directory. No real provider API or API key was used.
All test processes were closed before deployment readback.

| Scenario | Result | Evidence directory basename |
| --- | --- | --- |
| User-created child: real host tool, two live directions, immediate next-request steering, completion, restart, keyless legacy history, unavailable definition default and same-model decoy parent account | 11 checks; 3 child requests; 0 wrong-account requests | `installed-steering-pa7tys` |
| Parent Task-created child: same steering and legacy continuation scenario | 11 checks; 3 child requests; 0 wrong-account requests | `installed-steering-B0uLaD` |
| Legacy Task history also contains a rejected resume: original model display and usable continuation identity survive | 7 checks; 3 child requests; 0 wrong-account requests | `installed-steering-gY5th9` |
| Native DNS controls/persistence, user/model-owned child stop/continue, parent stop independence, old-id read/wait/list successors, interrupted-before-first-reply restart recovery and injection | 33 checks; 29 loopback requests | `deployed-e-acceptance-h4ynHs` |

Parent-model fixture requests are separately counted in individual receipts.
Installed scenarios overlap; these are not a full application-suite total.
There were no recorded renderer or fixture server errors in successful runs.

## Replaced resources and integrity

Only `resources/app.asar` and the complete `resources/agent-runtime` directory
were replaced, after a same-volume prepare/hash/rename backup. The current Host
binary, Electron shell, 11 unpacked dependency files, original injection wrapper,
D installation and real development plugin source remained unchanged.

| Resource | SHA-256 |
| --- | --- |
| New `app.asar` | `4ac9f1f2e2e5940da4a7bed2e98238afa1f2dd2f5882866464034014ce3b2eea` |
| New `agent-runtime/sidecar.orig.js` | `00e57375e75f8a7421f4708aeb50ad155f204a155955aa0852ac0f8b043c31ea` |
| Preserved injection `sidecar.js` | `13bdfde564e25ba3f843b06a4518a3d096a5c905766ea39a35eefdad478c90d7` |
| Preserved Host executable | `80ac91f03fad0956f0568ba38159fe2255eef41ba28cbf6ce3f9941c44d85c94` |
| Backed-up previous E `app.asar` | `80d442b08070e304a40363eba269df73dd8af089a34ec1bdbf787216d97a163c` |
| Backed-up previous E `sidecar.orig.js` | `8dc658c6bd9d7544c3f035b2664c411d6c992a236a41e93074fa7de8d73b5fc0` |

Readback verified 88 deployed files, 87 backup files and 13 protected file
states. The ASAR contains 587 files. Runtime chunks, original entry, injection
state/backup hashes and retained historical entry backups were verified as a
complete set. The injector's read-only reconciliation reported installed with
no bootstrap changes needed. Git HEAD, paused rebase state, index and lockfile
were preserved.

The backup contains `resource-manifest.json`, `deployment-journal.json`,
`deployment-readback.json`, and a `verification/` evidence collection with its
own SHA-256 inventory. Scratch staging is
`subagent-steering-resume-final/deploy-e-dns-subagent`; the earlier safe-steering
candidate was not deployed and remains historical evidence.

## Use and rollback

Exit the D client completely, including its tray process, before opening
`E:\PI-Desktop\PI-Desktop.exe` for normal use. Deployment did not stop D.
Running D does not load the newly updated E resources.

Rollback requires E to be fully closed. Restore the backup's `app.asar` and
entire `agent-runtime` directory together; do not mix runtime entry/chunks or
injection state from different versions. The task's journaled deployment script
also has a guarded rollback mode for this staging directory. Keep Host and user
data untouched.

## Limits

This is a targeted program-resource update, not an installer/release validation.
No NSIS/ZIP/plugin package, installation, dependency update, signing, real
provider test, live-data migration test or long-running soak was performed.
Previous unrelated full-suite failures and missing Rustfmt/Clippy tools remain
outside this task; this report does not claim those gates are green. Native DNS
UI/persistence was retested here; the prior transport-level DoH fixture evidence
remains in the previous deployment report.
