# Replaying Windows native snap acceptance

The `Windows native snap acceptance` workflow runs baseline and candidate in
one Windows job and uploads evidence even when acceptance fails. It checks out
the exact pull request head, builds Host with `Cargo.lock`, and installs the
pinned Electron. The job uses read-only permissions, no credentials, and no
deployment. Its artifact is named `native-snap-<head SHA>-<attempt>`.
The job artifact has `job.json`, build/preparation logs, and a `native/`
directory containing the acceptance summary, screenshots and replay payload.
The ephemeral runner's display is configured to at least 1920×1080×32 so the
native minimum width fits in a work-area half. The mode change is checked and
recorded; an unsupported display mode fails the job. Manual replay leaves the
reviewer's desktop settings unchanged and requires the display below.

## Independent interactive Windows run

Use an unlocked Windows desktop with snapping enabled, an available DWM,
100% scale and at least a 1920×1080 display. Session 0 and locked desktops fail
explicitly. Keep the desktop free of unrelated windows while input is sent.
An RDP connection must remain connected. Windows Server runs are recorded as
that product, not described as Windows 11 client qualification.

Fetch the PR head into a separate worktree:

```powershell
git fetch https://github.com/vastsa/PI-Desktop.git pull/2333/head
git worktree add --detach ../native-snap-review FETCH_HEAD
Set-Location ../native-snap-review
git rev-parse HEAD
```

Reuse provisioned Node/pnpm, compatible workspace dependencies, Rust and MSVC
build tools. Clean CI runners install with `pnpm install --frozen-lockfile`;
a reviewer with an existing development environment reuses it per AGENTS.md.

```powershell
cargo build -p host-core --locked
pnpm build:js
pnpm --filter @pi-desktop/desktop exec install-electron
$artifacts = Join-Path $env:TEMP ('native-snap-evidence-' + [Guid]::NewGuid())
node scripts/e2e-window-snap.mjs --matrix --artifacts $artifacts
Get-Content "$artifacts/summary.json"
```

For a Windows build machine without the JavaScript build toolchain, prepare
the same portable job in a clean source worktree with compatible dependencies:

```sh
PI_DESKTOP_HOST_BIN='C:\validation\pi-desktop-host-core.exe' \
PI_DESKTOP_SNAP_ELECTRON='C:\validation\electron\electron.exe' \
node scripts/e2e-window-snap.mjs --prepare /tmp/native-snap-job
```

Copy that directory to Windows and run the included job in the interactive
account, using a Host built from the revision recorded in `source.json`:

```powershell
powershell.exe -NoProfile -File C:\validation\native-snap-job\run.ps1 `
  -Matrix -ArtifactDirectory C:\validation\native-snap-evidence
```

`--prepare` alone is not acceptance. Dirty source is recorded and rejected.
Use a new output directory for every attempt. The input adapter option remains
available for remote desktops that cannot use native SendInput:
`--external-pointer` stages requests in the runtime directory named by
`active-directory.txt` while the job runs. An adapter acknowledges the same
`runId`/`id`; the geometry and pixel assertions still determine the result.
The standard workflow and native path require no private adapter or account.
The native driver verifies cursor positions, crosses the drag threshold near
the press point and waits for Windows to enter the target HWND's move/size
loop before sweeping to the edge. An accepted button injection alone is not
proof that a drag began; failure to enter that loop fails acceptance.

## Verdict and evidence

Matrix success requires both:

- Baseline: the snap service is omitted, its style lacks the fixed snap mask,
  Win+Left leaves the original bounds unchanged, and the exact failure is
  `Win+Left did not snap to the work-area half`. Startup/input/desktop errors
  are failures of the job, never accepted as reproduction.
- Candidate: every native assertion passes, including physical titlebar
  snapping, light/dark client-edge pixels, minimum sizes, Win+Up/Down,
  maximize/minimize/restore and fullscreen restoration. Maximized client and
  DWM-visible rectangles must equal the work area. The maximized client pixels
  are also captured; invisible native resize margins are measured separately.

The artifact contains source revision/tree and file hashes, runtime Host and
Electron SHA256, actual OS/session/display metadata, baseline/candidate JSON,
timestamped probe logs, Electron stdout/stderr, fixture errors on failure,
synthetic-window PNGs, replay sources, the compiled probe and `SHA256SUMS`.
Profiles, databases, credentials and unrelated desktop captures are excluded.
Temporary runtime/user paths in diagnostic text are redacted on export.

Download the job artifact from the Actions run. Check `summary.json`'s source
revision against the PR head, check every hash in `SHA256SUMS`, and compare
`source.hashes` with that checkout. Retaining a prior artifact does not qualify
a later executable revision. The native checks exercise production Main
services and the real Host with synthetic content, not the full renderer or
an installed application. Windows 10, legacy transparent windows, mixed DPI
and hover Snap Layouts remain outside this qualification.

## Preserved original-head evidence

[Original-head artifacts](windows-native-snap-evidence/38c5a5bd77ef/manifest.json)
retain the original `38c5a5bd77ef910849ce3c1bc5f5d8577dad1a71` author run:
[baseline](windows-native-snap-evidence/38c5a5bd77ef/baseline.json),
[candidate](windows-native-snap-evidence/38c5a5bd77ef/candidate.json),
[normal pixels](windows-native-snap-evidence/38c5a5bd77ef/normal.png),
[snapped pixels](windows-native-snap-evidence/38c5a5bd77ef/left.png),
[restored pixels](windows-native-snap-evidence/38c5a5bd77ef/after-fullscreen.png),
and stdout/stderr. The manifest was reconstructed from preserved files and
the staging record after the run; it is not independent attestation. The
current replay job records provenance before launching the probe.

## Activation follow-up evidence

The PowerShell-launched replay exposed a border after actual focus transfer.
Refreshing the existing native hint on focus and blur fixed the exact pixel
failure without changing frame options, native sizing or fullscreen ownership.
The clean-source candidate `2b52999879a65d35ce7c29dc0dcf29047ee3a02d`
passed **144 native assertions**, including the new maximized client pixel
captures; the matrix baseline failed precisely at Win+Left as required.

Download [its manifest](windows-native-snap-evidence/2b52999879a6/manifest.json),
[matrix summary](windows-native-snap-evidence/2b52999879a6/summary.json),
[runner log](https://github.com/Linuxdazhao/PI-Desktop/blob/e45ac351547f3cb0c448435c69524bbe78a3ee2a/docs/project/windows-native-snap-evidence/2b52999879a6/runner.log),
[candidate results](windows-native-snap-evidence/2b52999879a6/candidate/result.json),
[native RPC replies](https://github.com/Linuxdazhao/PI-Desktop/blob/e45ac351547f3cb0c448435c69524bbe78a3ee2a/docs/project/windows-native-snap-evidence/2b52999879a6/candidate/native-rpc.jsonl),
[maximized pixels](windows-native-snap-evidence/2b52999879a6/candidate/maximized.png)
and [restored maximized pixels](windows-native-snap-evidence/2b52999879a6/candidate/restoredMaximized.png).
These are author replay records, distinct from an independent Actions run.
The manifest records the clean replay revision and Host producer; the producer
and replay share the exact Host source tree and lockfile. Committed artifact
tests verify every retained byte across platforms, including raw CRLF streams.
