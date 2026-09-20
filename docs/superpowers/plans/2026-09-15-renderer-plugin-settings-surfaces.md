# Renderer Plugin Settings Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace opaque native Settings extension views with renderer-composited, sandboxed plugin iframes so scenic backdrops remain visible throughout the Settings destination.

**Architecture:** A new host-owned `plugin-settings:` protocol serves only resources beneath a currently loaded, `ui.settings`-granted plugin package and adds CSP headers. Its synthetic bridge script exposes `window.pluginBridge` and uses `postMessage`. `PluginSettingsDestination` owns a sandboxed iframe and forwards only source-validated, destination-bound bridge requests through a new main IPC handler to the established `PluginRuntime.invokePanelBridge` authorization path. Native `PluginViewHost` remains for work-panel views only.

**Tech Stack:** Electron custom protocols and IPC, React/TypeScript, existing Plugin Runtime bridge, Node contract tests.

**Spec:** `docs/superpowers/specs/2026-09-15-renderer-plugin-settings-surfaces-design.md`

## Global Constraints

- Do not modify Nexus or alter the BrowserWindow transparency/native resize model.
- The iframe must be `sandbox="allow-scripts"`; no same-origin, popup, top-navigation, form, download, Electron, Node, or host-DOM capability.
- `plugin-settings:` may serve only a loaded plugin with `ui.settings`, only package-local static resources, with host-authored CSP and no network egress.
- Settings destinations must not instantiate `WebContentsView`; native work-panel views keep their current implementation.
- Retain existing `PluginRuntime.invokePanelBridge` channel validation, permissions, audit boundary, and plugin identity validation.
- Update plugin architecture/security/settings specifications, an ADR, and the E2E plan. Do not run E2E unless requested.

---

### Task 1: Define the Settings resource protocol and bridge contract

**Files:**
- Create: `apps/desktop/electron/main/plugin-settings-protocol.ts`
- Modify: `apps/desktop/electron/main/bootstrap/startup.ts`
- Modify: `apps/desktop/electron/main/services/plugin-services.ts`
- Modify: `apps/desktop/electron/main/ipc/plugin-ui-ipc.ts`
- Modify: `packages/shared/src/protocol.ts`
- Test: `apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

**Interfaces:**
- Produces `registerPluginSettingsScheme(): void` called before Electron readiness.
- Produces `installPluginSettingsProtocol(resolve): void`, where `resolve(pluginId, path)` returns `{ absolutePath, isEntry } | null` only for active `ui.settings` destinations.
- Produces `pluginSettingsUrl(pluginId, destinationId): string` used by renderer after host validation.
- Produces IPC `pluginSettingsBridgeInvoke({ pluginId, destinationId, requestId, channel, payload })` that verifies active contribution and delegates to `PluginRuntime.invokePanelBridge`.

- [ ] **Step 1: Write a failing contract test**

```js
test("Settings destinations use a host-owned sandbox resource protocol instead of a native view", () => {
  const protocol = read("electron/main/plugin-settings-protocol.ts");
  const ipc = read("electron/main/ipc/plugin-ui-ipc.ts");
  assert.match(protocol, /plugin-settings/);
  assert.match(protocol, /registerSchemesAsPrivileged/);
  assert.match(protocol, /Content-Security-Policy/);
  assert.match(protocol, /connect-src 'none'/);
  assert.match(ipc, /pluginSettingsBridgeInvoke/);
  assert.match(ipc, /invokePanelBridge/);
  assert.doesNotMatch(ipc, /pluginSettingsViews\.open/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: FAIL because the protocol and bridge IPC do not yet exist.

- [ ] **Step 3: Implement the protocol and validated bridge endpoint**

```ts
export const PLUGIN_SETTINGS_SCHEME = "plugin-settings";

protocol.handle(PLUGIN_SETTINGS_SCHEME, (request) => {
  const resource = resolve(pluginIdFromUrl(request.url), pathFromUrl(request.url));
  if (!resource) return notFound();
  return responseForPluginSettingsResource(resource);
});

handle(IPC.invoke.pluginSettingsBridgeInvoke, async (payload) => {
  const destination = requireActiveSettingsDestination(payload.pluginId, payload.destinationId);
  return plugins.invokePanelBridge(destination.pluginId, payload.channel, payload.payload);
});
```

The HTML response must reference the synthetic `/__pi_bridge__.js` file before
plugin scripts. The bridge script may only use `window.parent.postMessage` and
may not expose any Electron or Node object.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/plugin-settings-protocol.ts apps/desktop/electron/main/bootstrap/startup.ts apps/desktop/electron/main/services/plugin-services.ts apps/desktop/electron/main/ipc/plugin-ui-ipc.ts packages/shared/src/protocol.ts apps/desktop/test/plugin-settings-renderer-surface.test.mjs
git commit -m "feat(plugins): serve settings pages in renderer"
```

### Task 2: Replace the native Settings placeholder with a sandboxed iframe

**Files:**
- Modify: `apps/desktop/src/components/settings/PluginSettingsDestination.tsx`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/styles/settings.css`
- Test: `apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

**Interfaces:**
- Consumes `api.pluginSettingsDestinationUrl(pluginId, destinationId)` and `api.pluginSettingsBridgeInvoke(...)`.
- Produces an `<iframe sandbox="allow-scripts">` whose postMessage listener accepts only its `contentWindow` and a bounded bridge request envelope.

- [ ] **Step 1: Extend the failing contract test**

```js
test("the renderer owns a Settings extension iframe and preserves native geometry", () => {
  const component = read("src/components/settings/PluginSettingsDestination.tsx");
  assert.match(component, /<iframe/);
  assert.match(component, /sandbox="allow-scripts"/);
  assert.match(component, /event\.source !== frame\.contentWindow/);
  assert.match(component, /pluginSettingsBridgeInvoke/);
  assert.doesNotMatch(component, /pluginSettingsViewSetBounds/);
  assert.doesNotMatch(component, /pluginSettingsViewSetVisible/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: FAIL because the old component measures a native child view.

- [ ] **Step 3: Implement the renderer-owned surface**

```tsx
<iframe
  ref={frameRef}
  className="plugin-settings-destination"
  sandbox="allow-scripts"
  src={src}
  title={label}
/>
```

On a bridge request, verify the message source equals `frameRef.current?.contentWindow`, verify the envelope is a finite request id plus string channel and object payload, call the host API with the immutable component `pluginId` / `destinationId`, then return the matching response only to that iframe. Render the existing recovery state on a failed URL or bridge setup. The CSS must make the iframe transparent at the host level, fill its Settings content area, and leave scroll/drag/control ownership with the existing Settings shell.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/settings/PluginSettingsDestination.tsx apps/desktop/src/lib/api.ts apps/desktop/src/styles/settings.css apps/desktop/test/plugin-settings-renderer-surface.test.mjs
git commit -m "feat(settings): compose plugin destinations in renderer"
```

### Task 3: Remove Settings-native-view lifecycle plumbing and preserve bridge events

**Files:**
- Modify: `apps/desktop/electron/main/services/plugin-services.ts`
- Modify: `apps/desktop/electron/main/bootstrap/window.ts`
- Modify: `apps/desktop/electron/main/bootstrap/shutdown.ts`
- Modify: `apps/desktop/electron/main/bootstrap/app-lifecycle.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/main/ipc/plugin-ipc.ts`
- Test: `apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

**Interfaces:**
- Removes `pluginSettingsViews` as a dependency and lifecycle surface.
- Emits `pluginSettingsDestinationEvent` to the main renderer so the active iframe receives sanctioned appearance/workspace events.

- [ ] **Step 1: Extend the failing contract test**

```js
test("Settings extensions create no WebContentsView and clean up through renderer lifecycle", () => {
  const services = read("electron/main/services/plugin-services.ts");
  const lifecycle = read("electron/main/ipc/plugin-ipc.ts");
  assert.doesNotMatch(services, /pluginSettingsViews/);
  assert.doesNotMatch(lifecycle, /pluginSettingsViews/);
  assert.match(services, /pluginSettingsDestinationEvent/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: FAIL because the native Settings host is still wired into service and lifecycle dependencies.

- [ ] **Step 3: Implement the lifecycle simplification**

Remove `pluginSettingsViews` construction, sender resolving, browser-window attachment, shutdown disposal, and close calls. Keep plugin load state as the authoritative lifecycle check in the renderer URL/bridge endpoint. Add a whitelisted renderer event carrying `{ pluginId, event, payload }`; `PluginSettingsDestination` ignores every event not for its immutable plugin id and forwards the rest through source-checked postMessage.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/services/plugin-services.ts apps/desktop/electron/main/bootstrap/window.ts apps/desktop/electron/main/bootstrap/shutdown.ts apps/desktop/electron/main/bootstrap/app-lifecycle.ts apps/desktop/electron/main/index.ts apps/desktop/electron/main/ipc/plugin-ipc.ts apps/desktop/test/plugin-settings-renderer-surface.test.mjs
git commit -m "refactor(plugins): retire native settings views"
```

### Task 4: Synchronize the public extension contract and delivery documents

**Files:**
- Create: `docs/adr/0250-renderer-composited-plugin-settings-surfaces.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/spec/07-plugins/02-plugin-manifest-schema.md`
- Modify: `docs/spec/07-plugins/03-plugin-api.md`
- Modify: `docs/spec/07-plugins/04-plugin-security.md`
- Modify: `docs/spec/04-ux/06-settings-ia.md`
- Modify: `docs/spec/06-delivery/04-e2e-test-plan.md`
- Test: `apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

**Interfaces:**
- Documents `plugin-settings:` resource isolation, sandbox-only iframe, host message bridge, and Settings/native-control lifecycle.

- [ ] **Step 1: Extend the failing contract test**

```js
test("the public contract records the sandbox and one-canvas architecture", () => {
  assert.match(read("../../docs/adr/0250-renderer-composited-plugin-settings-surfaces.md"), /allow-scripts/);
  assert.match(read("../../docs/spec/07-plugins/04-plugin-security.md"), /plugin-settings/);
  assert.match(read("../../docs/spec/06-delivery/04-e2e-test-plan.md"), /renderer-composited Settings destination/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: FAIL because the ADR/spec scenarios do not yet exist.

- [ ] **Step 3: Write the ADR and update specifications**

Record that a Settings extension is renderer-composited while panels/work views remain native, enumerate the protocol’s asset and CSP policy, preserve the fixed bridge and permission boundary, and add manual E2E scenarios for scenic backdrops, core navigation, native title controls, reduced transparency, and plugin disable/uninstall.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/adr docs/spec apps/desktop/test/plugin-settings-renderer-surface.test.mjs
git commit -m "docs(plugins): specify renderer settings surfaces"
```

### Task 5: Validate, refresh, merge, and clean up

**Files:**
- No production changes expected.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node --test apps/desktop/test/plugin-settings-renderer-surface.test.mjs
node --test apps/desktop/test/plugin-appearance-extensions.test.mjs
node --test apps/desktop/test/plugin-themes.test.mjs
git diff --check
pnpm run build:js
pnpm --filter @pi-desktop/desktop exec tsc -p tsconfig.json --noEmit
```

Expected: all commands succeed. E2E is intentionally not run without explicit user authorization.

- [ ] **Step 2: Manually verify in the fork build**

Run `pnpm --filter @pi-desktop/desktop dev`, open Settings → Extensions → Nexus Scenic Themes, switch among the four cards, then navigate to General and back. Confirm the backdrop is recognisable through the page, there is no black rectangle, title controls work, and no panel covers the rail or resize edge.

- [ ] **Step 3: Review, refresh, and integrate**

```bash
git diff main...HEAD --check
git fetch
git rebase main
```

Resolve only conflicts in this request worktree. Then follow the repository’s local-main merge and cleanup procedure. Do not push unless the user explicitly asks.
