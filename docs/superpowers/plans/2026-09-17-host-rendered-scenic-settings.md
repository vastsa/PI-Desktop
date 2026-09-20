# Host-rendered Scenic Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque plugin Settings page with host-rendered scenic cards and an Apply-gated blur slider.

**Architecture:** Plugins submit a strictly validated `scenicThemes` data contribution. Electron main validates same-plugin themes and assets, then returns safe presentation metadata. React renders the content directly in Settings, so neither a native child view nor an iframe exists between the scenic background and controls. The existing typed `themes.setVariables` API stays the only persistence writer.

**Tech Stack:** TypeScript, Plugin SDK manifest validation, Electron IPC, React, existing theme runtime, CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-17-host-rendered-scenic-settings-design.md`

## Global Constraints

- Do not modify Nexus.
- Preserve `ui.theme`, `ui.settings`, `ui.window.appearance`, native controls, Settings navigation, work panel behavior, and theme isolation.
- Plugins contribute no Settings HTML, JavaScript, CSS, DOM, selectors, or arbitrary actions.
- Blur accepts only integer 0 through 20. Card selection is immediate; Apply is the only persistence action.
- The outer scenic destination stays transparent. Cards and the blur control are the only material surfaces.

---

### Task 1: Add the closed scenic manifest contribution

**Files:**
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/plugin-sdk/src/index.test.ts`
- Modify: `docs/spec/07-plugins/02-plugin-manifest-schema.md`

**Interfaces:** Add `PluginScenicThemesContrib` (`id`, localized `label`, `description`, `keywords`, `icon: "palette"`, `themes`) and `PluginScenicThemeCardContrib` (`themeId`, localized `label`, localized `description`, `previewAsset`).

- [ ] Write failing tests that reject zero cards, thirteen cards, duplicate `themeId`, string-only card copy, invalid IDs, non-relative preview paths, and unknown icon tokens.
- [ ] Run `pnpm --filter @pi-desktop/plugin-sdk test -- index.test.ts` and observe failure because `scenicThemes` is not recognized.
- [ ] Implement types and manifest validation. Require 1–12 cards, localized EN/zh-CN values, valid stable id, and relative image asset path.
- [ ] Run the SDK test green and commit `feat(plugins): declare scenic Settings contributions`.

### Task 2: Provide host-validated scenic metadata

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `apps/desktop/electron/main/plugin-runtime.ts`
- Modify: `apps/desktop/electron/main/ipc/plugin-ui-ipc.ts`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/test/plugin-appearance-extensions.test.mjs`

**Interfaces:** Add `PluginScenicThemesDestinationMeta` with destination identity, resolved copy, cards in manifest order, namespaced owned theme IDs, host rewritten `previewUrl`, and current/default blur. Add `api.listPluginScenicThemesDestinations()`.

- [ ] Write failing test assertions for `pluginScenicThemesDestinations`, `previewUrl`, both `ui.settings` and `ui.theme` checks, same-plugin theme ownership, and no `entry` HTML dependency.
- [ ] Run `node --test apps/desktop/test/plugin-appearance-extensions.test.mjs` and observe failure.
- [ ] Implement the endpoint. Include only loaded plugins with both grants. Verify every card refers to a registered same-plugin theme and that the preview belongs to that theme's declared assets. Rewrite image URLs through `plugin-asset://`; omit invalid destinations. Return current/default `--nexus-backdrop-blur` values only when that typed length variable is declared as whole integer 0–20.
- [ ] Run the focused test green and commit `feat(plugins): expose host scenic destination metadata`.

### Task 3: Build the host React scenic destination

**Files:**
- Create: `apps/desktop/src/components/settings/PluginScenicThemesDestination.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/styles/settings.css`
- Modify: `apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

**Interfaces:** Component consumes `PluginScenicThemesDestinationMeta`, the existing theme selection API, and typed variable API. It renders host-owned card buttons (`aria-pressed`), native `input type="range"`, `output`, and Apply button.

- [ ] Write failing test assertions that `SettingsPage` imports `PluginScenicThemesDestination`, contains no `PluginSettingsDestination`, and that the component contains `aria-pressed`, native range, `Apply`, and no iframe. Assert scenic wrapper CSS background is transparent.
- [ ] Run `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs` and observe failure.
- [ ] Implement transparent outer wrapper and responsive four-card grid. Card click changes theme immediately. Slider changes local draft and output only. Apply sends exactly `{ "--nexus-backdrop-blur": draftBlur }` for the selected owned theme, confirms only after success, restores confirmed value after error, and uses existing toast behavior.
- [ ] Style independent image cards and blur-control tile using host CSS. Add selected checkmark, visible focus, narrow layout, and opaque readable reduced-transparency fallback. Do not add a page-sized panel/background or modify chrome/drag rules.
- [ ] Run focused test green and commit `feat(settings): render scenic plugin themes in host`.

### Task 4: Migrate Nexus Scenic Themes pack

**Files:**
- Modify: `C:/jcode projects/worktrees/nexus-scenic-settings-20260915/plugins/io.github.akshayxkill.nexus-scenic-themes/manifest.json`
- Delete: `C:/jcode projects/worktrees/nexus-scenic-settings-20260915/plugins/io.github.akshayxkill.nexus-scenic-themes/settings/index.html`
- Delete: `C:/jcode projects/worktrees/nexus-scenic-settings-20260915/plugins/io.github.akshayxkill.nexus-scenic-themes/settings/settings.css`
- Delete: `C:/jcode projects/worktrees/nexus-scenic-settings-20260915/plugins/io.github.akshayxkill.nexus-scenic-themes/settings/settings.js`
- Modify: `C:/jcode projects/worktrees/nexus-scenic-settings-20260915/tests/nexus-scenic-themes.test.mjs`

- [ ] Write a failing plugin test requiring four `scenicThemes` cards in Twilight, Alpine, Obsidian, Emerald order; requiring `settingsDestinations` absent; and requiring the three page files absent.
- [ ] Run `node --test tests/nexus-scenic-themes.test.mjs` in the plugin checkout and observe failure.
- [ ] Replace the manifest HTML destination with four cards using existing declared asset paths and themes. Preserve the three requested permissions and typed blur variable. Remove the obsolete page directory.
- [ ] Run plugin test green and commit `feat(nexus-scenic-themes): use host scenic settings` in the plugin checkout.

### Task 5: Retire the HTML Settings runtime and synchronize specs

**Files:**
- Delete: `apps/desktop/src/components/settings/PluginSettingsDestination.tsx`
- Delete: `apps/desktop/electron/main/plugin-settings-protocol.ts`
- Modify: `apps/desktop/electron/main/bootstrap/startup.ts`
- Modify: `apps/desktop/electron/main/ipc/plugin-ui-ipc.ts`
- Modify: `docs/adr/0255-plugin-appearance-extensions.md`
- Modify: `docs/adr/0287-host-rendered-plugin-scenic-settings-surfaces.md`
- Modify: `docs/spec/07-plugins/04-plugin-security.md`
- Modify: `docs/spec/06-delivery/04-e2e-test-plan.md`
- Modify: `apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

- [ ] Write failing retirement assertions: no `PluginSettingsDestination` import, no `installPluginSettingsProtocol`, ADR 0255 contains `host-rendered`, and security spec forbids plugin Settings DOM/CSS/HTML.
- [ ] Run `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs` and observe failure.
- [ ] Remove iframe/page protocol lifecycle and document the narrow declarative contract, security boundary, visual ownership, Apply semantics, cleanup fallback, native controls, and manual E2E coverage.
- [ ] Run focused test green and commit `refactor(plugins): retire Settings document surfaces`.

### Task 6: Validate and manually inspect

- [ ] Run:

```powershell
node --test apps/desktop/test/plugin-appearance-extensions.test.mjs apps/desktop/test/plugin-settings-renderer-surface.test.mjs apps/desktop/test/plugin-themes.test.mjs
pnpm --filter @pi-desktop/plugin-sdk test
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/desktop exec tsc -p tsconfig.json --noEmit
git diff --check
```

- [ ] Run the fork with `pnpm --filter @pi-desktop/desktop dev`; confirm four image cards appear directly on the scenic canvas without an outer rectangle, blur draft changes do not persist before Apply, Apply persists values, and Windows/Linux controls remain clickable.
- [ ] Review the complete diff. Rebase this branch onto local main, merge into local main from the primary checkout, verify commits, and remove only this request worktree/branch. Do not push unless explicitly requested.
