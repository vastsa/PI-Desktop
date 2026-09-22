import {
  readMainModuleSync,
  readMainSourceSync,
  readPluginsSourceSync,
  readSharedTypesSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");

const mainSrc = readMainSourceSync();
const pluginIpcSrc = readMainModuleSync("ipc/plugin-ipc.ts");
const runtimeSrc = readFileSync(
  join(desktopRoot, "electron/main/plugin-runtime.ts"),
  "utf8",
);
const pluginsUiSrc = readPluginsSourceSync();
const sharedTypesSrc = readSharedTypesSourceSync();
const protocolSrc = readFileSync(
  join(repoRoot, "packages/shared/src/protocol.ts"),
  "utf8",
);

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} missing`);
  const end = to === undefined ? source.length : source.indexOf(to, start);
  assert.ok(end > start, `${to} missing after ${from}`);
  return source.slice(start, end);
}

test("choosing a dev plugin folder reports a review instead of loading it", () => {
  const pick = slice(
    mainSrc,
    "handle(IPC.invoke.pluginLoadDev,",
    "IPC.invoke.pluginLoadDevConfirm",
  );
  assert.match(pick, /return \{ canceled: false, review: reviewFor\(result\.filePaths\[0\], "load"\) \}/);
  // The folder picker must not load: the answer is what loads it.
  assert.doesNotMatch(pick, /loadFromPath/);
  assert.doesNotMatch(pick, /plugins\.watchDevPlugin/);
  // Nor may it register the plugin before the user has seen the declaration.
  assert.doesNotMatch(pick, /plugins\.loadDev"/);

  const confirm = slice(
    mainSrc,
    "IPC.invoke.pluginLoadDevConfirm",
    "handle(IPC.invoke.pluginReload,",
  );
  assert.match(confirm, /const loaded = await loadDevPlugin\(path, granted, "loadDev"\)/);
  assert.match(confirm, /grantedPermissions/);
});

test("the template scaffold writes files and then asks the same question", () => {
  const create = slice(mainSrc, "IPC.invoke.pluginCreateFromTemplate", "\n  handle(IPC.invoke.pluginInstallFromPath,");
  assert.match(create, /const created = await scaffold\(\{ dir, template \}\)/);
  assert.match(create, /review: reviewFor\(dir, "load"\)/);
  assert.doesNotMatch(create, /loadFromPath/);
  assert.doesNotMatch(create, /watchDevPlugin/);
});

test("an approved load registers the folder with exactly what was accepted", () => {
  const loader = slice(pluginIpcSrc, "const loadDevPlugin = async (", "/** A development plugin folder as a review");
  // Registry row first (it rewrites the declaration), then the load, then the
  // watch whose ceiling is the approval.
  assert.match(loader, /host\.call<\{ plugin: any \}>\("plugins\.loadDev", \{ path \}\)/);
  assert.match(loader, /await plugins\.loadFromPath\(path, grantedPermissions, \{ development: true \}\)/);
  assert.match(loader, /if \(loaded\.plugin\?\.id\) plugins\.watchDevPlugin\(loaded\.plugin\.id\)/);
  assert.ok(
    loader.indexOf("plugins.loadDev\"") < loader.indexOf("loadFromPath"),
    "the registry row is rewritten before the load",
  );
  assert.ok(
    loader.indexOf("loadFromPath") < loader.indexOf("watchDevPlugin"),
    "the approval is recorded only after the plugin loaded under it",
  );
});

test("a widening reload is answered in the renderer, never applied on its own", () => {
  const reload = slice(
    mainSrc,
    "handle(IPC.invoke.pluginReload,",
    "handle(\n    IPC.invoke.pluginReloadConfirm",
  );
  // The review names the file scope as well as permission names: a new glob is
  // asking for more, exactly like a new permission.
  assert.match(reload, /const \{ added, widened \} = beyondApproval\(id, plugin\.path\)/);
  assert.match(reload, /if \(added\.length \|\| widened\.length\) \{/);
  assert.match(reload, /review: reviewFor\(plugin\.path, "reload", \[\.\.\.added, \.\.\.widened\]\)/);
  assert.ok(
    reload.indexOf("beyondApproval(") < reload.indexOf("loadFromPath("),
    "the approval check precedes the load",
  );
  // A plugin already running under the current approval reloads straight away:
  // the common loop (edit, save, reload) must not become a dialog.
  assert.ok(
    reload.indexOf("return {\n          plugin,") < reload.indexOf("loadFromPath("),
    "the review returns before the direct load path",
  );

  const confirm = slice(
    mainSrc,
    "IPC.invoke.pluginReloadConfirm",
    "// Scaffold a starter plugin",
  );
  // The path comes from the host's own registry, never from the renderer.
  assert.match(confirm, /const listed = await host\.call<\{ plugins: any\[\] \}>\("plugins\.list"\)/);
  assert.doesNotMatch(confirm, /input\?\.path/);
  assert.match(confirm, /const loaded = await loadDevPlugin\(plugin\.path, granted, "reload"\)/);
});

test("the approval record is what a reload is measured against", () => {
  const approval = slice(runtimeSrc, "devApproval(pluginId: string)", "\n  /** Stop every watch");
  assert.match(approval, /const dev = this\.devPlugins\.get\(pluginId\)/);
  assert.match(approval, /return dev \? \{ permissions: \[\.\.\.dev\.permissions\], fs: dev\.fs \} : null/);

  const beyond = slice(pluginIpcSrc, "const beyondApproval = (", "handle(IPC.invoke.pluginLoadDev,");
  // No record means this session never reviewed it: the load itself is the
  // review, so everything counts as new.
  assert.match(beyond, /if \(!approval\) \{/);
  assert.match(beyond, /return \{ declared, added: declared\.permissions, widened: \[\] as string\[\] \}/);
  assert.match(beyond, /widened: widenedFsScope\(approval\.fs, declared\.fs\)/);
  assert.match(runtimeSrc, /export function widenedFsScope\(ceiling: PluginFsPolicy, next: PluginFsPolicy\): string\[\]/);

  // The declaration is read from disk and validated, so a broken manifest is
  // refused before a review can offer it.
  const declaration = slice(runtimeSrc, "export function readDevPluginDeclaration", "\n}\n");
  assert.match(declaration, /PLUGIN_INVALID: manifest\.json missing/);
  assert.match(declaration, /const validated = validateManifest\(raw\)/);
  assert.match(declaration, /if \(!validated\.ok \|\| !validated\.manifest\)/);
});

test("the refusal names an action that exists", () => {
  const reload = slice(runtimeSrc, "async reloadDevPlugin(", "\n  async invokePanelBridge");
  assert.match(reload, /PERMISSION_DENIED: manifest now requests/);
  // The old text pointed at a folder picker that reviewed nothing.
  assert.doesNotMatch(reload, /load the plugin again to review/);
  assert.match(reload, /reload it from the Plugins page to review/);
  // The hard refusal itself is unchanged: hot reload still cannot widen.
  assert.ok(
    reload.indexOf("PERMISSION_DENIED") < reload.indexOf("this.loadFromPath"),
    "the permission check must precede the load",
  );
});

test("the renderer holds the declaration until the user answers", () => {
  assert.match(pluginsUiSrc, /const \[pendingReview, setPendingReview\] = useState<PluginPermissionReview \| null>\(null\)/);
  const loadDev = slice(pluginsUiSrc, "const loadDev = () =>", "// A pi CLI extension becomes a development plugin");
  assert.match(loadDev, /const result = await api\.loadDevPlugin\(\)/);
  assert.match(loadDev, /if \(result\.canceled \|\| !result\.review\) return/);
  assert.match(loadDev, /setPendingReview\(result\.review\)/);
  assert.doesNotMatch(loadDev, /loadDevDone/);

  const reload = slice(pluginsUiSrc, "const reloadPlugin = (id: string) =>", "const installPackage = () =>");
  assert.match(reload, /if \(result\.review\) \{/);
  assert.match(reload, /setPendingReview\(result\.review\)/);

  const confirm = slice(pluginsUiSrc, "const confirmReview = async () =>", "const overflowActions = [");
  assert.match(confirm, /await api\.confirmReloadPlugin\(\{/);
  assert.match(confirm, /await api\.confirmLoadDevPlugin\(\{/);
  assert.match(confirm, /grantedPermissions: review\.permissions/);

  // One permission list for both reviews: the risk tiers and labels live in a
  // single component, so the two flows cannot disagree about what is risky.
  assert.match(pluginsUiSrc, /function PermissionGroups\(/);
  const dialogs = slice(pluginsUiSrc, "export function PluginDialogs(", "\n/* ");
  assert.equal(
    dialogs.match(/<PermissionGroups/g)?.length,
    2,
    "both the install review and the development review render the shared list",
  );
  assert.match(dialogs, /plugins\.devReviewTitle/);
  assert.match(dialogs, /plugins\.devReviewNewTitle/);
  assert.match(dialogs, /t\("plugins\.devReviewAccept"\)/);
});

test("the review contract is shared, not re-declared on each side", () => {
  assert.match(sharedTypesSrc, /export type PluginPermissionReview = \{/);
  assert.match(sharedTypesSrc, /kind: "load" \| "reload"/);
  assert.match(protocolSrc, /pluginLoadDevConfirm: "pi-desktop\/plugin\/loadDevConfirm"/);
  assert.match(protocolSrc, /pluginReloadConfirm: "pi-desktop\/plugin\/reloadConfirm"/);
});

// ADR 0305 decision 7: the request grant reaches the whole provider API surface
// with the user's credential, so a manifest may declare it and both copies of
// the risk list have to classify it high before the review asks the user.
test("the request grant validates and is reviewed as high risk", () => {
  const sdkSrc = readFileSync(join(repoRoot, "packages/plugin-sdk/src/index.ts"), "utf8");
  const devkitSrc = readFileSync(join(repoRoot, "packages/plugin-devkit/src/check.ts"), "utf8");

  assert.match(sdkSrc, /"provider\.request",/);
  assert.match(pluginsUiSrc, /"provider\.request": "high"/);
  assert.match(devkitSrc, /HIGH_RISK_PERMISSIONS = \[[\s\S]*?"provider\.request",/);
  assert.match(devkitSrc, /"provider\.request": \["providers\.request"\]/);
});
