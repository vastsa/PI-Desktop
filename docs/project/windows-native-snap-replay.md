# Replaying Windows native snap acceptance

The `Windows native snap acceptance` workflow runs baseline and candidate in
one Windows job and uploads evidence even when acceptance fails. It checks out
the exact pull request head, builds Host with `Cargo.lock`, and installs the
pinned Electron. The job uses read-only permissions, no credentials, and no
deployment. Its artifact is named `native-snap-<head SHA>-<attempt>`.

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
