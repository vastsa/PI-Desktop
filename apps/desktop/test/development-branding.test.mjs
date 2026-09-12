import { readMainSource, readMainModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const devScriptUrl = new URL(
  "../../../scripts/dev-electron.mjs",
  import.meta.url,
);

const mainSource = await readMainSource();
const mainIndexSource = await readMainModule("index.ts");
const brandingSource = await readMainModule("bootstrap/app-lifecycle.ts");
const startupSource = await readMainModule("bootstrap/startup.ts");
const iconScriptSource = await readFile(
  new URL("../../../scripts/make-icon.py", import.meta.url),
  "utf8",
);
const devScriptSource = await readFile(
  devScriptUrl,
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);

test("Windows runtime registers the canonical native application identity", () => {
  const appId = protocolSource.match(/APP_ID = "([^"]+)"/)?.[1];
  assert.equal(appId, packageJson.build.appId);
  assert.ok(startupSource.includes("app.whenReady()"), "main process readiness hook");
  assert.match(mainIndexSource, /app\.setName\(APP_NAME\)/);
  assert.match(
    mainIndexSource,
    /process\.platform === "win32"[\s\S]*app\.setAppUserModelId\(APP_ID\)/,
  );
});

test("Windows packages pin PI-Desktop executable and shortcut names", () => {
  assert.equal(packageJson.build.win.executableName, "PI-Desktop");
  assert.equal(packageJson.build.nsis.shortcutName, "PI-Desktop");
});

test("Linux packages align the desktop entry with the Wayland app identity", () => {
  assert.equal(packageJson.desktopName, "pi-desktop.desktop");
  assert.equal(packageJson.build.linux.syncDesktopName, true);
});

test("macOS development uses the canonical PI-Desktop Dock icon", () => {
  assert.match(
    brandingSource,
    /process\.platform !== "darwin" \|\| !isDevelopmentBuild \|\| !app\.dock/,
  );
  assert.match(
    brandingSource,
    /join\(app\.getAppPath\(\), "build", "icon_1024\.png"\)/,
  );
  assert.match(brandingSource, /nativeImage\.createFromPath\(iconPath\)/);
  assert.match(brandingSource, /if \(icon\.isEmpty\(\)\)/);
  assert.match(brandingSource, /app\.dock\.setIcon\(icon\)/);
  // Branding is the first thing readiness does, after the only statement that
  // may precede it: the bail for a launch that lost the single-instance lock
  // and must not touch the running app's Dock tile.
  assert.match(
    startupSource,
    /if \(!hasSingleInstanceLock\) return;\s+applyDevelopmentBranding\(\);/,
  );
});

test("macOS icon derivation preserves the canonical renderer asset", () => {
  assert.match(iconScriptSource, /SOURCE = BUILD \/ "icon_1024\.png"/);
  assert.match(iconScriptSource, /with Image\.open\(SOURCE\) as source/);
  assert.doesNotMatch(
    iconScriptSource,
    /\.save\(BUILD \/ "icon_1024\.png"\)/,
  );
});

test("macOS development launches from a branded host bundle", () => {
  assert.equal(packageJson.scripts.dev, "node ../../scripts/dev-electron.mjs");
  assert.match(devScriptSource, /process\.platform === "darwin"/);
  assert.match(devScriptSource, /PI_DESKTOP_DEV: "1"/);
  assert.match(devScriptSource, /ELECTRON_EXEC_PATH/);
  assert.match(devScriptSource, /CFBundleDisplayName", APP_NAME/);
  assert.match(devScriptSource, /CFBundleName", APP_NAME/);
  assert.match(devScriptSource, /CFBundleExecutable", APP_NAME/);
  assert.match(devScriptSource, /CFBundleIconFile", "icon\.icns"/);
  assert.match(
    devScriptSource,
    /copyFileSync\(iconPath, join\(resources, "icon\.icns"\)\)/,
  );
  assert.match(devScriptSource, /verbatimSymlinks: true/);
  assert.match(devScriptSource, /join\(ROOT, "\.cache", "electron-dev"\)/);
  assert.doesNotMatch(devScriptSource, /node_modules.*Info\.plist/);
});

test(
  "development launcher can be imported without starting Electron",
  async () => {
    const launcher = await import(devScriptUrl.href);
    assert.equal(typeof launcher.prepareMacDevelopmentBundle, "function");
  },
);

test(
  "macOS development bundle rewrites native identity and reuses its cache",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-dev-bundle-"));
    const sourceBundle = join(root, "Electron.app");
    const contents = join(sourceBundle, "Contents");
    const macos = join(contents, "MacOS");
    const resources = join(contents, "Resources");
    const executable = join(macos, "Electron");
    const iconPath = join(root, "source.icns");
    const cacheRoot = join(root, "cache");

    try {
      await mkdir(macos, { recursive: true });
      await mkdir(resources, { recursive: true });
      await writeFile(executable, "electron-host");
      await writeFile(iconPath, "canonical-icon");
      await writeFile(
        join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
</dict></plist>`,
      );

      const { prepareMacDevelopmentBundle } = await import(devScriptUrl.href);
      const options = {
        electronExecutable: executable,
        electronVersion: "test-version",
        iconPath,
        cacheRoot,
        sign: false,
      };
      const brandedExecutable = prepareMacDevelopmentBundle(options);
      const brandedContents = join(
        brandedExecutable,
        "..",
        "..",
      );
      const plist = await readFile(join(brandedContents, "Info.plist"), "utf8");

      assert.equal(await readFile(brandedExecutable, "utf8"), "electron-host");
      assert.equal(
        await readFile(join(brandedContents, "Resources", "icon.icns"), "utf8"),
        "canonical-icon",
      );
      assert.match(plist, /<string>PI-Desktop<\/string>/);
      assert.match(plist, /<string>com\.pi-desktop\.app\.dev<\/string>/);
      assert.equal(prepareMacDevelopmentBundle(options), brandedExecutable);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
