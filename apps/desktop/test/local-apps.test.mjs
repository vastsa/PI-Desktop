import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_APP_MAX_ICON_BYTES,
  createLocalAppCatalog,
  linuxApplicationDirectories,
  localAppId,
  macAppDirectories,
  parseDesktopEntry,
  windowsStartMenuDirs,
} from "../electron/main/local-apps.ts";
import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import {
  desktopExecutable,
  isLaunchableDesktopEntry,
  stripFieldCodes,
} from "../electron/main/local-app-parse.ts";

const START_MENU = "C:\\Start Menu\\Programs";
const CHROME_TARGET = "C:\\Program Files\\Google\\Chrome\\chrome.exe";

/**
 * Fully injected fake host. Every filesystem capability of `LocalAppDeps` is
 * backed by an in-memory table so no real system is touched.
 */
function createFakeHost(options = {}) {
  const state = {
    startMenuDirs: options.startMenuDirs ?? [START_MENU],
    appDirectories: options.appDirectories ?? [],
    /** shortcut path -> { target, args?, icon? } */
    shortcuts: new Map(Object.entries(options.shortcuts ?? {})),
    /** directory -> absolute child paths */
    children: new Map(Object.entries(options.children ?? {})),
    /** file -> text */
    texts: new Map(Object.entries(options.texts ?? {})),
    existing: new Set(options.existing ?? []),
    /** bundle path -> CFBundleExecutable */
    bundleExecutables: new Map(Object.entries(options.bundleExecutables ?? {})),
    /** icon target -> data URL or Error */
    icons: new Map(options.icons ?? []),
    failShortcutScan: options.failShortcutScan === true,
    shortcutScans: 0,
    fileListings: 0,
    iconRequests: 0,
    openings: [],
    openError: options.openError ?? "",
  };
  const deps = {
    platform: options.platform ?? "win32",
    startMenuDirs: state.startMenuDirs,
    appDirectories: state.appDirectories,
    async listShortcutTargets(directory) {
      state.shortcutScans += 1;
      if (state.failShortcutScan) throw new Error(`EACCES ${directory}`);
      return [...state.shortcuts.keys()];
    },
    async listFiles(directory) {
      state.fileListings += 1;
      const children = state.children.get(directory);
      if (!children) throw new Error(`ENOENT ${directory}`);
      return children;
    },
    async readText(file) {
      const text = state.texts.get(file);
      if (text === undefined) throw new Error(`ENOENT ${file}`);
      return text;
    },
    async pathExists(target) {
      return state.existing.has(target);
    },
    readShortcutLink(shortcutPath) {
      return state.shortcuts.get(shortcutPath) ?? null;
    },
    readBundleExecutable(bundlePath) {
      return state.bundleExecutables.get(bundlePath) ?? null;
    },
    async getFileIcon(target) {
      state.iconRequests += 1;
      const icon = state.icons.get(target);
      if (icon instanceof Error) throw icon;
      if (typeof icon !== "string") return null;
      return { toDataURL: () => icon };
    },
    async openPath(target) {
      state.openings.push(target);
      return state.openError;
    },
  };
  return { deps, state };
}

test("windows shortcuts report the shortcut name and the resolved target", async () => {
  const { deps, state } = createFakeHost({
    shortcuts: {
      [`${START_MENU}\\Google Chrome.lnk`]: { target: CHROME_TARGET, args: "" },
    },
    existing: [CHROME_TARGET],
  });
  const catalog = createLocalAppCatalog(deps);

  const apps = await catalog.list();

  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, "Google Chrome");
  assert.equal(apps[0].executableName, "chrome");
  assert.equal(apps[0].source, "start-menu");
  assert.equal(apps[0].launchTarget, CHROME_TARGET);
  assert.equal(apps[0].id, localAppId("chrome", CHROME_TARGET));
  assert.match(apps[0].id, /^app:chrome-[0-9a-f]{8}$/);

  await catalog.launch(apps[0].id);
  assert.deepEqual(state.openings, [CHROME_TARGET]);
});

test("windows shortcuts that are uninstallers, help files or readmes are skipped", async () => {
  const uninstaller = "C:\\Program Files\\Google\\Chrome\\Application\\unins000.exe";
  const readme = "C:\\Program Files\\Tool\\readme.html";
  const help = "C:\\Program Files\\Tool\\ToolHelp.chm";
  const chineseUninstaller = "C:\\Program Files\\Foo\\卸载.exe";
  const missing = "C:\\Program Files\\Gone\\gone.exe";
  const { deps } = createFakeHost({
    shortcuts: {
      [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET },
      [`${START_MENU}\\Uninstall Chrome.lnk`]: { target: uninstaller },
      [`${START_MENU}\\Read me.lnk`]: { target: readme },
      [`${START_MENU}\\Tool Help.lnk`]: { target: help },
      [`${START_MENU}\\卸载 Foo.lnk`]: { target: chineseUninstaller },
      [`${START_MENU}\\Gone.lnk`]: { target: missing },
    },
    existing: [CHROME_TARGET, uninstaller, readme, help, chineseUninstaller],
  });

  const apps = await createLocalAppCatalog(deps).list();

  assert.deepEqual(apps.map((app) => app.name), ["Chrome"]);
});

test("shortcut ids are stable and duplicate targets keep the shortest name", async () => {
  const { deps } = createFakeHost({
    shortcuts: {
      [`${START_MENU}\\Google Chrome.lnk`]: { target: CHROME_TARGET },
      [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET },
    },
    existing: [CHROME_TARGET],
  });

  const first = await createLocalAppCatalog(deps).list();
  const second = await createLocalAppCatalog(deps).list();

  assert.equal(first.length, 1);
  assert.equal(first[0].name, "Chrome");
  assert.equal(first[0].id, localAppId("chrome", CHROME_TARGET));
  assert.equal(second[0].id, first[0].id);
  // A different target for the same executable yields a different id.
  assert.notEqual(localAppId("chrome", "C:\\Other\\chrome.exe"), first[0].id);
});

test("macOS scans bundles one level below each root and uses CFBundleExecutable", async () => {
  const { deps } = createFakeHost({
    platform: "darwin",
    startMenuDirs: [],
    appDirectories: ["/Applications"],
    children: {
      "/Applications": [
        "/Applications/Safari.app",
        "/Applications/Utilities",
        "/Applications/Deep",
        "/Applications/notes.txt",
      ],
      "/Applications/Utilities": ["/Applications/Utilities/Terminal.app"],
      "/Applications/Deep": ["/Applications/Deep/Deeper"],
      "/Applications/Deep/Deeper": ["/Applications/Deep/Deeper/TooDeep.app"],
    },
    bundleExecutables: {
      "/Applications/Safari.app": "Safari",
      "/Applications/Utilities/Terminal.app": "Terminal",
    },
  });

  const apps = await createLocalAppCatalog(deps).list();

  assert.deepEqual(apps.map((app) => app.name), ["Safari", "Terminal"]);
  const safari = apps.find((app) => app.name === "Safari");
  assert.equal(safari.executableName, "Safari");
  assert.equal(safari.source, "app-bundle");
  assert.equal(safari.launchTarget, "/Applications/Safari.app");
  assert.equal(safari.id, localAppId("Safari", "/Applications/Safari.app"));
  const terminal = apps.find((app) => app.name === "Terminal");
  assert.equal(terminal.launchTarget, "/Applications/Utilities/Terminal.app");
  assert.equal(terminal.executableName, "Terminal");
});

test("parseDesktopEntry reads the Desktop Entry group and strips field codes", () => {
  const text = [
    "# a comment",
    "[Desktop Entry]",
    "Type=Application",
    "Name=Firefox",
    "Name[de]=Feuerfuchs",
    "Exec=/usr/lib/firefox/firefox --name %c %u %U %f %F %i %k",
    "NoDisplay=false",
    "Hidden=false",
    "",
    "[Desktop Action new-window]",
    "Name=New Window",
    "Exec=/usr/lib/firefox/firefox --new-window",
    "",
  ].join("\n");

  const entry = parseDesktopEntry(text);
  assert.ok(entry);
  assert.equal(entry.name, "Firefox");
  assert.equal(entry.type, "Application");
  assert.equal(entry.noDisplay, false);
  assert.equal(entry.hidden, false);
  assert.equal(stripFieldCodes(entry.exec), "/usr/lib/firefox/firefox --name");
  assert.equal(desktopExecutable(entry.exec), "/usr/lib/firefox/firefox");
  assert.equal(isLaunchableDesktopEntry(entry), true);
});

test("parseDesktopEntry resolves quoted and bare command executables", () => {
  assert.equal(desktopExecutable('"/opt/My App/app" %F'), "/opt/My App/app");
  assert.equal(desktopExecutable("firefox %u"), "firefox");
  assert.equal(desktopExecutable("   "), null);
  assert.equal(parseDesktopEntry("[Desktop Entry]\nName=No exec\n"), null);
});

test("NoDisplay, Hidden and non-Application desktop entries are filtered out", async () => {
  const appDir = "/usr/share/applications";
  const { deps } = createFakeHost({
    platform: "linux",
    startMenuDirs: [],
    appDirectories: [appDir],
    children: {
      [appDir]: [
        `${appDir}/firefox.desktop`,
        `${appDir}/hidden.desktop`,
        `${appDir}/nodisplay.desktop`,
        `${appDir}/service.desktop`,
        `${appDir}/code.desktop`,
        `${appDir}/readme.txt`,
      ],
    },
    texts: {
      [`${appDir}/firefox.desktop`]:
        "[Desktop Entry]\nType=Application\nName=Firefox\nExec=/usr/lib/firefox/firefox %u\n",
      [`${appDir}/hidden.desktop`]:
        "[Desktop Entry]\nType=Application\nName=Hidden App\nHidden=true\nExec=/usr/bin/hidden %U\n",
      [`${appDir}/nodisplay.desktop`]:
        "[Desktop Entry]\nType=Application\nName=No Display\nNoDisplay=true\nExec=/usr/bin/nodisplay\n",
      [`${appDir}/service.desktop`]:
        "[Desktop Entry]\nType=Service\nName=Service\nExec=/usr/bin/service\n",
      [`${appDir}/code.desktop`]:
        "[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=code --unity-launch %F\n",
    },
    existing: ["/usr/lib/firefox/firefox"],
  });

  const apps = await createLocalAppCatalog(deps).list();

  assert.deepEqual(apps.map((app) => app.name), ["Firefox", "Visual Studio Code"]);
  assert.equal(apps[0].source, "desktop-entry");
  assert.equal(apps[0].launchTarget, "/usr/lib/firefox/firefox");
  assert.equal(apps[0].id, localAppId("firefox", "/usr/lib/firefox/firefox"));
  // A bare command name has no filesystem path to validate, so it is kept and
  // its id is seeded from the desktop file itself.
  assert.equal(apps[1].executableName, "code");
  assert.equal(apps[1].launchTarget, "code");
  assert.equal(apps[1].id, localAppId("code", `${appDir}/code.desktop`));
});

test("list() is cached for the TTL and refresh() forces a rescan", async () => {
  let clock = 1_000;
  const { deps, state } = createFakeHost({
    shortcuts: { [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
  });
  const catalog = createLocalAppCatalog(deps, {
    ttlMs: 1_000,
    now: () => clock,
  });

  assert.equal(catalog.isScanning(), false);
  await catalog.list();
  assert.equal(state.shortcutScans, 1);

  await catalog.list();
  await catalog.list();
  assert.equal(state.shortcutScans, 1);

  clock += 999;
  await catalog.list();
  assert.equal(state.shortcutScans, 1);

  clock += 1;
  await catalog.list();
  assert.equal(state.shortcutScans, 2);

  await catalog.refresh();
  assert.equal(state.shortcutScans, 3);
  assert.equal(catalog.isScanning(), false);
});

test("concurrent list() calls share a single in-flight scan", async () => {
  const { deps, state } = createFakeHost({
    shortcuts: { [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
  });
  const catalog = createLocalAppCatalog(deps);
  const first = catalog.list();
  const second = catalog.list();

  assert.equal(catalog.isScanning(), true);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(state.shortcutScans, 1);
  assert.deepEqual(left.map((app) => app.id), right.map((app) => app.id));
});

test("launch() rejects unknown ids and never accepts a caller-supplied path", async () => {
  const { deps, state } = createFakeHost({
    shortcuts: { [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
  });
  const catalog = createLocalAppCatalog(deps);
  await catalog.list();

  await assert.rejects(catalog.launch("app:chrome-00000000"), /Unknown application id/);
  await assert.rejects(catalog.launch(CHROME_TARGET), /Unknown application id/);
  assert.deepEqual(state.openings, []);
});

test("launch() of a removed target drops the entry and reports it is gone", async () => {
  const { deps, state } = createFakeHost({
    shortcuts: { [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
  });
  const catalog = createLocalAppCatalog(deps);
  const [chrome] = await catalog.list();

  state.existing.delete(CHROME_TARGET);
  await assert.rejects(catalog.launch(chrome.id), /no longer installed/);
  assert.deepEqual(state.openings, []);

  const remaining = await catalog.list();
  assert.deepEqual(remaining, []);
});

test("launch() surfaces an error string returned by openPath", async () => {
  const { deps } = createFakeHost({
    shortcuts: { [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
    openError: "Failed to open path",
  });
  const catalog = createLocalAppCatalog(deps);
  const [chrome] = await catalog.list();

  await assert.rejects(catalog.launch(chrome.id), /Failed to launch "Chrome"/);
});

test("icon failures and oversized icons never fail the scan", async () => {
  const second = "C:\\Program Files\\Tool\\tool.exe";
  const third = "C:\\Program Files\\Huge\\huge.exe";
  const { deps, state } = createFakeHost({
    shortcuts: {
      [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET },
      [`${START_MENU}\\Tool.lnk`]: { target: second },
      [`${START_MENU}\\Huge.lnk`]: { target: third },
    },
    existing: [CHROME_TARGET, second, third],
    icons: [
      [CHROME_TARGET, new Error("icon extraction failed")],
      [second, "data:image/png;base64,AAAA"],
      [third, `data:image/png;base64,${"A".repeat(LOCAL_APP_MAX_ICON_BYTES + 1)}`],
    ],
  });

  const apps = await createLocalAppCatalog(deps).list();

  assert.equal(apps.length, 3);
  assert.equal(apps.find((app) => app.name === "Chrome").iconDataUrl, undefined);
  assert.equal(apps.find((app) => app.name === "Tool").iconDataUrl, "data:image/png;base64,AAAA");
  assert.equal(apps.find((app) => app.name === "Huge").iconDataUrl, undefined);
  assert.equal(state.iconRequests, 3);
});

test("the icon budget is 32 KiB so a large native icon still fits", () => {
  assert.equal(LOCAL_APP_MAX_ICON_BYTES, 32_768);
  // The small variant reads as a blurry square on the launcher's tiles.
  assert.match(
    readMainModuleSync("local-apps.ts"),
    /app\.getFileIcon\(target, \{ size: "large" \}\)/,
  );
});

test("a rescan reuses the icon it already fetched", async () => {
  const { deps, state } = createFakeHost({
    shortcuts: { [`${START_MENU}\\Chrome.lnk`]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
    icons: [[CHROME_TARGET, "data:image/png;base64,AAAA"]],
  });
  const catalog = createLocalAppCatalog(deps);

  const first = await catalog.list();
  assert.equal(state.iconRequests, 1);
  assert.equal(first[0].iconDataUrl, "data:image/png;base64,AAAA");

  const rescanned = await catalog.refresh();

  assert.equal(state.iconRequests, 1);
  assert.equal(rescanned[0].iconDataUrl, "data:image/png;base64,AAAA");
});

test("an icon is dropped from the cache when its application disappears", async () => {
  const shortcut = `${START_MENU}\\Chrome.lnk`;
  const { deps, state } = createFakeHost({
    shortcuts: { [shortcut]: { target: CHROME_TARGET } },
    existing: [CHROME_TARGET],
    icons: [[CHROME_TARGET, "data:image/png;base64,AAAA"]],
  });
  const catalog = createLocalAppCatalog(deps);

  await catalog.list();
  assert.equal(state.iconRequests, 1);

  state.shortcuts.delete(shortcut);
  assert.deepEqual(await catalog.refresh(), []);

  // Reinstalling must not be served the stale image of the previous install.
  state.shortcuts.set(shortcut, { target: CHROME_TARGET });
  await catalog.refresh();
  assert.equal(state.iconRequests, 2);
});
test("icons are requested for at most 200 entries", async () => {
  const shortcuts = {};
  const existing = [];
  for (let index = 0; index < 205; index += 1) {
    const target = `C:\\Apps\\app${index}.exe`;
    shortcuts[`${START_MENU}\\App ${index}.lnk`] = { target };
    existing.push(target);
  }
  const { deps, state } = createFakeHost({ shortcuts, existing });

  const apps = await createLocalAppCatalog(deps).list();

  assert.equal(apps.length, 205);
  assert.equal(state.iconRequests, 200);
});

test("entries are sorted by name and capped at 600", async () => {
  const shortcuts = {};
  const existing = [];
  for (let index = 620; index >= 1; index -= 1) {
    const label = `App ${String(index).padStart(4, "0")}`;
    const target = `C:\\Apps\\app${String(index).padStart(4, "0")}.exe`;
    shortcuts[`${START_MENU}\\${label}.lnk`] = { target };
    existing.push(target);
  }
  const { deps, state } = createFakeHost({ shortcuts, existing });

  const apps = await createLocalAppCatalog(deps, { maxIcons: 0 }).list();

  assert.equal(apps.length, 600);
  assert.equal(apps[0].name, "App 0001");
  assert.equal(apps[599].name, "App 0600");
  assert.equal(state.iconRequests, 0);
});

test("an unreadable location is reported as a diagnostic instead of throwing", async () => {
  const { deps } = createFakeHost({ failShortcutScan: true });
  const catalog = createLocalAppCatalog(deps);

  const apps = await catalog.list();

  assert.deepEqual(apps, []);
  assert.match(catalog.diagnostics()[0], /start menu scan failed/);
});

test("an unsupported platform yields no entries and a diagnostic", async () => {
  const { deps } = createFakeHost({ platform: "freebsd", startMenuDirs: [], appDirectories: [] });
  const catalog = createLocalAppCatalog(deps);

  assert.deepEqual(await catalog.list(), []);
  assert.match(catalog.diagnostics()[0], /unsupported platform/);
});

test("platform directories are built from the injected environment", () => {
  const dirs = windowsStartMenuDirs({
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
  });
  assert.equal(dirs.length, 3);
  assert.ok(dirs[0].endsWith("Microsoft\\Windows/Start Menu/Programs"));
  assert.deepEqual(windowsStartMenuDirs({}), []);

  assert.deepEqual(macAppDirectories("/Users/me"), [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/Users/me/Applications",
  ]);
  assert.deepEqual(linuxApplicationDirectories("/home/me"), [
    "/usr/share/applications",
    "/usr/local/share/applications",
    "/home/me/.local/share/applications",
  ]);
});
