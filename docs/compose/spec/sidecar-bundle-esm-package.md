---
feature: sidecar-bundle-esm-package
status: delivered
updated: 2026-09-17
branch: fix/sidecar-bundle-esm-package
commits: 8d826433868f6bcc992c29bae2f799cc6de1e069..7d6890ebc7816675c31f707460efcf0601310e40
---

# Sidecar Bundle ESM package.json

## Report

**What was built** — Packaged installs copy `packages/agent-runtime/dist-bundle` to `resources/agent-runtime` via electron-builder `extraResources`. The directory previously contained only the esbuild ESM `sidecar.js`, so Node treated the entry as CommonJS and agent runtime died at startup with `SyntaxError: Cannot use import statement outside a module` (issue #507). The `bundle` script now chains a write of `dist-bundle/package.json` (`{"type":"module"}`) after esbuild. Desktop packaging and the sidecar spawn path are unchanged. Regression tests lock the extraResources directory-copy mapping and the bundle write-step contract (including a real execution of the write command in a temp dir).

**Verification** —
- `pnpm -C packages/shared build` — PASS
- `pnpm -C packages/agent-runtime bundle` — PASS; `dist-bundle/{sidecar.js,package.json}` with `"type":"module"`
- `node --test test/agent-runtime-bundle-package.test.mjs test/packaging-footprint.test.mjs` from `apps/desktop` — PASS 13/13
- Independent review of `8d826433..7d6890eb` — no critical findings

**Journey log** —
- Issue #507’s “VPN” framing is not supported by logs: model discovery returned HTTP 401 (auth), while the agent path failed on sidecar ESM packaging. Scope kept to the packaging defect.
- Fresh worktrees need `pnpm -C packages/shared build` before `agent-runtime` bundle; cold esbuild fails on missing shared `dist/` exports before the write step runs.
- Unit tests intentionally skip full esbuild (shared rebuild + multi-second CPU); contract + write-step execution covers the packaging invariant, with full bundle verified out of band.
- Desktop unit-test runner is `node --test test/*.test.mjs` — `pnpm --filter @pi-desktop/desktop test -- <file>` does not isolate a single file.

## [S1] Problem

Issue #507 (v0.14.8 Windows packaged install) shows the agent sidecar dying at startup:

```text
SyntaxError: Cannot use import statement outside a module
  at .../resources/agent-runtime/sidecar.js:1
```

`resources/agent-runtime/sidecar.js` is the esbuild ESM bundle copied from
`packages/agent-runtime/dist-bundle` via electron-builder `extraResources`.
`dist-bundle` contains only `sidecar.js`. Node's nearest-`package.json` lookup
finds no `"type": "module"`, so the `.js` entry is loaded as CommonJS and the
ESM `import` banner fails. Development is unaffected because the repo package
itself declares `"type": "module"`.

This is independent of VPN and of the separate `model list request failed (401)`
auth error in the same report.

## [S2] Design

1. The `bundle` script in `packages/agent-runtime/package.json` must, after
   esbuild, write `dist-bundle/package.json` containing at least
   `{"type":"module"}` so electron-builder ships it beside `sidecar.js`.
2. No change to `apps/desktop` `extraResources` mapping: the whole
   `dist-bundle` directory is already copied to `agent-runtime`.
3. No change to `agent-sidecar.ts` spawn path or entry filename.
4. Regression coverage must assert the packaging contract:
   - after a successful bundle, `dist-bundle/package.json` exists and sets
     `"type": "module"`;
   - desktop `extraResources` still sources `agent-runtime` from
     `../../packages/agent-runtime/dist-bundle` (so the new file is shipped).

## [S3] Out of Scope

- HTTP 401 / API-key UX for model discovery (user config; not this bug).
- Issue #506 plugin ESM/CJS main generation.
- Renaming the entry to `sidecar.mjs` or switching the bundle to CJS.
- Proxy/VPN transport behavior.

## Tasks

- [x] T1: Emit `dist-bundle/package.json` with `"type":"module"` from the agent-runtime bundle script — acceptance: `pnpm -C packages/agent-runtime bundle` produces `dist-bundle/sidecar.js` and `dist-bundle/package.json` with `"type":"module"` (covers: S2)
- [x] T2: Add packaging regression tests for the ESM package.json contract — acceptance: tests fail without T1 and pass with it; they cover both the bundle output and the desktop extraResources source path (covers: S2; depends: T1)
