# Pi 0.99.1 adoption

Status: scoped migration implemented and local candidate validated; release
qualification is separate. Comprehensive review findings and repairs are in
[the migration review](pi-0991-review.md). These are local candidate results;
installed release qualification is separate.

## Scope and implementation

Migrate pi-ai and pi-agent-core to 0.99.1. pi-coding-agent stays pinned compatibly
for existing compaction/file utilities; no new AgentSession dependency is added.
MCP implementation, Desktop plugin SDK, installation, grants and lifecycle remain
owned by Desktop. Tool composition, Codemode and virtual routing were evaluated
in [the design review](pi-coding-agent-design-review.md), not enabled.

- Published and effective model metadata use account-scoped Pi Models. Host owns
  credentials and explicit binding overrides. Startup is cache-only with ambient
  auth disabled. Same-vendor accounts, deletion and disabled accounts remain
  isolated. Settings reads published metadata separately from user overrides.
- OAuth live entitlement discovery publishes through the Pi provider refresh
  boundary. Existing headers and live-only same-tier transport/thinking behavior
  survive, with unknown prices retained. Installation identity is persisted before
  login, concurrent-safe, restart-stable and separate from account credentials.
- Native thinking helpers normalize actual dispatch, including unsupported/native
  null effort mappings and omitted reasoning, without rewriting saved settings.
- Images enter Pi generateImages through native OpenRouter or a compatible
  OpenAI-images adapter. Generations/edits, bounded downloads, cancellation,
  stable batch artifacts, response text/IDs and physical usage remain supported.
- Physical request usage IDs propagate through runtime, Host, remote events and
  renderer. Retry/delegate/image replay bills once; unknown cost differs from a
  known free operation. Immediate nested parent differs from owning Task.
- Release scripts no longer fetch/package an independent models.dev catalog.
  Display-only non-chat compatibility metadata preserves settings visibility;
  it supplies no credentials, runtime dispatch, pricing or entitlement.

## Candidate and environment

- Worktree: `PI-Desktop-worktrees/pi-0991-resume`.
- Branch: `refactor/pi-0991-resume`.
- Base main: `e77404ea3c4834a6213759868a66cde8da759056`.
- Original Claude session: `d4616efd-1246-40aa-b2e2-3a3767555595`;
  original migration and interrupted worktrees are preserved.
- Reused host Node/pnpm dependencies and Cargo target. Lockfile-only resolution
  records the new Pi pins/patches. Offline fixtures replace external provider I/O.

## Validation evidence

After withdrawing out-of-scope coding-agent/MCP integrations and completing the
account isolation, compaction and durable usage review:

| Check | Result |
| --- | --- |
| Full agent-runtime suite | 1,150 passed / 81 files |
| Full Desktop suite | 3,271 passed / 0 failed |
| Full shared suite | 1,156 passed / 94 files |
| agent-host | 53 passed / 4 files |
| host-runtime | 93 passed / 14 files |
| host-core | 704 passed |
| JS workspace build | Passed |
| Desktop typecheck | Passed |
| Lint (Biome and style tokens) | Passed |
| cargo fmt --check | Passed |
| cargo clippy, all targets, locked | Passed with existing dead-code/unused-variable warnings |
| Production sidecar hosted-search E2E | All 7 scenarios passed |
| Pi patch clean-application verification | All 3 patches passed; installed patched files match |
| Documentation and release preflight | 540 pages, locale pairing and release checks passed |
| Changed-file secret pattern scan | No high-confidence credential candidates |

Production sidecar SHA-256:
`6192678b203bd04dbcb75e24ca229a808eef8bfdd01af4e19e3894945c3eb38e`.
The scenarios cover next-prompt search, read, changed instructions, delegation,
persisted restore and invalid search container/phase. Standalone OAuth tests in
the Desktop suite load and execute actual ChatGPT/Meta login modules outside the
repository with external I/O mocked. Image tests enter the real Pi operation API.
Usage tests cover replay, late turns, nesting, compaction attempts, offline outbox
recovery, known-free/unknown cost, malformed external counts and Host integer
overflow. The retained coding-agent patch also has a public offline SDK compaction
regression. Build/typecheck, fmt and clippy passed; existing bundle-size and
unused-variable/dead-code warnings remain.

The first scoped Desktop run had three retired catalog/layout source assertions.
They were updated to Pi published metadata and the actual resources contract;
the complete rerun passed. No product behavior test was removed.

## Release limits

Installed Electron, real accounts/paid providers, cross-platform artifacts and
cross-version rollback were not tested. No UI verification command was run because
it was not requested. These checks are release qualification, not evidence supplied
by local offline regression. Remaining release work is in
[pi-0991-gaps.md](pi-0991-gaps.md).

## Main integration validation

The integration candidate `4dd33805f` combines the migration commit
`b72ff6759` with target main `e93295ad9`. The only conflict was the macOS
microphone permission description; the latest Live Voice description is retained.

The executable candidate passed the JS workspace build, Desktop typecheck,
3,303 Desktop tests, 1,150 runtime tests, 57 agent-host tests, 109 host-runtime
tests, 705 Host Rust tests, lint, documentation checks and release preflight.
All seven production sidecar hosted-search scenarios passed, with SHA-256
`6192678b203bd04dbcb75e24ca229a808eef8bfdd01af4e19e3894945c3eb38e`.
The shared package and Pi patches have the same tested executable contents as
the scoped review candidate above. This record adds documentation only.

Installed artifacts, real accounts and cross-version rollback retain the same
qualification limits. Local main landing does not qualify or deploy a release.
