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
    /setWindowBackgroundColor:\s*\(theme:\s*"light" \| "dark"\)[\s\S]*?IPC\.invoke\.windowSetBackgroundColor/,
  );
  assert.match(
    mainSource,
    /handle\(IPC\.invoke\.windowSetBackgroundColor,[\s\S]*?setBackgroundColor\(theme === "light" \? "#ffffff" : "#181818"\)/,
  );
  assert.match(
    mainSource,
    /process\.platform === "darwin"\) return \{ applied: false, theme \};/,
  );
  assert.match(
    appSource,
    /document\.documentElement\.dataset\.theme = resolvedTheme;[\s\S]*?api\.setWindowBackgroundColor\(resolvedTheme\)/,
  );
});
