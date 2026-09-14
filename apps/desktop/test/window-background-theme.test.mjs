import { readAppSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const mainSource = await readMainSource();
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();

test("theme changes synchronize the native non-macOS window background", () => {
  assert.match(
    protocolSource,
    /windowSetBackgroundColor:\s*"pi-desktop\/window\/setBackgroundColor"/,
  );
  assert.match(
    apiSource,
    /setWindowBackgroundColor:\s*\(theme:\s*"light" \| "dark",\s*color\?:\s*string\)[\s\S]*?IPC\.invoke\.windowSetBackgroundColor/,
  );
  assert.match(
    mainSource,
    /handle\(IPC\.invoke\.windowSetBackgroundColor,[\s\S]*?!isWindowBackgroundColor\(requested\)[\s\S]*?mainWindow\.setBackgroundColor\(color\)/,
  );
  // A malformed colour is refused; an omitted one falls back to the host
  // palette, which is what restores the default after a theme switch.
  assert.match(mainSource, /isWindowBackgroundColor\(requested\)\s*\n?\s*\? requested/);
  // That fallback is the shared built-in theme table, not a literal per call
  // site, so window-ipc, window creation, and the panel host cannot drift.
  assert.match(mainSource, /: builtinWindowBackground\(theme\)/);
  assert.match(mainSource, /backgroundColor: builtinWindowBackground\(request\.theme\)/);
  assert.match(
    mainSource,
    /builtinWindowBackground\(\s*nativeTheme\.shouldUseDarkColors \? "dark" : "light",?\s*\)/,
  );
  assert.match(
    mainSource,
    /process\.platform === "darwin"\) return \{ applied: false, theme \};/,
  );
  assert.match(
    appSource,
    /document\.documentElement\.dataset\.theme = resolvedTheme;/,
  );
  assert.ok(
    appSource.includes(
      "setWindowBackgroundColor(resolvedTheme, pluginTheme?.windowBackground?.[resolvedTheme])",
    ),
  );
});

test("the built-in window palette is declared once", async () => {
  const builtinTheme = await readFile(
    new URL("../../../packages/shared/src/theme.ts", import.meta.url),
    "utf8",
  );
  assert.match(builtinTheme, /windowBackground: "#ffffff"/);
  assert.match(builtinTheme, /windowBackground: "#181818"/);
  for (const relative of [
    "../electron/main/bootstrap/window.ts",
    "../electron/main/plugin-panel-host.ts",
    "../electron/main/ipc/window-ipc.ts",
    "../electron/preload/plugin-panel.ts",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /builtinWindowBackground/);
    // The dark plate is the distinctive half of the pair; the panel preload
    // still names #ffffff as page ink, which the theme table does not own.
    assert.doesNotMatch(source, /#181818/);
  }
});
