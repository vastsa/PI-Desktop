import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  modelsSource,
  serviceListSource,
  pluginsHookSource,
  installedSource,
  marketplaceSource,
  detailSource,
  dialogsSource,
] = await Promise.all([
  read("../src/components/settings/ModelConfigPage.tsx"),
  read("../src/components/settings/ServiceList.tsx"),
  read("../src/features/plugins/usePluginsPage.ts"),
  read("../src/features/plugins/InstalledPluginsPanel.tsx"),
  read("../src/features/plugins/MarketplacePanel.tsx"),
  read("../src/features/plugins/PluginDetailSheet.tsx"),
  read("../src/features/plugins/PluginDialogs.tsx"),
]);

test("model config rows keep independent busy guards", () => {
  assert.match(modelsSource, /import \{ useRowBusy \} from "\.\.\/\.\.\/hooks\/use-row-busy"/);
  assert.match(modelsSource, /const rowBusy = useRowBusy\(\)/);
  // Every row-keyed operation claims its own row before the first await and
  // releases it in a finally, so a settle elsewhere cannot re-arm it.
  for (const name of ["toggleEnabled", "removeProvider", "saveProviderKey", "testProvider"]) {
    const start = modelsSource.indexOf(`const ${name} = async`);
    assert.ok(start >= 0, `${name} missing`);
    const body = modelsSource.slice(start, start + 1600);
    assert.match(body, /if \(!rowBusy\.begin\(provider\.id\)\) return/, `${name} must claim its row`);
    assert.match(body, /rowBusy\.end\(provider\.id\)/, `${name} must release its row`);
  }
  // A busy row does not lock the page: the list-wide gate keeps only the
  // modal-dialog terms, and row business lives in isRowBusy.
  assert.doesNotMatch(modelsSource, /busyId/);
  assert.doesNotMatch(modelsSource, /busy=\{\s*busyId/);
  assert.match(modelsSource, /isRowBusy=\{\(id\) => rowBusy\.isBusy\(id\) \|\| busyAccountId === id\}/);
});

test("provider test spinners remain independent while requests overlap", () => {
  assert.match(modelsSource, /const testingRows = useRowBusy\(\)/);
  const start = modelsSource.indexOf("const testProvider = async");
  assert.ok(start >= 0, "testProvider missing");
  const body = modelsSource.slice(start, start + 1800);
  assert.match(body, /testingRows\.begin\(provider\.id\)/);
  assert.match(body, /testingRows\.end\(provider\.id\)/);
  assert.match(modelsSource, /isTesting=\{testingRows\.isBusy\}/);
  assert.match(serviceListSource, /isTesting: \(providerId: string\) => boolean/);
  assert.match(serviceListSource, /testing=\{isTesting\(provider\.id\)\}/);
  assert.doesNotMatch(modelsSource, /testingId|setTestingId/);
});

test("plugins page rows keep independent busy guards", () => {
  assert.match(pluginsHookSource, /import \{ useRowBusy \} from "\.\.\/\.\.\/hooks\/use-row-busy"/);
  assert.match(pluginsHookSource, /const rowBusy = useRowBusy\(\)/);
  assert.doesNotMatch(pluginsHookSource, /setBusyId/);
  for (const [name, key] of [
    ["confirmReview", "review.id"],
    ["runInstall", "request.id"],
    ["reloadPlugin", "id"],
  ]) {
    const start = pluginsHookSource.indexOf(`const ${name}`);
    assert.ok(start >= 0, `${name} missing`);
    const body = pluginsHookSource.slice(start, start + 2200);
    assert.match(body, new RegExp(`rowBusy\\.begin\\(${key.replace(".", "\\.")}\\)`), `${name} must claim its row`);
    assert.match(body, new RegExp(`rowBusy\\.end\\(${key.replace(".", "\\.")}\\)`), `${name} must release its row`);
  }
  // The page model exposes the per-row predicate; the single busyId slot is gone.
  assert.match(pluginsHookSource, /isPluginBusy: rowBusy\.isBusy,/);
  assert.doesNotMatch(pluginsHookSource, /\bbusyId\b/);
});

test("plugin surfaces consume the per-row busy predicate", () => {
  for (const [label, source, key] of [
    ["installed", installedSource, "plugin.id"],
    ["marketplace", marketplaceSource, "item.id"],
    ["detail", detailSource, "detail.id"],
  ]) {
    assert.doesNotMatch(source, /\bbusyId\b/, `${label} must not read the removed slot`);
    assert.match(source, new RegExp(`isPluginBusy\\(${key.replace(".", "\\.")}\\)`), `${label} must read the predicate`);
  }
  assert.match(dialogsSource, /isPluginBusy\(pendingReview\.id\)/);
  assert.match(dialogsSource, /isPluginBusy\(pendingInstall\.id\)/);
  assert.doesNotMatch(dialogsSource, /\bbusyId\b/);
});
