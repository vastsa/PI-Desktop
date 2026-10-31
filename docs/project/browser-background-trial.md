# Browser background lifecycle trial

## Candidate

- Branch: `feat/browser-background-lifecycle`
- Worktree: `worktrees/browser-background`
- Base main: `36e19eb59b9b4e0cab1e2d47b8bcb70304ddad60`
- The user approved landing the validated browser changes through a pull request.
- The primary checkout was not modified.

## Behavior

The Browser stays in the side work panel. Main owns its session-connected page
independently of panel visibility, conversation selection and renderer mounting.
Hidden pages use an invisible sandboxed backing host. Background tools do not
retarget the visible conversation or reopen its side panel. Shell reload restores
live page metadata without reloading its DOM. Explicit page/session closure,
plugin disable and app/window shutdown still release resources.

## Verification performed

- Desktop targeted Node tests: **185 passed** across `browser-*.test.mjs`,
  `plugin-tool-invocations.test.mjs` and `work-panel*.test.mjs`.
- Shared protocol contract tests: **15 passed** (`src/protocol.test.ts`).
- Landing preparation: the complete Desktop suite passed **4305 tests** with
  3 environment-dependent skips; the Shared suite passed **1281 tests**.
- Documentation locale/structure checks and VitePress site build passed.
- Desktop TypeScript typecheck: passed.
- Workspace TypeScript dependencies and Electron/Vite build: passed.
- Biome lint and style-token guard: passed; no automatic fixes applied.
- `git diff --check` and PR-base ancestry check: passed on the base above.
- Isolated native Electron suites: `e2e-browser-background.mjs`,
  `e2e-browser-capture-resize.mjs` and `e2e-browser-local-file-access.mjs` passed.
- Actual Desktop user path on the refreshed candidate: Composer submission,
  ToolSearch, Browser tool, plugin child process, sidecar and Host used their
  production wiring. After A's snapshot, selection changed to B; A filled its
  form, clicked its button, captured a screenshot and completed while B remained
  visible. Returning to A showed the retained page.
- Actual recovery path: collapse the side panel, enter Settings, reload using
  native CDP `Page.reload`, select A and reopen the panel. Native page identity,
  `A: Background OK` input and button count `1` were preserved.

## Environment and limitations

Electron 43.6.0 / Chromium 150.0.7871.250, Node 24.14.0; dependencies and the
compatible Rust Host binary were reused from the primary development environment.
Build outputs stayed in the task worktree. Profiles, synthetic sessions, localhost
model fixture, logs and screenshots stayed in session scratch. No real provider,
user credentials or paid API was used.

Package-manager commands could not use the linked dependency topology, so the
installed TypeScript/Electron/Vitest tools were invoked directly. No second
installation was created. `verify:ui:*` and Rust source validation were not run;
the Rust source was unchanged. An optional
secondary review was cancelled without a final report; no review result is
claimed.

There is no restart DOM persistence or automatic cross-session page sharing.
Retained pages consume memory until explicitly closed. This record covers the
isolated candidate validation; PR integration checks are recorded in the PR.
