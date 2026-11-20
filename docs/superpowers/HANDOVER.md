# Handover: remote GitHub sessions on paired hosts

- Snapshot: 2026-11-20, about 08:30 UTC
- Repository: `david-yang-pixel/PI-Desktop` (fork of `vastsa/PI-Desktop`)
- Branch: `claude/trusting-darwin-gnyao7`, pushed up to `04d00f0f` at the time of writing
- Status in one line: part 1 of 7 is built and verified on GitHub Actions; parts 2 and 3 are being implemented in local worktrees; parts 4 to 7 are planned and not started.

## What this project is

The owner wants the new-session experience of Claude Code's cloud sessions on
their own remote host: choose an environment, a GitHub repository, and a
branch under the composer; the Agent then works in an isolated checkout of that
repository on the host, and the result is pushed as a branch and opened as a
pull request.

Read these first, in this order:

1. `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` — the
   approved design. §10 lists the decisions the designer made on the owner's
   behalf; §9 has the owner's answers.
2. The plan for the part you are about to touch, under
   `docs/superpowers/plans/`. Each plan has a "Cross-plan contract" section
   whose names are fixed, because other parts are built against them.
3. `AGENTS.md` and `CLAUDE.md` — repository rules.

## Decisions the owner made

- Each session gets its own git worktree and work branch on the host; the
  repository is cloned on the host once.
- A dedicated host capability (`workspaceGit`), not shell commands composed by
  the desktop.
- The fork releases through GitHub Actions on a tag.
- No Apple Developer ID certificate; desktop releases are macOS arm64 only.
- Agent GitHub tools and environment setup scripts and variables are in scope.
- Network policy for host commands is out of scope: a separate later project.
- Sessions do not keep running while the desktop is closed. The Agent, model
  requests, and model credentials stay on the desktop.

## Progress by part

| Part | Plan file | State |
| --- | --- | --- |
| 1. Fork release pipeline | `2026-11-20-fork-release-pipeline.md` | Code complete, reviewed, pushed. Dry run passed. One owner check left |
| 2. Host git workspaces | `2026-11-20-host-git-workspaces.md` | In progress in a local worktree: 9 of 12 tasks committed |
| 3. GitHub connector | `2026-11-20-github-connector.md` | In progress in a local worktree: all 7 tasks committed, final gate and review pending |
| 4. Environments and session targets | `2026-11-20-environments-and-session-targets.md` | Planned (11 tasks). Blocked on parts 2 and 3 |
| 5. Push, pull request, cleanup | `2026-11-20-remote-session-push-and-pull-requests.md` | Planned (9 tasks). Blocked on part 4 |
| 6. GitHub tools for the Agent | `2026-11-20-github-agent-tools.md` | Planned (5 tasks). Blocked on part 3 only |
| 7. Setup script and variables | `2026-11-20-environment-setup-and-variables.md` | Planned (5 tasks). Blocked on part 4 |
| Network policy | none | Not planned. Deferred by the owner |

Counted in plan tasks: 6 done (part 1), 16 committed but not yet reviewed or
merged (parts 2 and 3), 33 not started (3 left in part 2, then parts 4 to 7).

### Part 1 in detail

Eight code and documentation commits on the branch, `b5021121` to `c112d4a1`:

- Release coordinates point at the fork: update feed, `pi-host` bundle URLs,
  in-app feedback link.
- An unsigned build is stamped `piDistribution: "unsigned"`, ad-hoc signed, and
  always uses manual update delivery.
- `release.yml` builds macOS arm64 unsigned plus the Linux x64 and arm64
  `pi-host` bundles. Signing is opt-in through the repository variable
  `MACOS_SIGN_RELEASE`; the upstream signed lane is untouched and dormant.
- Upstream's issue automation is gated to the upstream repository.
- Decision record `docs/adr/fork-release-coordinates.md`, decision D686.

Verification:

- Local: build, desktop typecheck, lint, release-docs check, docs check all
  pass. No test fails that did not already fail before the change.
- GitHub Actions dry run (`workflow_dispatch`, no tag, nothing published):
  <https://github.com/david-yang-pixel/PI-Desktop/actions/runs/44699269208>,
  conclusion success. The verify job, both host bundles, and the macOS build
  passed, including the step that checks the packaged marker and the bundle
  seal. Artifacts `dist-mac-arm64`, `pi-host-linux-x64`, `pi-host-linux-arm64`
  are kept until 2027-02-18.
- Not run: Rust tests locally for part 1 (no Rust changed; they passed in the
  dry run).

An independent review found two defects that every test had missed, both
fixed: the packaging flags were passed after a literal `--`, so
electron-builder silently ignored them; and the updater read the distribution
marker only on Windows.

### Parts 2 and 3: where the work is

They are **not on the remote**. They live in this container only:

| Part | Worktree | Branch | Base |
| --- | --- | --- | --- |
| 2 | `/home/user/PI-Desktop-worktrees/host-git-workspaces` | `feat/host-git-workspaces` | `876093a7` |
| 3 | `/home/user/PI-Desktop-worktrees/github-connector` | `feat/github-connector` | `876093a7` |

Each worktree has its own `pnpm install`. A background implementer agent is
working in each. If this container is reclaimed before they are merged and
pushed, that work is lost; the plans are enough to redo it.

For each part, the remaining steps are: the implementer finishes and reports;
a fresh reviewer reviews the whole branch against its plan, with the plan's
"Review Focus" list; one fix pass, each fix with a test that failed first;
merge into `claude/trusting-darwin-gnyao7`; push.

Expect merge conflicts between the two branches in
`packages/shared/src/errors.ts`, `packages/shared/src/index.ts`,
`docs/adr/README.md`, `docs/spec/08-meta/decisions-log.md`,
`docs/spec/03-runtime/08-error-codes.md`, and
`docs/spec/06-delivery/04-e2e-test-plan.md`. Both sides only add; keep both.

## What comes next, in order

1. Finish, review, and merge parts 2 and 3.
2. Re-check the plans for parts 4 and 6 against the merged code, then
   implement them. They are independent of each other.
3. Re-check and implement parts 5 and 7. Both depend on part 4.
4. Cut a fork release so paired hosts pick up the new `pi-host`. The host
   bundle is downloaded at the desktop's version, so a release that changes the
   host needs a new version number.

Decision ids are reserved per part: D687 (part 2), D688 (3), D689 (4), D690
(5), D691 (6), D692 (7).

## Owner actions outstanding

1. **Verify the part 1 build on a Mac.** Download `dist-mac-arm64` from the dry
   run, install the DMG, run
   `xattr -dr com.apple.quarantine /Applications/PI-Desktop.app`, open the app,
   and confirm "Check for updates" offers the releases page and starts no
   in-app download.
2. **Register a GitHub OAuth App** for the fork with device flow enabled and
   provide its client ID. It goes into `GITHUB_OAUTH_CLIENT_ID` in
   `packages/shared/src/github-connector.ts`. Until then sign-in works with a
   pasted personal access token only.
3. **Enable Issues on the fork.** The in-app feedback link now points there.
4. **After the OAuth App exists**, run `scripts/probe-github-mcp.mjs` (created
   by part 6) with a device-flow token. See "Open risks".
5. **Cut the first fork release** when ready:
   `node scripts/release.mjs <version> --tag`, then push the branch and the
   tag.

## Open risks and known gaps

- **GitHub's hosted MCP server and device-flow tokens.** Part 6 assumes the
  hosted endpoint accepts a token from a third-party OAuth App. GitHub's
  documentation implies it and does not state it. No automated test can check
  it. If the probe fails, part 6 needs a small set of REST-backed tools,
  which is not planned.
- **Shared data directory.** The fork keeps upstream's application identifier,
  so a fork build and an upstream build on one machine share
  `~/.pi-desktop`. The design avoids any SQLite schema change so both can open
  the same data.
- **Upstream's signed lane has the same `--` flag bug** that part 1 fixed for
  the unsigned lane. The fork does not use that lane. It would matter if the
  owner later obtains a certificate.
- **Merges from upstream will conflict** in `.github/workflows/release.yml`
  (the fork keeps one matrix row) and, after part 2, in the RACP contract
  packages.
- **Minor items deferred from the part 1 review:** a stale header comment in
  `apps/desktop/electron/main/updater.ts`; two comments that still tie host
  bundles to the desktop build matrix; the `sign_macos` input description; an
  E2E fixture that still carries the upstream releases URL; the runbook's fork
  section does not mention enabling Issues and Actions; ADR 0022 is not
  amended for the unsigned mode.

## Working notes for whoever continues

- This container runs as root. Electron needs `--no-sandbox`, which the
  repository's own Electron E2E scripts do not pass. Drive the app with
  Playwright's `_electron` instead, with `xvfb-run`.
- Some tests fail here and pass on GitHub's runners: one in
  `packages/agent-runtime` (`managed-exec.test.ts`) and about sixteen
  timeout-sensitive ones in `apps/desktop`. `pnpm -r test` stops at the first
  failing package and skips its dependents, so run the desktop suite directly:
  `cd apps/desktop && node --test test/*.test.mjs`. Compare against a baseline
  taken before your change rather than expecting a clean run.
- The pinned pnpm forwards a literal `--` to scripts. Pass electron-builder
  flags without it.
- A git worktree cannot share the primary checkout's `node_modules` when the
  change spans workspace packages, because symlinks resolve to the primary
  checkout's copies. Install in the worktree; it takes seconds from the local
  store. For Rust, pointing `CARGO_TARGET_DIR` at the primary checkout's
  `target` reuses compiled dependencies, as long as only one build runs.
- The session may push only to `claude/trusting-darwin-gnyao7`.
- No pull request has been opened.
