# ADR 0035: Surface the OS locale through the preload bridge

- Status: Accepted
- Date: 2026-07-30
- Related: [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md) ·
  [04-ux/02-i18n-english-first](../spec/04-ux/02-i18n-english-first.md) ·
  [04-e2e-test-plan](../spec/06-delivery/04-e2e-test-plan.md) · E2E-091
- Updates: the `window.piDesktop` preload contract in
  [api.ts](../..//apps/desktop/src/lib/api.ts)

## Context

The Settings → Basics → Language control offers an **Auto** option that should
follow the user's OS display language. The original implementation resolved
"auto" from the renderer's `navigator.language`.

## Decision

1. Expose the authoritative OS locale from the preload bridge as a synchronous
   field `window.piDesktop.locale`.
2. Add optional `locale?: string` to the `window.piDesktop` type in `api.ts`;
   non-Electron contexts do not receive a window creation argument.
3. Resolve "auto" language through a new `resolveOsLocale()` helper in
   `lib/app-language.ts` that prefers `window.piDesktop.locale` and falls back
   to `navigator.language` / `userLanguage` for non-Electron contexts (e.g.
   tests).
4. Seed the initial i18n `lng` in `main.tsx` from `resolveOsLocale()` instead of
   `navigator.language`.

This keeps OS-fact resolution in the main process and requires no new IPC
channel (the value is available before first paint, like `platform`).

## Consequences

- "Auto" language now matches the real OS display language (e.g. Simplified
  Chinese on a Chinese system), and the Auto card shows the detected language
  inline ("当前：简体中文").
- Initial i18n language on first paint is correct for the OS locale.
- The `window.piDesktop` preload contract grows one read-only string field.
- Non-Electron contexts (unit tests, potential web builds) fall back to
  `navigator.language` and remain functional.

## Alternatives

### Keep using `navigator.language`

Rejected: it is the root cause of the misdetection and cannot see the OS
language from the renderer in Electron.

### Add an async IPC call for the OS locale

Rejected: an async round-trip would delay first paint of the correct language
and complicate the synchronous pre-paint setup that already uses `platform`.

## References

- `apps/desktop/electron/main/index.ts` (passes `app.getLocale()` through
  `additionalArguments`)
- `apps/desktop/electron/preload/index.ts` (reads the locale argument without
  importing `app`)
- `apps/desktop/src/lib/api.ts` (`window.piDesktop.locale` type)
- `apps/desktop/src/lib/app-language.ts` (`resolveOsLocale`,
  `resolveAppLanguage`)
- `apps/desktop/src/main.tsx` (initial `lng` from `resolveOsLocale`)
- `apps/desktop/src/pages/SettingsPage.tsx` (Auto card shows detected language)
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-091 added)
