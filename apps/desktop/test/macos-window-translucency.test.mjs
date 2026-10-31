import {
  readMainModule,
  readSettingsSource,
  readSharedTypesSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [sharedTypes, settingsSource, windowSource, lifecycleSource, mainStateSource, startupSource] =
  await Promise.all([
    readSharedTypesSource(),
    readSettingsSource(),
    readMainModule("bootstrap/window.ts"),
    readMainModule("bootstrap/app-lifecycle.ts"),
    readMainModule("bootstrap/main-state.ts"),
    readMainModule("bootstrap/startup.ts"),
  ]);

test("the macOS translucency preference is a stored opt-out of the default surface", () => {
  assert.match(sharedTypes, /macosWindowTranslucency\?: boolean;/);
  // The store defaults to the shipped translucent surface, so a boot without
  // settings still paints the window the user expects.
  assert.match(mainStateSource, /macosWindowTranslucency = true;/);
  // Absent means the shipped translucency; only an explicit `false` asks for
  // the cheaper opaque surface.
  assert.match(
    lifecycleSource,
    /state\.macosWindowTranslucency =\s*process\.platform === "darwin" && settings\?\.macosWindowTranslucency !== false;/,
  );
  // The value is read where the window is created, before Electron fixes the
  // surface, and it comes from the settings the boot sequence applied.
  assert.match(windowSource, /windowState\.macosWindowTranslucency,/);
  assert.match(startupSource, /applyMacosWindowTranslucency\(stored\);/);
});

test("creating a translucent macOS window does not repaint its surface opaque", () => {
  // `applyMainWindowBackground` runs right after the window exists. On darwin it
  // must stay out of a translucent window, or the vibrancy glass is flattened
  // before it is ever shown.
  const backgroundCall =
    windowSource.match(
      /if \(!\(process\.platform === "darwin" && windowState\.macosWindowTranslucency\)\) \{\s*applyMainWindowBackground\(/,
    )?.[0] ?? "";
  assert.ok(
    backgroundCall,
    "the post-creation background paint must skip a translucent macOS window",
  );
});

test("a running window cannot switch surfaces, so the preference waits for a launch", async () => {
  const applyBody =
    lifecycleSource.match(/function applyMacosWindowTranslucency\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(applyBody, "expected applyMacosWindowTranslucency");
  assert.doesNotMatch(applyBody, /setVibrancy|setBackgroundColor|new BrowserWindow/);
  // A translucent window keeps its transparent surface for the background IPC,
  // and the renderer reads the created surface so a saved change can show a
  // restart hint instead of faking a live switch.
  const windowIpc = await readMainModule("ipc/window-ipc.ts");
  assert.match(
    windowIpc,
    /process\.platform === "darwin" && isMacosWindowTranslucent\(\)/,
  );
  // The renderer reads the surface this process created, and a non-macOS window
  // reports `false` rather than inheriting a platform-independent default.
  assert.match(windowIpc, /const macosWindowTranslucency =\s*process\.platform === "darwin" && isMacosWindowTranslucent\(\);/);
});

test("the switch is macOS-only and says when a restart is needed", async () => {
  const row = await read("../src/components/settings/MacosWindowTranslucencyRow.tsx");
  assert.match(
    settingsSource,
    /platform === "darwin" && \(\s*<MacosWindowTranslucencyRow settings=\{settings\} saveSettings=\{saveSettings\} \/>/,
  );
  assert.match(row, /settings\.macosWindowTranslucency !== false/);
  assert.match(row, /saveSettings\(\{ macosWindowTranslucency: !translucent \}\)/);
  assert.match(row, /t\("settings\.windowTranslucencyRestart"\)/);
  assert.match(row, /const \[applied, setApplied\] = useState<boolean \| null>\(null\)/);
  assert.match(row, /\.windowControl\("getState"\)/);
  assert.match(row, /applied !== null && applied !== translucent/);

  const en = await read("../../../packages/i18n/src/locales/en/index.ts");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  for (const source of [en, zh]) {
    for (const key of [
      "windowTranslucency:",
      "windowTranslucencyDesc:",
      "windowTranslucencyRestart:",
    ]) {
      assert.ok(source.includes(key), `missing i18n key ${key}`);
    }
  }
});

test("both settings write paths reject a non-boolean translucency value", async () => {
  const rendererApi = await read("../src/lib/api.ts");
  const mainCatalog = await readMainModule("runtime/provider-catalog.ts");
  const booleanKeys = rendererApi.match(/for \(const key of \[([\s\S]*?)\] as const\) \{/)?.[1];
  assert.match(booleanKeys ?? "", /"macosWindowTranslucency"/);
  assert.match(rendererApi, /typeof value\[key\] !== "boolean"/);
  assert.match(
    mainCatalog,
    /hasOwnProperty\.call\(value, "macosWindowTranslucency"\)[\s\S]*?typeof value\.macosWindowTranslucency !== "boolean"/,
  );
});
