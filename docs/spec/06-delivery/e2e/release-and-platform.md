# E2E Scenarios: Release, Platform, and Storage

> Part of the [E2E test plan](../04-e2e-test-plan.md). Packaging, boot, hardening, storage, configuration sync, power, and platform integration.
> Scenario template, gates, and traceability live in the plan.

## Windows background process snapshot clock

- **Preconditions:** Isolated Windows Host and a synthetic background task.
- **Steps:** Start a child and grandchild after Host startup, exercise stopping
  through the production process-tree helper, and observe both owned processes.
- **Expected:** Children created before the snapshot are not rejected as recycled
  PIDs merely because they started after the Host. Descendants terminate before
  their parent; unrelated/newer processes remain excluded and failures surface.
- **Coverage:** `windows_process_tree` unit tests, including a real owned child
  creation-time check; `e2e-background-tasks-host.mjs` for the Host workflow.
- **Qualification:** A foreign-API fixture and Windows target compilation are
  separate from native Windows execution; record which actually ran.

## E2E-RUNTIME-text-tool-call-diagnostic

- **Preconditions:** Isolated runtime with a fixture provider and synthetic data.
- **Steps:** Return a complete text-form Qwen `TodoWrite` call, alone and after
  normal prose. Repeat alongside a valid structured Bash call. Then return a
  normal answer. Repeat with fenced/inline/quoted/indented XML examples,
  incomplete blocks and an unknown tool name.
- **Expected:** The literal known-tool call retains its text and displays
  `TOOL_CALL_NOT_EXECUTED` with error message status. It never executes or
  activates the text-form tool, and never retries automatically. Structured
  sibling calls execute once and normal continuation succeeds. Examples,
  unknown names and incomplete blocks remain ordinary text.
- **Coverage:** `text-tool-call.test.ts`, `malformed-tool-recovery.test.ts`.

## E2E-STORAGE-custom-location-and-maintenance

- **Preconditions:** Dedicated request worktree, current remote-main base, shared
  compatible host toolchain, built host-core and desktop, isolated temporary data
  and Chromium profiles. No user's running desktop, provider, or network is used.
- **First-install / new-directory regression:** Run
  `node scripts/e2e-storage-directory.mjs` with `PI_DESKTOP_HOST_BIN` pointing
  to the candidate Host. The production storage controls and preload invoke real
  Main handlers through native mouse clicks, schedule cold maintenance, and reopen
  the migrated Electron profile and Host. Cover an absent data root with missing
  parents and an existing conversation with attachments, settings and project
  memory. The chosen destination initially does not exist. Set
  `PI_STORAGE_E2E_SOURCE_ROOT` to a temporary folder on a different drive for
  cross-volume coverage. Verify browser localStorage, conversation/attachment
  reads, project-memory lookup, original backups and the displayed new path.
  Only native picker selection and relaunch dispatch are scripted; each startup
  phase is a separate real Electron process. Keep screenshots and synthetic
  profiles under `.artifacts/` for inspection rather than deleting them.
- **Electron filesystem regression:** Run `node scripts/e2e-storage-files.mjs`
  in real Electron, not `ELECTRON_RUN_AS_NODE`. Seed valid and opaque `.asar`
  files, live and dangling file/directory links, Unicode paths, and a destination
  collision. Expect byte-preserving copies, relocated internal links, unchanged
  external targets, and path-specific errors without mutating originals. The
  existing-profile Settings journey also includes an archive and a dangling
  dependency junction, then verifies history and browser state after reopening.
- **Steps:** Through the production Settings page, choose/cancel a destination,
  confirm/retry migration, and confirm cache/backup cleanup. Seed a real host with
  sessions, queued attachments, project metadata, credentials and a local installed
  plugin. Stop it, copy with the production migration service, invoke the real Rust
  offline relocation process, and reopen the host. Seed default/persistent Chromium
  localStorage, execute the production cold bootstrap in real Electron, restart with
  its pointer, clear caches, and then separately remove old backups.
- **Expected:** Data and browser source paths are visible, confirmation receives
  focus, duplicate actions are locked, environment overrides disable changes and
  failures allow recovery. Copy/verification/path-relocation progress is localized
  and uses a sandboxed nonpersistent window. Host data, credential decryption,
  installed plugin locations, main localStorage and plugin persistent storage
  survive migration/restart. Cache cleanup preserves durable state; backup cleanup
  retains active data and the stable bootstrap pointer. Filesystem regression tests
  reject unsafe targets, redirecting links, wrong ownership and active-root overlap.
- **Missing default root recovery:** Run `node scripts/e2e-storage-bootstrap.mjs`
  with the managed default data root absent. Stub the native choice and folder
  dialogs at the Electron API boundary, then exercise both decisions in isolated
  launches: creating a fresh default profile, and selecting an existing storage
  root containing `data/pi.sqlite`. Confirm the pointer is normalized only after
  the selected action succeeds, the selected database remains byte-for-byte
  intact, and dismissing the choice leaves the pointer unchanged. Also compare
  Windows path variants with slash and case differences in the offline regression
  test so they still enter this recovery path.
- **Windows junction spelling:** The filesystem suite includes a Node-created
  junction whose target ends with a separator. Copying it in Electron must
  preserve the target without a false symbolic-link verification failure.
- **Installation lock and cleanup retry:** `e2e-storage-backup-lock.mjs` holds a
  real Electron single-instance lock while retrying cleanup with the old data
  already absent. Verify the lock, bootstrap pointer and current history remain.
  The Settings directory suite additionally confirms cleanup, cold-restarts and
  reopens the active Host; backup controls disappear and current attachments and
  browser state remain readable. These retry fixtures are not full-payload
  deletion tests and retain their synthetic profiles.
- **Coverage:** `pnpm test:e2e:storage` runs `e2e-storage-settings.mjs`,
  `e2e-storage-migration.mjs`, `e2e-storage-bootstrap.mjs`,
  `e2e-storage-directory.mjs`, `e2e-storage-files.mjs`, and
  `e2e-storage-backup-lock.mjs`. The first uses the
  production renderer/API with only preload mocked; the latter suites run real
  host/Electron processes and production maintenance. The bootstrap harness
  intercepts relaunch to inspect its result, then explicitly starts another isolated
  child; it does not launch the user's desktop. The same bootstrap harness
  exercises missing-default recovery without showing native dialogs.
  `storage-maintenance.test.mjs` and Rust `data_relocation` tests cover rollback
  and path/filesystem boundaries.

## E2E-LEGACY-DICTATION-idle-model-release

- **Preconditions:** Exercise the retained local Dictation service through its
  `VoiceService` interface with a deterministic controller/model-manager stub
  and a controlled clock. Do not access a physical microphone or download a
  model.
- **Steps:** Start and stop a recording, advance time to just before and then
  to the 10-minute idle boundary, and inspect unload calls. Repeat with a new
  recording before the boundary, a rejected new start, an error terminal phase,
  and service disposal.
- **Expected:** A settled idle model unloads once at the boundary, never early.
  A new recording cancels the timer and its terminal phase starts a fresh
  window. A rejected start does not strand the unload. An active phase at the
  callback or service disposal prevents unloading.
- **Coverage:** `apps/desktop/test/voice-service-idle-unload.test.mjs` runs the
  production `VoiceService` lifecycle with only the runtime and clock mocked.
  The separate Linux RSS measurement verifies that `TranscribeModel.dispose()`
  returns memory to the OS and that the existing lazy-load path reloads it.
- **Specs:** [Live Voice](../../03-runtime/live-voice.md).

## E2E-POWER-keep-awake-setting

- **Preconditions:** An isolated desktop profile with the setting absent; no
  live provider is required.
- **Steps:** Open Settings > General and enable Keep computer awake. Confirm the
  main process owns one `prevent-app-suspension` blocker while idle. Close and
  reopen the app using the same profile; confirm it restores one blocker.
  Enable and disable Prevent screen sleep while Keep computer awake stays on,
  confirming the independent system request remains. Disable Keep computer awake
  and confirm its blocker is released; then quit and confirm cleanup.
- **Expected:** The setting persists, acts immediately, never starts duplicate
  blockers, and releases on disable or app shutdown. The display switch keeps
  its own blocker and cannot disable the system blocker. Manual sleep and lid
  close are outside this contract.
- **Status:** Automated in `pnpm test:e2e:keep-awake`, with a real isolated
  Electron/Host profile and a Windows `powercfg /requests` assertion when no
  other Electron power request is present at baseline. Controller lifecycle
  and Host settings round-trip also have targeted tests.

## Runtime Resource Governance

## E2E-097: Tool burst is bounded and recovers after host restart

- **Preconditions**: Host-core is healthy; one session has a workspace; the
  supervision probe can terminate the host process.
- **Steps**: 1) Dispatch a burst larger than the host tool budget containing
  read tools and shell commands. 2) Observe `app.health` while the burst runs.
  3) Terminate host-core during active calls. 4) Wait for one supervised
  restart. 5) Allow the persistence outbox to flush.
- **Expected**: Active shell processes never exceed the configured global and
  per-session limits. Excess work returns `HOST_OVERLOADED` or waits in the
  bounded queue. Queued requests do not reserve execution capacity: with four
  running Bash calls and twelve queued Bash calls, another session can still
  Read and Write. A saturated session cannot reserve spare class capacity, and
  admission-future cancellation/timeout restores queue and execution counters.
  Only one restart loop runs; stale-generation calls fail fast
  as `HOST_UNAVAILABLE`; no repeated `ERR_STREAM_DESTROYED` persistence storm
  is emitted. Temporary OS thread pressure during the same burst does not
  terminate host-core through its stdio control path; the host remains on one
  generation and capacity errors stay structured. Completed assistant/tool
  messages are persisted once after recovery.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/07-process-model.md`, `03-runtime/08-error-codes.md`,
  `03-runtime/09-logging-and-observability.md`, ADR 0051
- **Acceptance**: A (runtime health), C (tool execution and recovery)
- **Milestone**: M5
- **Status**: Cross-session admission is automated by
  `node scripts/e2e-tool-admission.mjs` against an isolated real host. Class,
  session, global, mutation, queue bounds, fairness, cancellation, and timeout
  are unit-covered by `tool_budget/tests.rs`; restart coverage remains pending.

## Release & Packaging

## E2E-192: Linux release publishes a system-Electron ASAR asset

- **Preconditions**: A `vX.Y.Z` tag matches `apps/desktop/package.json`; the
  Linux x64 release runner can complete `dist:linux` and has a system Electron
  available for repackaging validation. The arm64 lane is E2E-192a.
- **Steps**: 1) Run the tag release workflow. 2) Inspect the published GitHub
  Release assets. 3) Confirm the versioned
  `PI-Desktop-X.Y.Z-linux-x64.asar` asset is present. 4) Place that archive in
  the target Electron resources layout with the target package's native host
  and other resources, then launch it with `electron <archive>.asar`.
- **Expected**: The ASAR is copied byte-for-byte from
  `linux-unpacked/resources/app.asar`, is uploaded alongside the Linux
  AppImage, deb, and rpm, and the system Electron opens the PI-Desktop application
  archive without requiring the bundled Electron executable.
- **Specs linked**: `06-delivery/06-release-runbook.md`, `03-runtime/07-process-model.md`
- **Acceptance**: Quality (release artifact and packaging compatibility)
- **Milestone**: M6+
- **Status**: Documented; artifact export is unit-covered, native system-Electron
  repackaging remains runner validation

## E2E-192a: Linux arm64 release lane publishes native arm64 packages

- **Preconditions**: A `vX.Y.Z` tag matches `apps/desktop/package.json`; GitHub's
  arm64 `ubuntu-22.04-arm` runner is available to the repository.
- **Steps**: 1) Run the tag release workflow. 2) Confirm the arm64 lane ran on
  an `aarch64` runner and that the packaged
  `target/release/pi-desktop-host-core` is an AArch64 binary. 3) Inspect the
  published Release assets for `PI-Desktop-X.Y.Z-linux-arm64.AppImage`,
  `pi-desktop_X.Y.Z_arm64.deb`, `pi-desktop-X.Y.Z-aarch64.rpm`,
  `PI-Desktop-X.Y.Z-linux-arm64.asar`, and
  `pi-host-X.Y.Z-linux-arm64.tar.gz` with its `.sha256`. 4) Confirm
  `latest-linux.yml` still lists the x64 AppImage while
  `latest-linux-arm64.yml` lists the arm64 one. 5) Install the arm64 AppImage,
  deb, or rpm on an arm64 Linux machine and launch it.
- **Expected**: Both feeds describe exactly one architecture-labelled AppImage
  each, the arm64 packages carry an arm64 host-core, the app starts on arm64
  Linux, and merging the lanes never replaces the x64 feed with the arm64 one.
- **Specs linked**: `06-delivery/06-release-runbook.md`, `01-product/01-product-scope.md`
- **Acceptance**: Quality (release artifact and packaging compatibility)
- **Milestone**: M6+
- **Status**: The matrix, feed naming, artifact naming, and the ASAR export are
  unit/source-contract covered (`ci-workflow.test.mjs`, `release-asar.test.mjs`);
  native arm64 installation remains runner validation. Microphone capture stays
  Raspberry Pi only on arm64 Linux (D638 / ADR 0318).

## E2E-200: Linux RPM preserves the Wayland desktop identity

- **Preconditions**: A Linux x64 package validation run or tag release can
  complete on Ubuntu 22.04; a clean Fedora 44 KDE/Wayland machine is available
  for installation and launch.
- **Steps**: 1) Build the Linux targets and inspect the RPM with `rpm -qip` and
  `rpm -qpl`. 2) Confirm the package contains the application archive,
  host-core, `pi-desktop.desktop`, and the 512px `pi-desktop` icon. 3) Confirm
  the RPM has no global `/usr/lib/.build-id` links. 4) Install the RPM on the
  Fedora KDE/Wayland machine and launch PI-Desktop from its desktop entry.
  5) Inspect the taskbar grouping and the installed desktop entry.
- **Expected**: The x64 RPM is produced with the documented name and uploads
  with the release artifacts. Its desktop entry contains `Icon=pi-desktop` and
  `StartupWMClass=pi-desktop`; the running Wayland window groups with the
  PI-Desktop launcher and shows its icon instead of a generic Electron icon.
  The package remains notify-and-link for updates, and the bundled Electron
  binaries do not create global build-id links.
- **Specs linked**: `01-product/01-product-scope.md`,
  `04-ux/09-interaction-patterns.md`, `06-delivery/06-release-runbook.md`
- **Acceptance**: Quality (release packaging and desktop integration)
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`auto-update.test.mjs`,
  `development-branding.test.mjs`, `ci-workflow.test.mjs`); Fedora KDE/Wayland
  installation remains runner validation

## E2E-196a: Unsigned macOS debug lane

- **Preconditions**: The Release workflow is manually dispatched with
  `sign_macos: false`; Windows and Linux release credentials are not affected.
  This path must not be used to publish a GitHub Release tag.
- **Steps**: 1) Dispatch the Release workflow with `sign_macos: false`. 2)
  Confirm both macOS architectures complete ordinary DMG/ZIP packaging without
  certificate secrets. 3) Inspect the artifacts and workflow steps.
- **Expected**: macOS DMG/ZIP artifacts are produced and uploaded without
  Developer ID signatures or notarization, using explicit `-arm64` and `-x64`
  filename markers for their native architecture; macOS staple and Gatekeeper
  checks are explicitly skipped. Windows/Linux artifacts and the merged updater
  feed still publish normally. This exception does not satisfy E2E-196c.
- **Specs linked**: `06-delivery/06-release-runbook.md`
- **Acceptance**: Quality (debug packaging)
- **Milestone**: M6+
- **Status**: Opt-in debug lane; tag releases must satisfy E2E-196c.

## E2E-196b: macOS packages omit first-launch helper assets

- **Preconditions**: An unsigned macOS debug packaging run has produced DMG and
  ZIP artifacts for at least one native architecture.
- **Steps**: 1) Inspect the DMG and confirm the app and Applications link are
  the only items in its window. 2) Inspect the ZIP root without extracting the
  app and confirm neither `PI-Desktop-macOS-opening-help.txt` nor
  `PI-Desktop-macOS-open.command` is present. 3) Confirm the app remains
  installable from the ZIP.
- **Expected**: The DMG contains the branded 720×440 background, the app, and
  the Applications link only. The ZIP contains the app but neither first-launch
  guidance asset. The same omission applies to signed and unsigned macOS
  artifacts; signing, notarization, and updater behavior are unchanged.
- **Specs linked**: `06-delivery/06-release-runbook.md`,
  `05-security/01-security.md`
- **Acceptance**: Quality, Security
- **Milestone**: M6+
- **Status**: Automated by `packaging-footprint.test.mjs`; native archive
  inspection remains release-runner validation

## E2E-196c: macOS tag artifacts pass Gatekeeper without a quarantine bypass

- **Preconditions**: A `vX.Y.Z` tag matching `apps/desktop/package.json` is
  pushed, or the Release workflow is dispatched with `sign_macos: true`
  (default); GitHub Actions has `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` secrets; both native macOS
  runners are available.
- **Steps**: 1) Run the tag workflow. 2) For each macOS architecture, inspect
  the unpacked app with `codesign -dv --verbose=4` and confirm authority
  `Developer ID Application: XingYu Liu (DUV63RKYTW)`. 3) Run
  `codesign --verify --deep --strict --verbose=2`,
  `spctl --assess --type execute --verbose=4`, and `xcrun stapler validate`
  against the app, including `Contents/Resources/bin/pi-desktop-host-core`.
  4) Confirm the app stapler shim retries `xcrun stapler staple` and
  `xcrun stapler validate` up to six total attempts after the app submission
  is accepted, then confirm the workflow's DMG step reported an Apple notary
  status of `Accepted` and stapled and validated the matching DMG. A transient
  CloudKit lookup failure during validation is retried within the same bound.
  5) Download the DMG on a clean macOS profile, move the app to
  `/Applications`, and open it without clearing `com.apple.quarantine`.
- **Expected**: Each macOS app passes signature integrity, Gatekeeper reports
  `source=Notarized Developer ID`, and both app and DMG contain valid stapled
  tickets. The DMG has its own submission: a DMG that was never submitted has
  no ticket and fails `stapler staple` with error 65, so a tag build must never
  reach that state. The app opens normally; no `xattr` quarantine-removal
  command or Security & Privacy override is required. Missing secrets, a
  rejected submission, or exhausted staple or validation retries fail the job.
- **Specs linked**: `06-delivery/06-release-runbook.md`,
  `05-security/01-security.md`, ADR 0289
- **Acceptance**: Quality, Security
- **Milestone**: M6+
- **Status**: Workflow script/unit-covered; clean-machine journey required for
  each release (run only in a capable environment when this surface changes)

## E2E-212: GitHub Release starts the CNB mirror pipeline

- **Preconditions**: Repository secret `CNB_MIRROR_TOKEN` is configured on
  `vastsa/PI-Desktop`; the CNB pipeline at `aixk/Pi-Desktop` listens for
  `api_trigger_mirror`; a GitHub Release tag such as `vX.Y.Z` exists with
  uploaded artifacts.
- **Steps**: 1) Publish or edit that GitHub Release, or dispatch
  `mirror-to-cnb.yml` with the same tag. 2) Inspect the Actions log for the
  resolved tag and the POST to `api.cnb.cool`. 3) Confirm the CNB pipeline
  starts with `MIRROR_TAGS` equal to that tag.
- **Expected**: The job runs only on `vastsa/PI-Desktop`. Manual dispatch
  without a `vX.Y.Z` tag fails before calling CNB. A missing
  `CNB_MIRROR_TOKEN` fails closed. The JSON body is built with `jq` (not
  YAML string interpolation). GitHub Release artifacts and updater feeds are
  unchanged; CNB is a mirror of the same tag.
- **Specs linked**: `06-delivery/06-release-runbook.md`
- **Acceptance**: Quality (release mirroring)
- **Milestone**: M6+
- **Status**: Source-contract covered (`ci-workflow.test.mjs`); live CNB
  start remains operator validation (run only in a capable environment when this surface changes)

## Boot & Healthcheck

## E2E-001: App launches and shows main window

- **Preconditions**: macOS arm64 or Intel x64; no prior `~/.pi-desktop` profile. For the
  development lane, workspace package build outputs are absent or older than
  their TypeScript sources.
- **Steps**: 1) Launch PI-Desktop. In the development lane, use `pnpm dev`.
  2) Observe main window appears. In the macOS development lane, confirm the
  menu-bar tray icon appears.
- **Expected**: Development launch rebuilds all workspace dependencies before
  host-core and Electron startup. Window first shows the branded startup splash
  while bootstrap runs, then reveals the main shell in English with the current
  locale catalog; no compile error, missing-menu runtime error, or crash;
  version info visible. The macOS development bundle contains both tray icon
  resources, and the tray starts without a missing-icon warning. Key lifecycle
  and error records are written to the categorized logs. GitHub auto-update is
  not started until after `ensureWindow`, and a hung feed cannot keep updater
  status on `checking` for Chromium's ~60s timeout. The Main output root also
  resolves from inside Rollup shared chunks (`out/main/chunks/*.js`), so the
  renderer entry, preloads, and the forked plugin host keep their authored
  relative paths instead of resolving one level too deep (black screen).
- **Specs linked**: `03-runtime/07-process-model.md`, `04-ux/01-ui-ia.md`,
  `03-runtime/09-logging-and-observability.md`
- **Acceptance**: A (app startup)
- **Milestone**: M1
- **Status**: Partially automated (`runtime-build-contract.test.mjs` covers the
  dependency build contract; `update-timeout.test.mjs` and
  `auto-update.test.mjs` cover the bounded auto-check contract;
  `main-module-path.test.mjs` covers the Main output-root contract from the
  entry bundle and from inside `out/main/chunks/`; Electron window
  launch remains Draft)

## E2E-002: IPC bridge is functional

- **Preconditions**: App is running.
- **Steps**: 1) Trigger an action that calls preload IPC (e.g. version query). 2) Observe result in renderer.
- **Expected**: Main↔renderer IPC returns expected data; no error. The packaged
  main and plugin-panel sandbox preloads are self-contained and do not require
  an additional local runtime chunk.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`
- **Acceptance**: A (bridge normal)
- **Milestone**: M1
- **Status**: Automated (`scripts/e2e-electron-boot.mjs` — sandboxed preload bridge + IPC round-trip)

## E2E-003: Rust host healthcheck responds

- **Preconditions**: App is running; Rust host-core sidecar started.
- **Cold-start timeout**: Let the first handshake time out, then allow a fresh
  host to answer. Verify the shell opens in the same desktop process. Repeat
  with both handshakes timing out and with quit during the first attempt.
  Verify the recovery surface stays available after two attempts and quit
  prevents a second child. The startup-host-retry tests inject these outcomes
  at the Main lifecycle boundary.
- **Steps**: 1) Electron handshakes with protocol version 11. 2) Call the host
  healthcheck RPC. 3) Repeat boot with mismatched older and newer protocol
  fixtures.
- **Expected**: The protocol v11 host returns `ok` and the handshake is logged.
  Every version other than v11, whether older or newer, is rejected before the
  conversation surface becomes interactive, so Plan approval/state events and
  context checkpoints cannot be silently lost.
- **Specs linked**: `03-runtime/05-host-core-rust.md`, `03-runtime/06-host-rpc-protocol.md`
- **Acceptance**: A (bridge normal)
- **Milestone**: M1
- **Status**: Automated (protocol smoke)

## E2E-004: First-run inline checklist appears

- **Preconditions**: Fresh profile (no `~/.pi-desktop`).
- **Steps**: 1) Launch app on fresh profile. 2) Observe onboarding checklist.
- **Expected**: Inline checklist is displayed; provider/key items open Settings
  → Agent, and the optional plugin item opens the app-shell Plugins
  destination.
- **Specs linked**: `04-ux/05-onboarding.md`
- **Acceptance**: A (first-run checklist)
- **Milestone**: M2
- **Status**: Automated (protocol smoke: host onboarding state; UI checklist manual)

## Security — No Secret Leakage

## E2E-027: Secrets not in logs for normal flows

- **Preconditions**: Provider configured with API key.
- **Steps**: 1) Perform a chat session. 2) Inspect log files.
- **Expected**: API keys / tokens not present in any log output for normal flows.
- **Specs linked**: `05-security/01-security.md`, `03-runtime/09-logging-and-observability.md`
- **Acceptance**: H (secrets not in logs)
- **Milestone**: M2
- **Status**: Automated (protocol smoke: provider list carries no secret material)

## E2E-028: Renderer has no Node integration

- **Preconditions**: App running.
- **Steps**: 1) Inspect renderer process flags.
- **Expected**: `nodeIntegration: false`; `contextIsolation: true`; preload is the only bridge.
- **Specs linked**: `05-security/01-security.md`
- **Acceptance**: Security (no Node in renderer)
- **Milestone**: M1
- **Status**: Draft

## E2E-029: Unwhitelisted IPC cannot be called

- **Preconditions**: App running.
- **Steps**: 1) Attempt to invoke an IPC method not on the whitelist from renderer.
- **Expected**: Call blocked; no data returned; error or no response.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `05-security/01-security.md`
- **Acceptance**: Security (IPC whitelist enforced)
- **Milestone**: M1
- **Status**: Draft

## E2E-030: Plugin cannot read API key

- **Preconditions**: Plugin loaded; provider configured.
- **Steps**: 1) Plugin attempts to access provider secret via any API. 2) Observe result.
- **Expected**: Access denied; no secret data returned to plugin.
- **Specs linked**: `07-plugins/04-plugin-security.md`, `03-runtime/14-secrets-storage.md`
- **Acceptance**: Security (plugin cannot read API key)
- **Milestone**: M4
- **Status**: Draft

## E2E-031: Error codes are stable and readable

- **Preconditions**: App launched through the normal desktop development
  command; provider configured.
- **Steps**: 1) Select or enter a model ID that the provider rejects. 2) Send a
  prompt. 3) Inspect the assistant error message and its detail disclosure. 4)
  Switch sessions and reload the failed session. 5) Repeat with an invalid
  provider key.
- **Expected**: The run stops and the transcript contains one durable
  `role=assistant`, `status=error` message instead of a toast, floating banner,
  or blank row. It shows a localized summary and stable
  `MODEL_NOT_CONFIGURED` or `PROVIDER_UNAUTHORIZED` code. Details expose the
  redacted provider response plus provider/model IDs and can be copied; no API
  key or Authorization value appears. The configuration failure links to
  settings, retriable failures offer Retry, the composer becomes usable again,
  and reload preserves the error message. The development launch executes a
  sidecar rebuilt from current runtime source.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/07-process-model.md`, `03-runtime/08-error-codes.md`
- **Acceptance**: C (failed chat settles), H (errors expose stable codes)
- **Milestone**: M2
- **Status**: Unit-covered (agent-runtime error message/redaction, host
  persistence, desktop transcript contract, and predev build contract); full
  Electron UI scenario Draft

## Hardening (M5)

## E2E-032: Backend crash triggers supervised restart

- **Preconditions**: App running; host-core and sidecar healthy.
- **Steps**: 1) Kill the host-core (or sidecar) process externally. 2) Observe app behavior.
- **Expected**: In-flight RPCs fail fast (no long hang); `hostStatus` shows degraded then restored; child restarts with backoff; after 3 failed restarts in 2 minutes the app stays degraded with a visible fatal status. Repeat the kill with the main window closed: the crash is still logged (with the child's last stderr lines), the child still restarts, and no unhandled renderer-send error appears — supervision is independent of a live window.
- **Specs linked**: `03-runtime/07-process-model.md`
- **Acceptance**: Quality (main path no crash)
- **Milestone**: M5
- **Status**: Automated (`scripts/e2e-supervision.mjs` — SIGKILL host-core, assert restart + healthy RPC)

## E2E-194: Broken stdout does not crash the main process

- **Preconditions**: Packaged or development app; a session can send a prompt.
- **Steps**: 1) Launch so stdout/stderr are a closed pipe (Linux AppImage from
  a desktop entry, or with the stdout reader closed). 2) Send a chat message.
  3) Confirm the main process stays up and the uncaught-exception dialog does
  not appear. 4) Quit and relaunch.
- **Expected**: No Electron "A JavaScript error occurred in the main process"
  dialog with `Error: write EPIPE` from `Logger.log`. NDJSON category logs still
  receive the prompt records. Relaunch still reaches the local host service
  instead of a fatal "Can't reach the local service" / “无法连接本地服务”
  status caused by a previous main-process crash.
- **Specs linked**: `03-runtime/09-logging-and-observability.md`,
  `03-runtime/07-process-model.md`
- **Acceptance**: H (diagnostics), Quality (main path no crash)
- **Milestone**: M5
- **Status**: Unit-covered (`logger-routing.test.mjs`); packaged AppImage
  journey Documented

## E2E-RUNTIME-non-ascii-http-header-does-not-show-main-exception-dialog

- **Preconditions**: Packaged or development app on a machine whose system
  HTTP proxy or gateway injects a non-Latin-1 response header (for example a
  value starting with U+661F), or a test that delivers the same
  `TypeError: Cannot convert argument to a ByteString` through Electron `net`.
- **Steps**: 1) Launch so the auto-updater check or model discovery issues a
  main-process `net.fetch` / Electron-updater request. 2) Confirm the native
  exception dialog does not appear. 3) Dismiss nothing; wait for a later
  updater or discovery request. 4) Open `~/.pi-desktop/logs/app/runtime.log`.
- **Expected**: No Electron "A JavaScript error occurred in the main process"
  dialog. The app stays running and does not quit. `runtime.log` contains an
  error record with `code: "NON_ASCII_HTTP_HEADER"` and `recoverable: true`.
  A later main-process HTTP request does not re-open the native dialog.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `03-runtime/09-logging-and-observability.md`
- **Acceptance**: H (diagnostics), Quality (main path no crash)
- **Milestone**: M5
- **Status**: Unit-covered (`main-process-errors.test.mjs`); packaged Windows
  proxy journey Documented

## E2E-195: Linux glibc below 2.35 names supported distros

- **Preconditions**: Linux x64 or arm64 packaged app; the machine glibc is older than
  2.35 (for example Ubuntu 20.04 / Debian 11 / Fedora 35), or a test doubles
  `process.report` to `2.31`.
- **Steps**: 1) Launch the AppImage, deb, or rpm. 2) Observe the main window and
  fatal banner. 3) Confirm host-core is not restarted in a loop.
- **Expected**: Electron still opens. There is no uncaught `write EPIPE`
  dialog. The fatal banner says the build needs glibc 2.35 or newer and names
  Ubuntu 22.04, Debian 12, and Fedora 36+. Restart supervision does not spin.
  A host-core binary whose symbols need glibc 2.39 fails
  `scripts/check-linux-host-glibc.mjs`.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `01-product/01-product-scope.md`, `06-delivery/06-release-runbook.md`
- **Acceptance**: H (diagnostics), Quality (main path no crash)
- **Milestone**: M5
- **Status**: Unit-covered (`linux-glibc.test.mjs`); packaged distro journey
  Documented

## E2E-143: Close behavior is asked once and stays configurable (D230)

- **Preconditions**: Windows/Linux run with a clean data dir (no
  `close-behavior.json`); the main window is visible; Settings → System is
  reachable. macOS is excluded: it keeps the native Dock lifecycle.
- **Steps**: 1) With the preference unset, click the close button (or press
  the close-window shortcut) and verify the themed in-app dialog opens with Cancel focused. Escape, a
  backdrop click, or Cancel keeps the window open and preference unset; Close to
  tray hides the window, shows the tray icon, and leaves a live turn running;
  Quit exits the app. Renderer-unavailable behavior uses the native fallback. 2) Re-run each choice and verify it is remembered across a
  full restart and that no second prompt ever appears once a choice exists.
  3) With `tray` set, click the tray icon: the window
  restores, shows, and focuses; the tray context menu offers Open and Quit,
  and Quit exits the app. 4) In Settings → System, switch between Close to
  tray / Quit app and verify the next close follows the new
  choice, that the D216 tray icon stays resident either way, that an unset
  preference shows no selection, and that search matches
  the row. 5) With `quit` stored, restart and close the window: the app
  exits even though the tray icon is present. 6) From any setting, use the
  renderer minimize control on Windows/Linux and verify the native taskbar
  entry remains available and restores the same window; on macOS verify its
  native minimize still hides to the tray. The Windows taskbar toggle is
  covered separately by E2E-124. 7) Invoke unknown values and `"ask"` on
  `pi-desktop/window/closeBehavior/set` and verify they fail closed, and
  verify the channel is rejected outright on macOS.
- **Expected**: The first close renders the themed dialog exactly once per unset state. Escape, backdrop click, or Cancel never persists a choice; if the renderer is unavailable, a bounded native fallback is used, and failure to show it does not trap close. Tray mode keeps the app alive with a
  localized tooltip/menu and no data loss; switching to Quit app leaves the
  tray icon in place, because close-to-tray and macOS minimize still need a
  restore surface. The preference survives restarts and is honored by both
  the window-control close button and the close shortcut, and a stored `quit`
  exits through the ordered `before-quit` shutdown rather than depending on
  `window-all-closed`. Windows/Linux renderer minimize remains taskbar-native;
  macOS native minimize remains tray-resident; the bounds watchdog never
  force-restores a minimized or tray-hidden window. The automated boot probe
  (`app.quit`) exits without prompting.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D216, D230, D256), ADR 0078, ADR 0090,
  ADR 0123
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5 on Windows/Linux (release qualification)
- **Status**: Themed renderer path, broker fallback, and Main close/quit choices
  are covered by `lifecycle-confirmation-dialog-user-path.test.mjs`,
  `lifecycle-dialog-broker.test.mjs`, and `lifecycle-close-behavior-runtime.test.mjs`;
  the full persisted close-behavior journey remains Draft.

## E2E-204: Explicit quit confirms before shutdown (D363)

- **Preconditions**: A normal interactive session is running (not a boot,
  supervision, or capture probe). The main window may be visible or tray-hidden.
- **Steps**: 1) Choose Quit from the tray menu, or press Cmd+Q / the
  application-menu Quit item. If tray-hidden, confirm the main window is restored.
  2) Verify the themed in-app confirmation, Cancel as initial focus, and distinct
  title/body. While it is open, issue a second Quit request and verify the same
  decision remains pending: no duplicate dialog and no shutdown bypass. Exercise
  Escape and a backdrop click; confirm the window, tray, host-core, and sidecar
  remain. 3) Repeat and Confirm; verify ordered shutdown. 4) On Windows/Linux
  with close behavior unset, close the window. Verify the themed D230 dialog
  offers Cancel / Close to tray / Quit: cancel leaves the preference unset, and
  choosing Quit causes no second dialog. 5) Launch with `PI_DESKTOP_BOOT_PROBE=1`
  (and supervision/capture equivalents) and confirm `app.quit()` exits without a
  dialog. 6) On packaged Windows NSIS or Linux AppImage, restart to install an
  update; confirm no quit warning appears and the installer completes upgrade
  and relaunch. On Windows, repeat with only a current-user install and only
  an all-users install. Verify each update skips the scope page and updates
  the same directory, accepting UAC if prompted for the all-users install.
  With both scopes registered, verify the installer asks which copy to update.
  Also verify a fresh interactive install offers both scopes.
- **Expected**: Accidental explicit quit is cancellable. Repeated quit requests
  cannot duplicate or bypass an outstanding confirmation; Cancel clears the
  pending decision so a later quit asks again. Tray Quit presents the dialog
  even when the main window was hidden. A D230 Quit is not re-confirmed. When the
  renderer is unavailable, crashes, or fails to answer, the bounded native
  fallback is used; failure to show it does not hold shutdown. Probes never
  block on the warning. An in-app update restart is never deferred: the installer
  is spawned before `app.quit()` and aborts if the app stays alive past its wait
  window, so that quit goes directly into ordered shutdown.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `08-meta/decisions-log.md` (D216, D230,
  D363), ADR 0022, ADR 0090
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Broker, renderer user path, Main close/quit runtime, and pending
  shutdown lifecycle covered (`lifecycle-dialog-broker.test.mjs`,
  `lifecycle-confirmation-dialog-user-path.test.mjs`,
  `lifecycle-close-behavior-runtime.test.mjs`, `close-behavior-tray.test.mjs`,
  `shutdown-regenerate-persistence.test.mjs`). For the Windows scope cases,
  compile `apps/desktop/test/nsis-update-scope.nsi` with `makensis` and run
  the resulting executable. Exit code 0 means all scope cases passed.
  The full shutdown and packaged update journey remains Draft. Run it in a
  capable release environment when lifecycle wiring changes.

## E2E-067A: Prerelease install discovers newer stable release (D120)

- **Preconditions**: Packaged build whose embedded version is a prerelease such
  as `0.2.0-rc.6`; GitHub Releases latest stable tag is newer (for example
  `0.2.2`) with published `latest*.yml` feeds.
- **Steps**: 1) Launch the packaged prerelease install. 2) Wait for the
  automatic check or invoke Check for Updates from the application menu /
  Settings → Info.
- **Expected**: Update state reports `available` (manual platforms) or
  advances through in-app download for packaged macOS, Windows NSIS, and
  Linux AppImage with `availableVersion` equal to the newer stable tag. A
  Windows portable ZIP run stays on the manual notify-and-link path and must
  not download or run the NSIS installer; a legacy portable executable is
  likewise manual when `PORTABLE_EXECUTABLE_FILE` is present. The
  client must not report up-to-date merely because no newer release shares the
  same `rc` prerelease channel.
- **Specs linked**: `04-ux/09-interaction-patterns.md`,
  `05-security/01-security.md`, `08-meta/decisions-log.md` (D120),
  ADR 0022
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`auto-update.test.mjs` asserts
  `allowPrerelease = false`); packaged discovery scenario Draft

## E2E-067B: Shipped-locale update notes and full changelog dialog (D164/D345/D349)

- **Preconditions**: The shipped `packages/shared` CHANGELOG contains aligned
  `en`, `zh-CN`, `zh-TW`, `ko`, and `pt-BR` stable history; product language
  can be switched.
  For the compact update path, use a packaged or fixture updater state with a
  catalogued `availableVersion`.
- **Steps**: 1) With no available update, open Settings → Info and open Release
  notes. 2) Inspect the complete history, current-version marker, scrolling,
  and close behavior by close control, Escape, and backdrop. 3) Force or wait
  for update discovery so status is manual `available`, in-app `downloading`,
  or `downloaded`; inspect the ambient banner and Settings Updates row, then
  reopen Release notes. 4) Switch UI language to zh-CN, then zh-TW, then ko,
  then pt-BR and re-inspect without invoking a new check. 5) Repeat the compact
  update path with a version absent from the catalog.
- **Expected**: `UpdateState.releaseNotes` is plain multi-line product
  highlights selected by Main from the shipped-locale catalog — never a
  renderer-supplied URL. Both surfaces show a localized "What's new" block
  when notes exist and hide it when they do not. Locale change refreshes notes
  for the same version. The Release notes action remains available in every
  updater state and opens a localized, newest-first modal containing every
  shipped stable entry, with current and available versions identified when
  present. The modal traps focus, restores it after close, and does not expose
  a new IPC domain or feed configuration.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/09-interaction-patterns.md`,
  `05-security/01-security.md`, `06-delivery/06-release-runbook.md`,
  `08-meta/decisions-log.md` (D164), ADR 0022
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`auto-update.test.mjs`, `changelog.test.ts`);
  packaged UI scenario Draft

## E2E-067C: Release version-surface preflight blocks a misaligned tag (D260)

- **Preconditions**: A clean worktree at the current stable version. No release
  tag has been created for the candidate version.
- **Steps**: 1) Run `node scripts/check-release-docs.mjs` on the aligned tree.
  2) Regress one surface at a time — replace the models.dev catalog with an
  empty object, remove the newest changelog entry from `en`, then from `zh-CN`,
  change a highlight count so the locales differ, set `docs/package.json` to
  an older version, and leave the READMEs stating the previous
  `<major>.<minor>.x` release line — then rerun the preflight after each. 3) Run
  `node scripts/release.mjs <next-version> --tag`
  with one surface still regressed. 4) Restore every surface, rerun the
  preflight, and repeat the release command.
- **Expected**: The aligned tree reports alignment and exits 0. Each regression
  is reported by name with the offending file and expected version, and exits
  non-zero. With a regressed surface, `release.mjs` bumps files but creates
  neither the release commit nor the tag, and says the documentation check
  failed. After restoration the preflight passes and the release command
  proceeds to commit and tag. `--skip-docs-check` bypasses only the check and
  is documented as non-release use.
- **Specs linked**: `06-delivery/06-release-runbook.md` §4.1,
  `06-delivery/05-change-checklist.md`, `06-delivery/03-ai-development-workflow.md`,
  `08-meta/decisions-log.md` (D164, D260)
- **Acceptance**: Quality (release process)
- **Milestone**: M5
- **Status**: Script-covered (`scripts/check-release-docs.mjs`); manual release
  rehearsal Draft

## E2E-070: Native select menus follow the Windows theme across the app

- **Preconditions**: PI-Desktop is running on Windows with light and dark
  themes available.
- **Steps**: 1) In light theme, open remaining native selects (scheduled-task
  form) and confirm Settings pickers on Appearance, Behavior, Model configuration,
  and Import open as in-app menus rather than platform `<select>` popups. 2)
  Repeat every remaining native list in dark theme. 3) Open each list after
  switching themes without restarting the app.
- **Expected**: Settings compact pickers use the shared anchored menu. Every
  remaining closed native trigger and opened native option list uses the
  active theme's readable foreground/background pairing. No dark-theme list
  falls back to a light Windows surface with light text, no light-theme list
  uses dark-theme ink, and changing theme updates subsequent openings. The
  same result holds for native selects outside Settings.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality (cross-platform theme readability)
- **Milestone**: M5
- **Status**: Unit-covered (`settings-general.test.mjs`); Windows rendered
  scenario Draft

## E2E-092: Packaged runtime is self-contained without duplicate dependencies

- **Preconditions**: Native macOS arm64 and Intel x64, Windows x64, and Linux
  x64 packages built from clean release-host directories; a clean application
  profile;
  English and zh-CN available; external network access can be disabled while
  loopback remains available; a deterministic loopback OpenAI-compatible
  fixture provider returns code, KaTeX, Mermaid, and a Bash command.
- **Steps**:
  1. Record every compressed artifact format plus the unpacked application,
     ASAR, Electron runtime, locale, and unpacked-native sizes on each native
     runner.
  2. Inspect ASAR and resource inventories for sidecar, host, production
     modules, source maps, tests/examples/declarations, Chromium locales, and
     native prebuild targets.
  3. On each macOS package, run `file` (or `lipo -info`) against the app
     executable and `Resources/bin/pi-desktop-host-core`; confirm arm64 and
     x86_64 packages contain only their declared architecture and that the
     Rust host matches the Electron app. Confirm the shared
     `apps/desktop/package.json` macOS configuration produces arm64 assets named
     `PI-Desktop-X.Y.Z-arm64.dmg` and `PI-Desktop-X.Y.Z-arm64-mac.zip`, while
     the Intel assets use `PI-Desktop-X.Y.Z-x64.dmg` and
     `PI-Desktop-X.Y.Z-x64-mac.zip`; confirm the release directory has both
     DMG and ZIP artifacts and one merged `latest-mac.yml` feed whose URLs and
     checksums match those generated assets.
  4. Inspect the renderer output for its size controls: emitted JS is minified,
     no `.woff` or `.ttf` files are present, only the KaTeX `woff2` faces remain
     (no application font face is emitted any more), and
     the brand marks are the renderer-sized `assets/brand/logo-*.png` rather
     than the 1024px installer icons.
  5. Configure the loopback fixture provider, disable external egress, and
     launch from a clean profile. Switch between English and Simplified
     Chinese, request the deterministic response, render common
     JavaScript/TypeScript, Python, Rust, shell, Mermaid, and unknown-language
     fences plus KaTeX and a Mermaid diagram, run the Bash fixture, and verify
     host and agent-sidecar health.
  6. Confirm typography and branding survive the stripped font fallbacks: KaTeX
     math renders with its own faces, Chinese text in both the UI chrome and
     assistant output stays readable through the system CJK fallback tier, and
     the sidebar plus startup-splash logos render crisply on a HiDPI display.
- **Expected**: Each macOS package contains exactly one bundled agent sidecar,
  one Rust host matching its declared architecture, and only configured
  Chromium locale packs. The release output contains both native macOS
  architectures, DMG/ZIP artifacts, and one merged updater feed. Each macOS
  DMG and ZIP carries its standard `-arm64` or `-x64` architecture marker, and
  no generic macOS DMG, ZIP, or blockmap remains in the release output. The
  per-architecture updater metadata points to those names without collisions.
  Renderer dependencies
  exist through Vite output rather than duplicate raw
  `node_modules`; dependency source maps, tests, examples, declarations,
  a second agent-runtime tree, and reliably excludable non-target native assets
  are absent. Curated Shiki grammars highlight locally while an unknown fence
  stays readable as plain text. The renderer ships minified chunks, carries no
  legacy `woff`/`truetype` payload, emits no application font face (only the
  KaTeX `woff2` faces remain), and imports only renderer-sized brand marks;
  math, Chinese text under the CJK fallback tier, and the chrome logos all
  render correctly. The offline shell starts and all
  fixture capabilities use local packaged assets; provider/update network
  failures do not block startup.
- **Specs linked**: `02-architecture/01-architecture.md`,
  `02-architecture/02-tech-stack.md`, `03-runtime/07-process-model.md`,
  `04-ux/02-i18n-english-first.md`, `05-security/01-security.md`,
  `06-delivery/06-release-runbook.md`, D008
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packaging-footprint.test.mjs` validates static
  dependency and builder configuration); native inventory and packaged offline
  launch Draft

## E2E-104: Legacy contract values migrate to schema v11

- **Preconditions**: Schema-v8 fixtures contain sessions, app defaults, and
  scheduled records with legacy `chat` values plus transcripts and permissions;
  schema-v7 and schema-v9 fixtures cover both guarded entry paths.
- **Steps**: 1) Start host-core and allow the guarded migration (v7 first
  reaches v8). 2) Inspect sessions, settings, scheduled modes,
  `plan_approvals` fields/indexes, and the exact readable v8/v9 backup. 3)
  Restart and inspect the same records. 4) Repeat with malformed app settings,
  malformed scheduled config, invalid top-level operating modes, and an unknown
  or wrong-platform default shell. 5) Repeat with a platform-valid persisted
  shell marked temporarily unavailable and nested extension `mode` fields.
- **Expected**: Every legacy mode is `plan`, Agent remains the new-session and
  new-task default, transcripts/permissions survive, `plan_approvals` retains
  approval data and has artifact/execution fields, v8→v11 is one atomic
  transaction after its WAL checkpoint and v8 backup, v9 and v10 create
  readable backups, and migration failure leaves the source schema
  authoritative. Every malformed or
  invalid fixture fails closed before schema promotion. The temporarily
  unavailable platform-valid shell remains persisted for runtime fallback, and
  nested extension modes remain unchanged.
- **Specs linked**: `00-baseline.md`, `03-runtime/04-data-storage.md`,
  `03-runtime/01-ipc-protocol.md`, `04-ux/06-settings-ia.md`, ADR 0053
- **Acceptance**: F (persistence), H (diagnostics)
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-05): host-core 139/139, including 15
  focused DB tests, covers schema-v7→v8→v11, v8→v11, v9→v11, and v10→v11
  guarded paths,
  exact readable backups, fail-closed rollback, restart, transcript, settings,
  scheduled-mode, approval-field, and index tests

## E2E-247: Windows host-core exits after stdin EOF and oversize RPCs fail immediately

- **Preconditions**: Windows host-core with the Alt+Space keyboard hook
  installed; a JSON-RPC request whose NDJSON line exceeds 64 MiB.
- **Steps**: 1) Send stdin EOF to a running host-core. 2) From Electron, call
  a host method whose stringified payload exceeds 64 MiB. 3) If a line still
  reaches host-core, inspect the `LIMIT_EXCEEDED` reply id.
- **Expected**: After stdin EOF, host-core exits without waiting 130 s. The
  Windows keyboard hook does not keep the stdout writer alive. Electron
  rejects the oversize call with `LIMIT_EXCEEDED` before `stdin.write`. A
  host-side oversize reply uses the request id peeked from the prefix, not
  `null`. The UI error is not `host RPC timeout`.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `03-runtime/06-host-rpc-protocol.md` §7, ADR 0217, D391
- **Acceptance**: Quality
- **Milestone**: M6
- **Status**: Covered by unit and source-contract tests (2026-09-11):
  `start_does_not_keep_the_stdout_channel_open`,
  `peek_jsonrpc_id_reads_a_string_id_from_a_truncated_prefix`,
  `apps/desktop/test/windows-host-runtime.test.mjs` (weak sender),
  `apps/desktop/test/rpc-lifecycle-contract.test.mjs` (client precheck),
  `packages/shared/src/rpc-limits.test.ts`. Desktop journey remains Draft.

## E2E-CONFIG-SYNC-s3-portable-configuration

- **Preconditions:** A built task candidate, isolated Host processes with
  separate data, HOME and agent directories, and a local S3 fixture with strong
  ETags and conditional PUT. No real model provider or running desktop instance.
  A live S3 run is separately opt-in and requires explicit authorization.
- **Steps:**
  1. In a packaged build, confirm Cloud sync appears in Settings navigation
     and search with Experimental badges on its row and page title. Open the
     destination and confirm only the new S3 setup is offered; old formats are
     not detected, migrated or deleted.
  2. Confirm initial setup shows only required connection/password fields and
     automatic runs use the shared switch. Expand Advanced to edit region,
     prefix, addressing, device label and optional token; collapse/reopen it
     without losing values. Select categories before the first save, keeping
     credentials/memory opt-in. Test conditional creation, readback, matching
     update, stale-write rejection and probe cleanup.
     Reject ignored preconditions, weak ETags, redirects, public HTTP and 403;
     never interpret 502 as a missing object. LAN HTTP follows network policy.
  3. Configure two sync devices. Publish a provider and mapped packaged skill,
     receive them as pending where approval is required, approve, and verify
     visible persisted configuration and resource bytes. Verify there is no
     projects category and publishing project/group metadata neither registers
     nor changes projects/groups on the receiving device. Register its workspace
     locally, then map and approve the project skill; its resources must arrive
     without changing local group names, roots or ordering. Existing vault
     `projects` entities are ignored on sync/restore, preserving local projects
     and cloud history. Exercise disjoint edits,
     same-entity conflicts and explicit choice convergence, remote deletion
     versus offline edit, and repeated polling. Credential opt-out must not
     manufacture local edits or prevent deletion convergence. No real executable
     capability is run.
  4. Configure backup mode. Verify remote configuration is not applied, backup
     history is separate, unchanged snapshots do not duplicate revisions, and
     a local restore does not change either cloud head.
  5. Restore an older sync revision with propagation acknowledgment. Verify a
     local recovery point, a new shared revision and propagation to the second
     device, with sensitive activation still requiring approval. Rewrap the
     password without claiming revocation of already unlocked devices.
  6. Reopen Settings with saved and unfinished drafts. Preserve typed S3 choices
     and automatic-run preferences, but never persist secret keys, tokens or
     passwords. Test blank credential reuse, explicit token clearing and full
     replacement. Invalidate history on destination/mode changes and ignore
     outstanding responses from the old connection. Unsaved mode changes must
     not alter restore confirmation or propagation flags.
     Saved connections reopen collapsed while status, manual run and inline
     unlock remain visible above them. Open History and Security/connection
     to restore, change password or disconnect. Pending approvals and errors
     remain visible. At narrow content widths the form becomes one column
     without horizontal overflow. In light/dark themes, activate shared
     checkboxes by label and Space; verify focus, disabled and mixed states.
  7. Restart an isolated Host and verify persisted state, then disconnect without
     deleting unrelated data. Inspect remote object bytes for known fixture
     plaintext and verify there is no automatic immutable-object GC.
  8. Hold an in-flight manual sync, navigate away from Settings and return.
     Verify Host still reports `syncing`, duplicate actions stay disabled, and
     releasing the fixture completes the operation and refreshes Host state.
- **Expected:** Only S3 is supported, with mandatory conditional writes and
  encrypted vault contents. Identical/disjoint edits converge; conflicts and
  tombstones preserve changes; excluded categories do not imply deletion.
  Backup never downloads/applies remote configuration during normal runs.
  History queries index at most 30 revisions; stored immutable objects are not
  automatically deleted. Import recovery remains observable; per-file atomic
  replacement is not asserted to be a whole-filesystem transaction.
- **Live S3 safety:** `--live-s3 --env-file <authorized-file>` reads credentials
  programmatically without logging/copying them. Use a new random test prefix,
  confirm it is initially empty, run actual isolated Host processes, delete
  only objects created under that prefix, and verify it is empty afterward.
  Never use an existing backup prefix or production desktop profile. Record
  tested base/candidate and distinguish this run from a standalone SDK probe.
- **Automation:** `pnpm test:e2e:config-sync` is the multi-Host harness.
  Rust `config_sync::` and `user_skills::` suites cover transport, merge,
  application and resource safety. `config-sync-user-path.test.mjs` runs the
  real settings page and shared checkbox with a mocked external IPC boundary,
  actual styles and isolated Electron input, without network access;
  `config-sync-ipc.test.mjs` covers Main notification shape. Visibility remains
  covered by `settings-developer-only-destinations.test.mjs`.
- **Specs:** `03-runtime/22-config-sync.md`, `04-ux/06-settings-ia.md`,
  `03-runtime/14-secrets-storage.md`, `05-security/01-security.md`,
  `docs/adr/s3-only-configuration-backup-sync.md`.
- **Acceptance:** F (persistence), Security, Quality. **Milestone:** M6+.
- **Status:** Candidate validation required; full checkpoint-recovery fault
  injection is not claimed by the settings or multi-Host happy-path suites.

**E2E-CHAT-session-todo-checklist: TodoWrite to session-aware TodoDock**

- **Preconditions**: An isolated local Electron profile with a deterministic
  Agent/host fixture, two Desktop sessions, and no real provider or paid API.
- **Steps**: Start a multi-step Agent turn that calls `TodoWrite` with ordered
  pending and `in_progress` items. Observe the TodoDock above the Composer;
  confirm its progress text is left-aligned, its separate arrow button is at
  the right edge, measures at least 36px square, and contains an independently
  sized 18px arrow icon. Confirm clicking the text does not expand it. Click
  the upward arrow to expand, then confirm the arrow points down. Switch
  sessions and confirm the checklist stays session-scoped.
  Expand a checklist longer than the dock's height cap: every row must render
  and the list must scroll inside the dock without growing the Composer stack.
  Complete and cancel items, confirm the all-cancelled label, then clear the
  checklist and reload/restart the host.
  Deliver an out-of-order older `todos.changed` event and confirm it cannot
  replace the newer snapshot. Exercise invalid payload, Plan/Goal, delegated,
  and remote-session paths.
- **Expected**: Host SQLite is authoritative; each successful full replacement
  advances revision, including clear, and emits one committed `todos.changed`
  snapshot. Invalid or unauthorized writes do not mutate or emit. TodoDock
  renders plain text, separates collapsed progress from the current item,
  uses glyph status marks in a flat expanded list, does not take focus,
  strikes through completed task text, sweeps a light band across the working
  step's text only (the header line while collapsed, its row while expanded),
  resets expansion on session changes,
  lists every ordered row with the dock's
  own list as the scrollport, and keeps a collapsed dock to its header height,
  rejects stale events, and skips local recovery for `remote:` sessions because
  RACP v1 has no Todo snapshot operation.
- **Specs**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/08-component-spec.md`, ADR 0312.
- **Acceptance**: C / E / F / Quality / Security.
- **Milestone**: M6+.
- **Automation**: `pnpm test:e2e:todos` exercises the isolated Electron
  checklist journey through the production Agent's ToolSearch/TodoWrite path,
  the production renderer, and a real host/SQLite profile. Only the external
  model stream and preload transport are fixtures; no live provider or user
  profile is used. The scenario includes Unicode truncation with warning replay,
  single-active-item normalization, full-list rendering with the dock's
  internal scroll, a failed initial read followed by host recovery without
  changing sessions,
  cached-snapshot reconciliation, and stale-event rejection. Runtime
  `runtime-todos.test.ts` exercises Agent tool validation, overlong content
  normalization, and continuation through a deterministic provider.
- **Status**: Run against the exact request candidate after building the
  desktop and host. Host-core and targeted renderer tests are companion checks,
  not substitutes for the Electron journey.

## E2E-127: macOS keeps the app in the Dock and Cmd+Tab

- **Preconditions**: Built desktop app on macOS; the plugin launcher shortcut
  (Option+Space) is registered; at least two Spaces and one other application
  running fullscreen.
- **Steps**:
  1) Launch the app without opening the launcher and confirm it appears in the
     Dock and in the Cmd+Tab switcher (`lsappinfo list` reports
     `type="Foreground"`, not `type="UIElement"`).
  2) Press Option+Space, confirm the launcher panel appears focused with a
     typable input, dismiss it, and confirm the app is still in Cmd+Tab.
  3) Put the main window in fullscreen, press Option+Space, and confirm the
     panel floats above it.
  4) Switch to a second regular Space and confirm Option+Space shows the panel
     there.
  5) Minimize the main window into the tray, switch to another app, then Cmd+Tab
     back to PI-Desktop and confirm the window returns focused; repeat with a
     Dock click and with the tray Show item.
  6) With the main window hidden, press Option+Space and confirm only the
     launcher appears — the main window stays hidden until it is restored.
- **Expected**: The process never adopts the accessory activation policy, so
  Dock and Cmd+Tab presence survives launcher warm-up and every launcher
  invocation; the launcher stays focusable, covers all regular Spaces and the
  app's own fullscreen window (overlaying another app's fullscreen Space is
  out of scope and activates PI-Desktop instead); activation from Cmd+Tab, App
  Exposé, the Dock, or the tray restores a tray-hidden window, while launcher
  and plugin-panel activation leaves it hidden.
- **Specs linked**: `03-runtime/07-process-model.md`, ADR 0086, ADR 0078,
  ADR 0080
- **Acceptance**: A (core shell)
- **Milestone**: M5+
- **Status**: Documented

## E2E-211: Windows portable ZIP launches after extraction (D603)

- **Preconditions**: A Windows x64 tag or `dist:win` package has produced both
  `PI-Desktop-Setup-<version>.exe` and `PI-Desktop-Portable-<version>.zip` from
  the shared electron-builder config; a clean user profile is available; the
  account is a standard user without administrator elevation.
- **Steps**: 1) Inspect the release directory and `latest.yml`. 2) Extract the
  portable ZIP to a user-writable directory without running the NSIS installer.
  3) Launch the extracted `PI-Desktop.exe`. 4) Confirm there is no
  administrator prompt and that the running app has the PI-Desktop icon and
  taskbar entry. 5) Open Settings → Info and confirm Manual is selected by
  default; briefly select Automatic to inspect its replacement warning, then
  restore Manual. 6) Invoke Check for Updates. 7) Confirm Settings → Info offers
  the releases page rather than Restart to update. 8) Quit and relaunch the
  extracted executable.
- **Expected**: Both Windows artifacts are space-free and uploaded. `latest.yml`
  points at the NSIS installer only. The extracted ZIP app starts without a
  setup wizard or administrator prompt, keeps the normal PI-Desktop taskbar
  identity/icon, uses the existing application data directory, and reports
  update preference `manual` by default and effective update mode `manual`.
  Its `resources/app-update.yml` points to the same GitHub feed, so the manual
  check settles as up-to-date or available instead of failing with `ENOENT`.
  When an update is available, Settings offers the Releases page; it does not
  download or run `PI-Desktop-Setup-<version>.exe`. Relaunch restores sessions
  from that same profile.
- **Specs linked**: `01-product/01-product-scope.md`,
  `06-delivery/06-release-runbook.md`, `03-runtime/07-process-model.md`,
  ADR 0197 / D603
- **Acceptance**: Quality (release packaging)
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`auto-update.test.mjs`); native
  Windows launch remains runner validation (run only in a capable environment when this surface changes)

## E2E-UPDATE-preference-and-once-only-reminder

- **Preconditions**: A disposable packaged profile on a supported automatic
  installer lane and a Windows portable ZIP profile. The update discovery path
  can provide the same stable available version across repeated checks without
  running a production installer.
- **Steps**: 1) Open Settings → Info on the installed package and confirm
  Automatic is selected by default. 2) Choose Manual, close/reopen Settings,
  then restart the app and confirm Manual persists. 3) Surface one available
  stable version; verify no download/install starts and one notice appears.
  Dismiss it, navigate away and back, repeat the check, then restart and check
  again. 4) Confirm the same version does not raise another notice, while the
  Settings row still shows it and opens Releases. 5) Select Automatic and
  surface an available version. Dismiss the in-app banner while downloading;
  verify the transfer is cancelled and the update will not install on quit.
  Restart, check the same version again, and verify it remains dismissed and
  does not download. Then surface a newer version and verify automatic
  downloading resumes. 6) Launch the portable ZIP profile and confirm Manual
  is the default; inspect the warning before explicitly selecting Automatic.
- **Expected**: The preference persists per installation. Manual performs
  discovery only and stores the last reminded version so repeated checks and
  app restarts do not repeat the notice; the Info row remains actionable. A
  dismissed version stays ignored across restarts in either mode. In-app
  dismissal cancels an active transfer and prevents install-on-quit for that
  version; a newer release clears the dismissal and resumes automatic delivery.
  ZIP and legacy portable builds default to Manual, and Automatic is an
  explicit, warned opt-in that can replace the extracted copy with NSIS.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0022 / D628
- **Acceptance**: Quality (settings interaction and release safety)
- **Milestone**: M6+
- **Status**: Setting selection/persistence covered by
  `pnpm test:e2e:settings-scroll`; dismissal and download cancellation covered
  by `updater-controller.test.mjs`. Packaged Windows installer journey remains
  runner validation.

## E2E-217: Windows host starts on a clean x64-emulated ARM64 install

- **Preconditions**: A clean Windows 11 x64 or ARM64 machine/profile without a
  separately installed Visual C++ Redistributable, Node.js, or another local
  agent runtime; the x64 NSIS installer is available.
- **Steps**: 1) Install PI-Desktop. 2) Launch it for the first time. 3) Wait
  for the startup splash to yield to the main shell. 4) Inspect the runtime
  logs, then open Settings → Info.
- **Expected**: The bundled x64 `pi-desktop-host-core.exe` starts and completes
  `app.handshake` without `0xC0000135` (`STATUS_DLL_NOT_FOUND`), the shell does
  not remain on “Can't reach the local service”, host status is healthy, and
  Settings → Info reports the host version instead of `host unknown`. The
  package uses the statically linked MSVC CRT; no separate runtime installer
  is required. Native Windows ARM64 artifacts remain out of scope.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `06-delivery/06-release-runbook.md`
- **Acceptance**: A (app startup), Quality (clean-install packaging)
- **Milestone**: M6+
- **Status**: Source-contract-covered; clean-machine Windows x64 and ARM64
  qualification remains runner validation (run only in a capable environment when this surface changes)

## E2E-240: An Intel macOS build on Apple Silicon points at the native download

- **Preconditions**: Apple Silicon Mac; the x64 macOS package installed and
  running under Rosetta 2.
- **Steps**: 1) Launch the app. 2) Read the banner under the title bar.
  3) Click its dismiss action.
- **Expected**: The app boots normally. A dismissible hint says this is the
  Intel build on an Apple Silicon machine and asks the user to install the
  Apple Silicon build. Dismissing hides it for the session; the native arm64
  package shows no hint.
- **Specs linked**: `03-runtime/07-process-model.md` (boot outcomes)
- **Acceptance**: B
- **Milestone**: M3+
- **Status**: source-contract covered by
  `apps/desktop/test/host-boot-diagnostics.test.mjs`

## E2E-RUNTIME-renderer-crash-recovery

- **Preconditions**: Built desktop with an isolated profile, the main window
  ready on chat, and CDP enabled by the E2E harness.
- **Steps**: Set a renderer-only sentinel, trigger `Page.crash`, then reconnect
  to the existing page target if the renderer's CDP connection closes. Wait for
  the chat surface to return and inspect the isolated diagnostics log.
- **Expected**: The renderer document is recreated in the same app window, the
  chat surface becomes usable, and `renderer.process.gone` records the exit
  reason, exit code, and reload decision. The app does not open a second window.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `03-runtime/09-logging-and-observability.md`
- **Acceptance**: A, H, Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Automated by `pnpm test:e2e:layout` with CDP `Page.crash`; the
  deterministic `renderer-recovery.test.mjs` covers clean exit, accepted close,
  app shutdown, stale windows, destroyed contents, and future Electron reasons.

## E2E-RPC-unicode-separators

- **Preconditions:** Built host-core, shared package and agent runtime; isolated
  temporary data directory; loopback-only fixture provider. No live credentials.
- **Steps:** Append a user message containing U+2028/U+2029, CJK text, emoji and
  escaped CR/LF; read it, restart the host, and read it again. Send a Unicode
  prompt through AgentSidecar; restore history through the parent host proxy;
  stream and persist a Unicode answer. Send an unknown method containing the
  same characters, then a health request.
- **Expected:** Text survives unchanged across persistence and all stdio
  directions. Requests settle without RPC timeouts; error replies and subsequent
  requests remain usable. No migration of existing sessions is needed.
- **Automation:** `pnpm test:e2e:rpc-unicode`; `packages/shared/src/ndjson.test.ts`
  additionally checks every UTF-8 split boundary, consecutive frames, CRLF, EOF and disposal.
- **Specs:** 03-runtime/06-host-rpc-protocol §2.
- **Acceptance:** A (runtime), C (sessions).
- **Milestone:** M6+.
- **Status:** Automated; run against the task/PR integration candidate.

## E2E-RUNTIME-unique-tool-call-ids-per-request

- **Preconditions:** A session transcript that carries the same tool call twice
  (a retried append leaves the call under a second row id), loaded into a
  recreated runtime against a deterministic provider fixture. No real provider
  credentials.
- **Steps:** Send one prompt so the runtime assembles and issues a request. Read
  the outgoing request the fixture received, and the `agent` log channel. Repeat
  with a transcript whose calls are already unique.
- **Expected:** The outgoing request carries exactly one `toolCall` for that id
  and exactly one matching result, so no provider can answer
  `tool_use ids must be unique`. The log channel gets one line naming the
  session and the ids. The unique transcript's request is unchanged, byte for
  byte, and logs nothing.
- **Specs:** `03-runtime/02-agent-runtime.md` §5,
  `08-meta/decisions-log.md` D608.
- **Acceptance:** C (conversation and stream), Quality.
- **Milestone:** Post-MVP regression coverage.
- **Automation:** `packages/agent-runtime/src/runtime.test.ts` covers both halves
  against a real runtime built from a duplicated history (drop + one log line)
  and a unique one (identity, no log line).

- **Status:** Unit-covered; no end-to-end driver issues a real provider request
  against a duplicated transcript.

- **Reused-id regression (#1815):** Run two actual tool executions whose
  provider responses reuse the same id, then inspect the next request. Both
  results must remain, with distinct paired ids and no synthetic placeholder.
  Repeat after context trimming and restored history, and verify cancellation,
  metadata and replayed pending snapshots retain their semantics.
  `runtime.test.ts` covers the parent prompt path; `subagent-fallback.test.ts`
  drives the real Pi adapter over local HTTP with two executions and three
  requests; `tool-call-identity.test.ts` covers retained identities after trim.

## E2E-RUNTIME-system-update-during-tool-call-restore

- **Preconditions:** A session transcript with a model system record saved
  while a tool call ran: it sits after the assistant row that made the call and
  before that call's tool row (`beforeMessageId` is the tool row id). Loaded
  into a recreated runtime against a deterministic Anthropic Messages fixture
  with mid-conversation system messages enabled. No real provider credentials.
- **Steps:** Send one prompt so the runtime assembles and issues a request. Read
  the outgoing request body the fixture received.
- **Expected:** The tool call stays on the assistant message that made it,
  next to that message's text, and no call-only assistant is synthesized. Every
  mid-conversation `system` message follows a `user` message, so the provider
  does not answer `role 'system' must follow a 'user' message or an 'assistant'
  message ending in a server tool result`.
- **Specs:** `03-runtime/02-agent-runtime.md` §5c and §7.0.0,
  `08-meta/decisions-log.md` D127.
- **Acceptance:** C (conversation and stream), Quality.
- **Milestone:** Post-MVP regression coverage.
- **Automation:** `packages/agent-runtime/src/system-transcript-runtime.test.ts`
  restores the rows into a real runtime and passes the captured request through
  Pi's Anthropic adapter.

- **Status:** Unit-covered; no end-to-end driver restores such a transcript
  against an Anthropic provider fixture.

## E2E-RUNTIME-loop-context-ownership

- **Preconditions:** A deterministic provider fixture that answers the first two
  rounds with one tool call each and stops the turn after the second round the
  way a user Stop does. No real provider credentials.
- **Steps:** Send one prompt so the runtime runs both tool rounds and ends the
  turn on a tool round. Send a second prompt. Read the state the runtime kept and
  the outgoing request the fixture received.
- **Expected:** The kept state holds each streamed assistant message and each tool
  result exactly once; no result is separated from the call it answers; the
  fixture's request carries exactly one result per call. No duplicate-drop line is
  logged, because the request guard had nothing to drop.
- **Specs:** `03-runtime/02-agent-runtime.md` §5c,
  `08-meta/decisions-log.md` D620.
- **Acceptance:** C (conversation and stream), Quality.
- **Milestone:** Post-MVP regression coverage.
- **Automation:** `packages/agent-runtime/src/runtime.test.ts` (loop context
  ownership) drives the real pi loop through `runtime.prompt()` and reads the
  view `convertToLlm` handed the provider; `subagent-loop-context.test.ts` covers
  the delegate's turn boundary. The adapter's own output is out of reach of both,
  so `tool-call-dedupe.test.ts` (request wire contract) drives pi-ai's message
  transform directly to pin the two outputs one call id receives when a request
  separates a call from its result.
- **Status:** Unit-covered; no end-to-end driver issues a real provider request
  from a context the loop appended to.

## E2E-260: Windows updater cache can be relocated and reclaimed safely

- **Preconditions:** Packaged Windows x64 NSIS install, isolated user profile, and a writable cache directory on a non-system volume. Use a local updater-feed fixture; do not contact GitHub or a paid service.
- **Steps:** 1) Seed the legacy `%LOCALAPPDATA%` updater cache with `installer.exe`, `current.blockmap`, and a staged update. 2) Launch with `PI_DESKTOP_UPDATE_CACHE_DIR` set to the isolated cache base. 3) Confirm Main adopts the baselines and staged update into the configured cache and removes the legacy cache. 4) Complete the staged update and launch the new version. 5) When the fixture reports no newer version, inspect the configured cache.
- **Expected:** `app-update.yml` determines the cache subdirectory; the pending update and differential baselines survive relocation; when the running version is current only `pending/` is removed, while `installer.exe` and `current.blockmap` remain for the next delta. The default path remains unchanged when the override is unset. The app does not write the download into `Program Files`.
- **Specs:** `03-runtime/07-process-model.md`, ADR 0022.
- **Acceptance:** Cache-path, migration, and cleanup unit tests pass; Windows task-candidate validation confirms the updater feed transport, installer handoff, and filesystem behavior without a live release feed.
- **Milestone:** M6+
- **Status:** Unit and source-contract covered (`update-cache.test.mjs`, `auto-update.test.mjs`); Windows installer/E2E validation remains required.

## E2E-SYSTEM-TRANSCRIPT: Ordered model state survives restart and compaction

- Fixture: isolated Host data directory, production AgentSidecar transport and
  separate Node runtime/Pi process, local SSE provider; no real provider
  credentials or user's Desktop process. The harness persists completed
  messages; it does not exercise Electron's UI or persistence outbox.
- Send a prompt, activate BrowserPreview through ToolSearch, and verify the next
  request includes the schema. Confirm the baseline and delta are acknowledged
  by Host and survive stopping/restarting both processes without duplicate rows.
- Resume the session, update a skill catalog on the same runtime, and confirm the
  next request uses the new catalog while keeping a second unchanged entry.
  Runtime/adapter tests verify the native delta contains only the modified entry,
  and fallback models receive the complete current catalog with removals applied.
  Invoke Skill through the actual sidecar
  bridge with a fixture body supplied by the embedding host. Compact, restart
  the sidecar, and verify current skills and active tools survive without
  replaying old tool results. Remove the final skill and verify its catalog and
  executable schema disappear without recreating the runtime.
- Automated: `node scripts/e2e-system-transcript.mjs` with
  `PI_DESKTOP_HOST_BIN` pointing to the candidate Host binary. Requires built
  shared/host-runtime/agent-runtime packages. Renderer projection tests ensure
  model-state records stay hidden while ordinary system notices remain visible.
- Adapter contract tests cover exact model/API/endpoint capability binding,
  partial support, unverified relay fallback, removals/redefinitions and model
  switching without canonical-history mutation. Real cache-hit improvement is
  a separately authorized provider experiment, not an offline-test claim.

- Flash regression: load the pinned Pi `deepseek-flash` model, serialize its
  Desktop projection, and pass skill updates/removals through the real adapter.
  The official binding preserves the earlier wire prefix; changed bindings
  retain the folded fallback. Covered by `flash-transcript.test.ts`.
- Authorized live Flash acceptance: use isolated development sessions with
  short and long contexts. Alternate unchanged turns and single-skill updates,
  confirm current Skill bodies execute, and compare actual outgoing prefixes
  plus reported usage. After restart, verify no duplicate system updates and
  same-model assistant reasoning remains separate from visible content. Adapter
  regressions also cover legacy identities and genuine account/model changes. Cache
  percentages are observations, not deterministic pass thresholds.

## E2E-RUNTIME-malformed-tool-call-continue-recovery: Continue after malformed tool output

- **Preconditions**: An isolated sidecar and loopback Responses fixture can
  emit an empty tool name, then a corrected Read call. Unit fixtures also
  cover missing names/IDs, empty Responses wire IDs, non-object arguments,
  retained malformed context, compaction tails and resumed delegates.
- **Steps**: Return one malformed response, then invoke the same `agent.prompt`
  entry used by Continue three times. Repeat with three consecutive malformed
  responses followed by a corrected response. Keep the runtime alive throughout.
- **Expected**: Each malformed batch settles with one local
  `context-validation` error before tool execution, with no transport retry.
  All three later prompts complete; the corrected Read executes once, and the
  runtime is reused rather than restarted. Model context retains valid history
  and system updates while excluding malformed calls and associated results.
  Optional usage estimation does not lose terminal tool events. The durable
  transcript and Host permissions are unchanged; unrelated malformed hosted
  search still fails strict validation.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5d.
- **Acceptance**: Conversation, runtime recovery and quality.
- **Milestone**: M5 hardening.
- **Automation**: `pnpm test:e2e:hosted-search` runs the production sidecar and
  real Responses adapter against synthetic SSE, including one-error and
  three-error recovery cases. `malformed-tool-recovery.test.ts`,
  `tool-call-identity.test.ts` and `subagent.test.ts` cover retained state,
  event/result agreement, batch rejection and delegate restoration.
- **Status**: Automated offline; native UI clicking and live providers are
  outside this fixture's coverage.

## E2E-ISSUE-1707

Use synthetic Darwin x64/arm64 uname responses through production SSH bootstrap, serialize its code/details as IPC does, and resolve the renderer error. The platform explanation appears, no checksum or upload occurs. Linux and other bootstrap failures keep existing messages. Coverage: remote-host-ssh-bootstrap.test.mjs and remote-host-errors.test.mjs.
