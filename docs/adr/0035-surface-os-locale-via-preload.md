# ADR 0035: Surface the OS locale through the preload bridge

- Status: Accepted
- Date: 2026-07-30
- Related: [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md) · [04-ux/02-i18n-english-first](../spec/04-ux/02-i18n-english-first.md) · [04-e2e-test-plan](../spec/06-delivery/04-e2e-test-plan.md) · E2E-091

## Context

The Settings → Basics → Language **Auto** option follows the OS display
language, but it resolved "auto" from the renderer's `navigator.language`. In
Electron that value is the embedded browser locale and reports `en-US` even on a
Simplified Chinese system, so Auto chose English and seeded the first paint with
the wrong language. Only the main process can read the real OS locale.

## Decision

Expose the authoritative locale through the preload bridge as a synchronous
`window.piDesktop.locale` field: main resolves `app.getLocale()` at window
creation and passes it through `webPreferences.additionalArguments`, which
sandboxed preload reads without importing `app`. `api.ts` types the field as
optional because non-Electron contexts receive no window argument. A new
`resolveOsLocale()` helper in `lib/app-language.ts` prefers the bridge field and
falls back to `navigator.language`, and `main.tsx` seeds i18n `lng` from it. No
IPC channel is needed, and the value is available before first paint like
`platform`.

## Consequences

- Auto matches the real OS language, and the Auto card shows the detected one.
- First paint starts in the correct language.
- The `window.piDesktop` contract gains one read-only string; unit tests and web
  builds keep working through the `navigator.language` fallback.

## Alternatives

- Keep `navigator.language`: it is the root cause and cannot see the OS locale.
- Async IPC call: delays the first paint that a pre-paint value avoids.
