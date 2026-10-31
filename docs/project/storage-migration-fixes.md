# Storage migration fixes: upstream review notes

## Purpose and baseline

PI-Desktop is a local-first Electron application. Settings and preload express
user intent; Electron Main schedules cold filesystem maintenance; Rust Host Core
owns SQLite and structured-path relocation. The original Electron userData
directory remains the installation lock and bootstrap-pointer anchor.

This document scopes the October 15, 2026 upstream draft for storage migration.
The preparation base is `2eb333723bfdb92c3adf6c68cdf86d0ec995ce88`.

## Old behavior, defect, and new behavior

| Scenario | Previous behavior and observed defect | Candidate behavior |
| --- | --- | --- |
| New selected directory | `realpath` required the target to exist; selection failed with ENOENT. | Resolve the nearest existing ancestor, reject overlap, then create the selected directory and parents. |
| First-run source with missing parents | Resolving only the immediate source parent failed before migration. | Resolve missing ancestors recursively without initializing an unused old profile. |
| Packaged application in scratch | Electron fs treated app.asar as a virtual directory; copying could fail with ENOTDIR. | Use original-fs streams and metadata APIs to copy physical archive bytes and adjacent unpacked files. |
| Dangling Windows directory/file link | Target-following stat could fail when the target was absent. | Read the link's own attributes in one Windows batch, preserve the link, and relocate only internal targets. |
| Windows junction target spelling | Node/Electron could disagree about a trailing separator; verification failed although the target was equivalent. | Normalize external absolute Windows link targets lexically before creation and comparison. |
| Project memory/instructions after relocation | Mixed separators and canonical-root spelling made repository lookups miss copied keys. | Normalize remapped project paths and memory/instruction keys using existing repository helpers. |
| Nested browser files matching installation metadata | The root keep-list was applied recursively, omitting ordinary nested files. | Apply installation exclusions only at the browser root; retain nested and host-data namesakes. |
| Windows backup cleanup | Older fork versions attempted to unlink the held lockfile and failed with EBUSY. | Already fixed in upstream d815ef15b; preserve that code and extend native lock/retry coverage. |
| Copy failure diagnostics | A low-level error could lack the failing copy pair. | Include source, destination and the original error; do not skip the failed entry or publish an incomplete destination. |

Upstream's Windows lock fix was committed October 13, 2026. It is not new code
contributed by this draft. The upstream existing test covers both lock names.
This draft keeps that test and adds an actual Electron-held Windows lock case.

## Implementation map

- `apps/desktop/electron/main/storage/files.ts`: target resolution, physical
  filesystem operations, root-only exclusions, junction normalization and copy
  diagnostics. Existing copy verification and cleanup preflight are retained.
- `apps/desktop/electron/main/storage/link-types.ts`: Windows reparse-point
  attributes without dereferencing targets. Paths are sent as JSON on stdin,
  not interpolated into a shell command. Other platforms keep their existing
  symlink behavior.
- `apps/desktop/electron.vite.config.ts`: externalize Electron's original-fs;
  preserve the current upstream ESM dirname handling.
- `crates/host-core/src/data_relocation.rs`: consistent project path/key spelling;
  keep upstream worktrees.path relocation. SQLite remains exclusively Rust-owned.
- `apps/desktop/test/storage-directory-migration.test.mjs` and
  `crates/host-core/src/data_relocation/tests.rs`: regression coverage at the
  public filesystem and repository interfaces.
- `apps/desktop/test/storage-maintenance.test.mjs`,
  `scripts/e2e-storage-bootstrap.mjs`, `scripts/e2e-storage-migration.mjs`:
  existing Node harnesses alias original-fs to the real Node filesystem; native
  Electron tests separately prove behavior that Node cannot reproduce.
- `scripts/e2e-storage-directory.mjs`, `scripts/e2e-storage-files.mjs`,
  `scripts/e2e-storage-backup-lock.mjs` and their `scripts/e2e/` fixtures:
  Settings/cold-bootstrap and native filesystem regressions.
- `package.json`: wire the focused scripts into the existing storage E2E command.

## Reproduction and verification

Use synthetic profiles only. Reuse the installed development toolchain and
compatible dependencies; keep mutable profiles/artifacts isolated. Never point
these fixtures at a user's installed profile.

```text
node --test apps/desktop/test/storage-directory-migration.test.mjs
cargo test -p host-core --locked relocated_project_memory_remains_readable_through_the_repository
node scripts/e2e-storage-files.mjs
node scripts/e2e-storage-backup-lock.mjs
node scripts/e2e-storage-directory.mjs
```

The Settings workflow requires built renderer CSS, current shared JS and a
candidate Host supplied through `PI_DESKTOP_HOST_BIN`. Its production Settings
controls, preload, storage IPC, cold bootstrap and reopened Host are real. The
picker selection and relaunch dispatch are scripted. Each startup phase uses a
separate Electron process. Set `PI_STORAGE_E2E_SOURCE_ROOT` to an isolated folder
on another drive to exercise cross-volume migration.

The archive suite covers opaque and valid ASAR files, adjacent unpacked data,
dangling internal/external links, Node-created junction spelling and actionable
copy-error reporting. The lock fixture keeps a real single-instance lock while
retrying cleanup after the old payload is already absent. This is not a complete
large-profile backup-deletion test. Fixtures are retained for diagnosis.

## Evidence boundaries

Current candidate checks ran on October 15, 2026 with Windows, Electron 43.6.0,
Node 24.19.0 and Rust 1.90.0. The implementation was prepared against the upstream
base above. Executable candidate 5586c50bf900f7ba6b7e9b4f8d2385db21b15e31
passed the refreshed Host, directory, native archive/lock and Settings workflows
after incorporating that base. The later documentation-only commit does not
change executable sources. The local PR draft records the final branch head.
Earlier fork results are not counted in this table.

| Check actually executed | Result |
| --- | --- |
| Unmodified upstream reproduction | New-target ENOENT, missing-source-parent ENOENT and nested lockfile omission confirmed |
| Focused directory regression | 10 passed |
| Native Electron ASAR/link/copy-error suite | 6 passed |
| Native installation-lock cleanup retry | Passed; lock, pointer and active history retained |
| Rust repository-level project-memory regression | 1 passed; 918 other tests filtered out |
| Candidate Host development build | Passed with locked Cargo dependencies |
| Settings, cold maintenance and reopened Host | 3 passed; first-install and existing-profile migration D: to C:, plus backup retry |
| Workspace TypeScript builds / Desktop typecheck | 9 package builds and Desktop typecheck passed |
| Focused Biome / Rust fmt / style tokens / agent policy | Passed |
| Documentation checks | 85 locale pairs and 575 pages passed |
| Visual review | Reopened migration path/backups and post-cleanup removal of backup controls inspected |
| Full Desktop build | Blocked: reused electron-vite cannot resolve esbuild |

Settings renderer code, preload, storage IPC and Host use candidate sources.
Only unchanged Settings CSS is reused from an earlier upstream-PR build; its
renderer JS is not executed. The candidate Host was compiled from this worktree
using the existing Cargo target cache.

The reused DOMPurify 3.4.13 and Vitest 4.1.10 predate the current manifest minimums
3.4.17 and 4.1.11. Neither participates in the focused storage fixtures. No fresh
dependency installation was performed. Full exact-lockfile build/package
qualification, full Rust/clippy, macOS/Linux, installer entry points and PR
integration validation remain outstanding. Existing cleanup suites that delete
fixture data were not executed; the focused fixtures retain their profiles.
The current results therefore support review of a draft, not release approval.

Historical source commits:

| Source commit | Purpose |
| --- | --- |
| 8bdc4765a | New destinations, first-run profiles and normalized project keys |
| a00577626 | Physical archives, dangling links and copy-error context |
| f0002104e | Windows junction trailing-separator normalization |
| 155141316 | Windows lock protection, root-only exclusions and cleanup retry coverage |

The source fork had Windows acceptance runs. Its 0.18.2 release predates the last
backup-lock change. A subsequent authorized local cleanup used the production
selection logic with a Recycle Bin adapter; it does not certify the stock product
deletion path and is not part of this source change.

## Preserved behavior and limits

- Cold migration, existing verification and atomic pointer publication remain.
- Existing custom volumes must be available; this is not automatic recovery to
  a blank profile when a configured drive disappears.
- Originals remain backups until a separate explicit cleanup confirmation.
- Source/target overlap, unrelated destination contents and linked destinations
  remain rejected; external project directories are not moved.
- No schema, protocol, version, dependency, SDK permission or release change.
- No new compatibility layer, automatic fallback or integrity gate is added.
- Unknown plugin-private absolute references remain the plugin owner's concern.
- Windows link creation still requires the platform's permissions; errors remain
  visible rather than dropping links.
- macOS/Linux runtime and installer entry points need separate acceptance.

## Handoff and publication

Review the local PR body in Summary / Reproduction / Changes / Validation / Scope
/ Review order. Before publication, refresh upstream, rerun applicable checks on
the exact candidate, inspect the file list for unrelated fork changes and private
artifacts, then obtain the user's approval to publish. Do not use a fork release
branch as the upstream PR head. No integration-candidate or merge result is
claimed until an actual upstream PR exists and its gates have run.
