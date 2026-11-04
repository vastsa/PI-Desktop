/**
 * The Tools page (D681): a sidebar destination under 产物文件/Artifacts that
 * lists the tool packages this build ships, with one enable switch each.
 *
 * Source contracts only. The scan and the enabled set live in host-core
 * (`crates/host-core/src/tool_packages.rs`, covered by Rust tests) and the IPC
 * boundary is pinned by `tool-packages-ipc.test.mjs`; this file pins the
 * renderer wiring and the nine locale catalogs.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const appState = read("../src/stores/app-state.ts");
const sidebar = read("../src/components/Sidebar.tsx");
const searchDialog = read("../src/components/SearchDialog.tsx");
const appShell = read("../src/features/app/AppShell.tsx");
const runtimeSource = read("../src/features/app/useAppShellRuntime.tsx");
const api = read("../src/lib/api.ts");
const protocol = read("../../../packages/shared/src/protocol.ts");
const page = read("../src/pages/ToolsPage.tsx");
const hostProcess = read("../electron/main/host-process.ts");
const register = read("../electron/main/ipc/register.ts");
const rustToolPackages = read("../../../crates/host-core/src/tool_packages.rs");
const rustRpc = read("../../../crates/host-core/src/rpc/mod.rs");
const packageJson = JSON.parse(read("../package.json"));

const LOCALES = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];

test("tools is an app-shell page next to artifacts", () => {
  assert.match(appState, /page: "chat" \| "scheduled" \| "plugins" \| "artifacts" \| "tools" \| "settings"/);
  assert.match(appShell, /pages\/ToolsPage/);
  assert.match(appShell, /page === "tools" \? \([\s\S]{0,90}<ToolsPage \/>/);
  // A full page has to hide the work panel and refuse to open it, or the route
  // renders like a chat surface with the composer still attached.
  assert.match(runtimeSource, /page === "artifacts" \|\|\s*page === "tools"/);
  assert.match(runtimeSource, /p !== "artifacts" &&\s*p !== "tools"/);
});

test("the rail row sits directly below the artifacts row", () => {
  const artifactsAt = sidebar.indexOf('data-nav="artifacts"');
  const toolsAt = sidebar.indexOf('data-nav="tools"');
  assert.ok(artifactsAt > 0 && toolsAt > artifactsAt, "tools row follows artifacts");
  const between = sidebar.slice(artifactsAt + 'data-nav="artifacts"'.length, toolsAt);
  assert.doesNotMatch(between, /data-nav=/, "nothing else sits between the two rows");
  const row = sidebar.slice(sidebar.lastIndexOf("<button", toolsAt), sidebar.indexOf("</button>", toolsAt));
  assert.match(row, /IconWrench/);
  assert.match(row, /t\("tools\.title"\)/);
  assert.match(row, /page === "tools" \? " is-active" : ""/);
});

test("global search offers the page", () => {
  assert.match(searchDialog, /page: "tools", labelKey: "tools\.title", icon: IconWrench/);
});

test("the renderer reaches the packages only through the host", () => {
  assert.match(api, /listToolPackages: \(\) =>[\s\S]{0,120}IPC\.invoke\.toolPackagesList/);
  assert.match(
    api,
    /setToolPackageEnabled: \(id: string, enabled: boolean\) =>[\s\S]{0,160}IPC\.invoke\.toolPackagesSetEnabled/,
  );
  assert.match(protocol, /toolPackagesList: "pi-desktop\/toolPackages\/list"/);
  assert.match(protocol, /toolPackagesSetEnabled: "pi-desktop\/toolPackages\/setEnabled"/);
  assert.match(hostProcess, /PI_DESKTOP_BUILTIN_TOOLS_DIR/);
  assert.match(hostProcess, /function resolveBuiltinToolsDir\(\)[\s\S]{0,200}resources\/tools/);
  assert.match(register, /registerToolPackagesIpc\(\{ registrar, getHost \}\)/);
  assert.ok(existsSync(new URL("../electron/main/ipc/tool-packages-ipc.ts", import.meta.url)));
});

test("the page shows packages, their tools and one switch each", () => {
  assert.match(page, /api\.listToolPackages\(\)/);
  assert.match(page, /api\.setToolPackageEnabled\(id, enabled\)/);
  assert.match(page, /<SettingsToggle/);
  assert.match(page, /<Badge tone=\{tone\}/);
  assert.match(page, /t\("tools\.count", \{ count: packages\.length \}\)/);
  assert.match(page, /t\("tools\.broken", \{ message: pkg\.error \}\)/);
  assert.match(page, /pkg\.enabled \? "" : " is-disabled"/);
  // A package that cannot be read still renders its row instead of vanishing.
  assert.match(page, /pkg\.error \? \(/);
});

test("the host owns the scan and the enabled set", () => {
  assert.match(rustToolPackages, /pub fn builtin_tools_dir\(\)/);
  assert.match(rustToolPackages, /pub fn list\(builtin: Option<&Path>, data_dir: &Path\)/);
  assert.match(rustToolPackages, /pub fn set_enabled\(data_dir: &Path, id: &str, enabled: bool\)/);
  assert.match(rustToolPackages, /const STATE_FILE: &str = "tools\/state\.json";/);
  assert.match(rustRpc, /"toolPackages\.list" =>/);
  assert.match(rustRpc, /"toolPackages\.setEnabled" =>/);
});

test("the packaged image ships resources/tools", () => {
  const entry = packageJson.build.extraResources.find((item) => item.to === "tools");
  assert.ok(entry, "extraResources carries the tools directory");
  assert.equal(entry.from, "resources/tools");
  assert.ok(existsSync(new URL("../resources/tools/README.md", import.meta.url)));
});

test("every locale speaks the tools page", () => {
  for (const locale of LOCALES) {
    const catalog = read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    const key = locale === "de" || locale === "es" || locale === "fr" ? '"tools"' : "tools";
    assert.ok(catalog.includes(`${key}: {`), `${locale} defines the tools block`);
    for (const entry of ["title", "loadFailed", "empty", "broken", "risk"]) {
      const entryKey = locale === "de" || locale === "es" || locale === "fr" ? `"${entry}"` : entry;
      assert.ok(catalog.includes(`${entryKey}:`), `${locale} defines tools.${entry}`);
    }
  }
});
