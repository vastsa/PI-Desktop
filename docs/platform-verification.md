# AI Aggregation Platform: local implementation and verification

Date: 2026-09-27. This is a local fork, not an upstream release or a production
deployment. No New API server, PostgreSQL instance, remote account configuration,
or payment order was changed during this work.

## Source and environment

- Primary repository: `/Users/lyw/full-stack/PI-Desktop`.
- Implementation: `/Users/lyw/full-stack/PI-Desktop/.worktrees/ai-platform`.
- Branch: `codex/ai-platform`.
- Base/HEAD: `3f5ada32eadd002a283d59820682b1a60addf30d`, also the fetched
  `origin/main` at preparation. The implementation is an **uncommitted working
  tree**; no commit, push, PR or merge was requested.
- Root `AGENTS.md` section 17 (commit only when requested) takes precedence over
  the older commit-per-change wording in the delivery workflow. Tests below
  validate the local working tree, not a published or PR integration candidate.
- macOS 26.6.2, arm64; Node 24.3.0; pnpm 10.34.5; Python 3.11.7;
  Rust 1.98.1; Electron from the unchanged pnpm lockfile.

The initial host environment lacked this repository's dependencies and a usable
Rust toolchain. `pnpm install --frozen-lockfile`, Rust stable, rustfmt and Clippy
were installed for that reason, not to duplicate an existing E2E environment.
The Electron package initially lacked its executable; its own `install.js`
completed that download. No dependency versions or lockfiles were changed.

The existing Cargo registry configuration was left intact. This machine's
crates.io TLS connection failed, so Cargo commands used a command-scoped sparse
mirror. After caching dependencies, the checks ran offline. For Clippy, pass
`--config` after the subcommand so its Cargo invocation receives the overrides:

```sh
~/.cargo/bin/cargo test \
  --config 'source.crates-io.replace-with="pi-mirror"' \
  --config 'source.pi-mirror.registry="sparse+https://rsproxy.cn/index/"' \
  -p host-core --locked --offline
~/.cargo/bin/cargo clippy \
  --config 'source.crates-io.replace-with="pi-mirror"' \
  --config 'source.pi-mirror.registry="sparse+https://rsproxy.cn/index/"' \
  -p host-core --all-targets --locked --offline
```

## Implemented behavior

### Mandatory provider

`packages/shared/src/ai-platform.ts` defines the product policy. The actual model
construction boundary in `packages/agent-runtime/src/provider-binding.ts` enforces
the platform vendor, fixed `https://ai.yykkj.com/v1` endpoint and API-key auth.
Conversation, subagent and one-shot paths share that boundary. Chat Completions,
Responses and Anthropic Messages remain supported through the platform.

Catalog metadata cannot replace transport/auth settings; foreign/OAuth/plugin
model transports and authenticated redirects are rejected. Existing foreign
provider data is retained, not deleted or converted with its old credentials.
Native Pi history stays readable but cannot continue through its independent
credential chain. This is product routing, not a sandbox for arbitrary scripts.

### Media Skill

`apps/desktop/resources/skills/ai-aggregation-platform.md` exposes the built-in
Skill `pi-desktop/ai-aggregation-platform`. `PlatformMedia` calls the bundled
Python CLI behind the Rust permission gate. It uses the selected platform row's
secret without a second setup or reading Codex/Pi/standalone credentials.

Supported operations: image generation/editing, image download recovery,
MiniMax-H3 creation with image/video/audio references, status, download and
billing lookup. Images fan out as independent `n=1` requests. Receipts persist
across restart; unknown creation outcomes are not automatically resubmitted.
Local references and recovery receipts are session-contained and bounded.
Cancellation stops the local process tree, not an already accepted upstream job.

Python 3.9+ is required for media. The existing `GenerateImages` interface remains
available with platform-only routing. Files and receipts are saved in session
scratch, not this source repository.

### Account and recharge

Settings > Models includes registration/login, recharge and token setup guidance,
plus a read-only token-allowance card. All new UI strings cover the repository's
nine locales. Multiple token rows require explicit selection for allowance.

`/api/usage/token/` is not an account wallet API. Currency conversion uses
`/api/status`; without valid conversion, the UI shows raw quota. Failed requests
are not shown as a zero balance. Unlimited token allowance does not mean the
account is funded. Recharge opens `https://ai.yykkj.com/wallet` in the browser.
Native payment orders, account login and reconciliation are **not implemented**.

## Media-default integration correction

The first local acceptance used an explicitly populated image binding and missed
a real onboarding regression. Selecting media IDs in a provider's model list did
not populate the independent `settings.imageGeneration`. The legacy image Skill
could select `GenerateImages`, which checked only that separate binding and
incorrectly returned `IMAGE_NOT_CONFIGURED` even with a valid platform key and
both image models saved. Three failing public-boundary regression cases reproduced
this before the fix (configured list, absent media list, and chat contamination).

The platform now owns the three built-in media routes. They are included on
provider creation/update, derived for existing profiles, preselected in the real
setup form even when discovery returns chat only, and classified as media in the
UI. Existing profiles work after restarting the rebuilt client; no key re-entry
or migration is required. The image default is visible in Settings, and legacy
`GenerateImages` falls back to the session/default platform account and Flare
without an extra settings write. Explicit selections and account isolation are
covered by regression tests. `PlatformMedia` also respects an image preference
belonging to its selected account. Text transport rejects media model IDs.

The correction changed client code only. It did not restart the user's running
app, modify their profile directly, make a paid generation call, or touch the
server. Restart the app with the same `PI_DESKTOP_DATA_DIR` to load the new build.

## Executed checks

Run commands from the implementation worktree. Fixtures use disposable local
state and synthetic keys; no inference request went to a paid provider.

| Command | Observed result |
| --- | --- |
| `pnpm --filter @pi-desktop/desktop test` | 3,072 tests passed; no skips |
| `pnpm --filter @pi-desktop/shared test` | 1,169 tests passed |
| `pnpm --filter @pi-desktop/agent-runtime test` | 1,116 tests passed |
| `pnpm --filter @pi-desktop/host-runtime test` | 52 tests passed |
| `pnpm --filter @pi-desktop/i18n test` | 27 tests passed |
| `pnpm test:platform` | 26 policy/media defaults, 42 binding, 5 bridge, and 85 desktop tests passed; overlaps the full suites |
| Cargo host-core tests, as above | 654 tests passed |
| `python3 -B -m unittest discover -s apps/desktop/resources/skills/ai-aggregation-platform/tests -p 'test_cli.py'` | 26 passed; 1 PowerShell case skipped because PowerShell is not installed |
| `pnpm --filter @pi-desktop/desktop run build:deps` | Passed |
| Desktop and agent-runtime `typecheck` | Passed |
| `pnpm --filter @pi-desktop/desktop build` | Passed; Vite reports large-chunk warnings |
| `pnpm lint` | Passed (configured Biome and style-token scopes) |
| `~/.cargo/bin/cargo fmt --check` | Passed after formatting the changed RPC match arms |
| Cargo Clippy, as above | Passed |
| `git diff --check` | Passed |

The final desktop and platform runs include the ambiguous multi-account alias
regression: opted-in accounts cannot silently satisfy an unresolved primary or
fallback pin. Exact account IDs and uniquely resolved names remain usable.
An earlier concurrent run intentionally caught these regression tests failing
before the fix; the final runs above are green. A pattern scan of changed and
new files found no private keys, long API tokens or JWTs; neither lockfile changed.

### Representative user paths

- Platform settings browser tests mount the real React controls in an isolated
  headless Chrome profile. They cover onboarding links, API-key setup, discovery,
  save/edit, token selection, stale responses, refresh errors, and Chinese copy.
- Provider IPC/runtime tests cover endpoint/auth rejection before secrets or
  network access, actual platform-bound request construction, session/subagent
  selection and read-only native Pi history.
- `node scripts/e2e-platform-media.mjs`: real Rust host, Node sidecar bridge,
  Python CLI, local HTTP fixture and disk output. Passed with 19 fixture requests
  and exactly 3 creation POSTs: Plan denial, two-image batch, multimodal video,
  host/sidecar restart, receipt recovery, status/download, task billing and image
  recovery without regeneration. The model driver is deterministic; this does
  not prove live model tool selection or real platform pricing.
- `node scripts/e2e-image-generation.mjs`: existing image tool, batch/edit,
  permission denial, persistence/restart and clearing the explicit binding;
  passed with 5 fixture requests, including automatic Flare generation after
  clearing the separate image setting.
- `node scripts/e2e-electron-boot.mjs`: actual isolated Electron boot,
  sandboxed preload/IPC, Rust host protocol 11, 800-session list responsiveness,
  and the project-delete IPC contract passed.

## Local preview

After the validated JS build and host build, this host can run:

```sh
cd /Users/lyw/full-stack/PI-Desktop/.worktrees/ai-platform
PI_DESKTOP_DATA_DIR="$HOME/.ai-aggregation-desktop-dev" pnpm preview
```

Use the separate data directory; do not point the fork at another installation's
profile. Register/login and recharge at the platform, create an inference token,
then add it in Settings > Models and choose a model supported by that account.
Media requires Python on PATH (Windows: `py -3` or `python`).

## Remaining acceptance / release gates

1. **Real service acceptance:** with a user-provided platform token and explicit
   spending authorization, test chat/tool calls, one image, multimodal editing,
   a short H3 video, restart recovery, actual output decoding and server-settled
   billing. Fixture amounts are not verified live prices.
2. **Windows:** run the same test commands on native Windows with Python and
   PowerShell. Verify spaces/Unicode paths, `py -3` selection, process-tree
   cancellation and media files in a packaged build. This macOS run does not
   establish Windows support by itself.
3. **Native payment:** agree on account authentication, create-order and
   reconciliation contracts before implementing native checkout. Browser return
   alone must never imply successful payment.
4. **Distribution:** configure an independent app identity, data profile,
   signing/notarization and update feed before distributing installers. Current
   upstream release metadata and badges are retained for attribution, not a
   configured release destination for this fork. No installer was published.
5. **Integration:** commit only when requested; repeat candidate E2E against the
   resulting commit and current remote base before any authorized publication.

No server code, server pricing, database schema or database migration was changed.

## Inline video delivery follow-up (2026-09-27)

- Confirmed the pre-fix regression with `scripts/e2e-video-preview.mjs`: an
  absolute scratch MP4 Markdown link outside the current workspace produced no
  player. The old anchor handler also rejected that path as non-workspace.
- Added contained local streaming and native Save As, without server/database
  changes or video regeneration. Old Markdown links, embedded video syntax,
  local file-URI links and HTML video src use the same preview component.
- Desktop tests: 3077 passed, zero skipped (`/tmp/pi-video-desktop-final.log`).
  After unifying scheme registration, the affected theme/video/image tests were
  rerun: 28 passed (`/tmp/pi-video-final-targeted.log`).
- Shared IPC contract: 14 passed; i18n: 27 passed. Desktop typecheck, repository
  lint and desktop dependency/production builds passed; the existing Vite large
  chunk warning remains.
- Isolated Electron with built-production CSP: actual local H.264 MP4 metadata,
  playback and seeking; save copies identical bytes; cancel, save errors, missing
  files, decoder retry and released capability URLs covered. Native dialog choice
  is stubbed at the OS boundary. No real generation request or platform charge.
- `e2e-electron-boot.mjs` passed with an isolated profile (protocol 11 and 800
  fixture sessions). The user's running instance was not restarted or modified.
- Native Windows playback/dialogs and arbitrary provider codecs remain Windows/
  codec-specific acceptance, not established by macOS fixture tests. Existing local
  artifact files are required; deleted files correctly show an error.

## Local application build scripts (2026-09-27)

- Added native macOS Bash and Windows PowerShell entry points plus a shared Node
  orchestrator. No existing release script, signing identity, runtime app ID,
  source version, database or server configuration was changed.
- `bash scripts/build-macos.sh --check`: passed on macOS arm64, Node 24.3.0,
  pnpm 10.34.5 and Rust 1.98.1 (`aarch64-apple-darwin`).
- Direct crates.io downloads timed out on this machine. The explicit
  `--cargo-mirror` flag reused the checksum-verified rsproxy registry cache
  without changing the user's Cargo config.
- `bash scripts/build-macos.sh --dir --cargo-mirror`: passed. Then
  `bash scripts/build-macos.sh --cargo-mirror`: passed, producing local arm64
  `.app`, DMG and ZIP artifacts in `apps/desktop/release/local/mac-arm64/`.
  Build logs: `/tmp/pi-platform-app-mac-build-mirror.log` and
  `/tmp/pi-platform-app-mac-full.log`.
- The packaged Rust executable is Mach-O arm64. Bundled agent-runtime and media
  scripts are present; `app-update.yml` is absent. The original PI-Desktop bundle
  identity remains, as documented. Ad-hoc `codesign --verify --deep --strict`
  passed; this is not Developer ID signing or notarization.
- The packaged application (not development Electron) booted against a fresh
  `pi-desktop-boot-*` temporary profile: `ok: true`, protocol 11, 800 synthetic
  sessions, project-remove IPC no-op. Log: `/tmp/pi-local-packaged-boot-final.log`.
  No user profile, credentials or paid provider was used.
- Build tests: 10 passed. Build plus existing release/update/window regressions:
  27 passed. Bash/Node syntax checks, final `pnpm lint`, and `git diff --check`
  passed. The existing Vite large-chunk and foreign-platform optional native
  dependency packaging warnings remain.
- Windows plan, quoting, output config and stop-on-failure contracts were tested
  on macOS; PowerShell and Windows native packaging/installation were NOT run.
  Intel macOS packaging was also not run. Those need matching native runners.
