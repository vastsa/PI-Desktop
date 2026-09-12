import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  DISALLOWED_EXTERNAL_URL,
  isAllowedExternalUrl,
  isAllowedHttpUrl,
  openAllowedExternal,
  parseAllowedExternalUrl,
} = await import("../electron/main/safe-open-external.ts");

const read = (rel) => readFileSync(join(here, rel), "utf8");
const desktopServicesSource = readMainModuleSync("services/desktop-services.ts");
const windowSource = readMainModuleSync("bootstrap/window.ts");
const appIpcSource = readMainModuleSync("ipc/app-ipc.ts");
const mainIndexSource = readMainModuleSync("index.ts");
const runtimeSource = read("../electron/main/plugin-runtime.ts");
const viewHostSource = read("../electron/main/plugin-view-host.ts");
const browserSource = read("../electron/main/browser-view.ts");
const updaterSource = read("../electron/main/updater.ts");

test("parseAllowedExternalUrl permits http, https, and mailto", () => {
  assert.equal(
    parseAllowedExternalUrl("https://github.com/vastsa/PI-Desktop"),
    "https://github.com/vastsa/PI-Desktop",
  );
  assert.equal(parseAllowedExternalUrl("https://claude.ai"), "https://claude.ai/");
  assert.equal(
    parseAllowedExternalUrl("http://localhost:3000/docs"),
    "http://localhost:3000/docs",
  );
  assert.equal(
    parseAllowedExternalUrl("http://127.0.0.1:8080/api?query=hello#test"),
    "http://127.0.0.1:8080/api?query=hello#test",
  );
  assert.equal(
    parseAllowedExternalUrl("mailto:security@example.com"),
    "mailto:security@example.com",
  );
  assert.equal(
    parseAllowedExternalUrl("MAILTO:user@example.com?subject=hi"),
    "mailto:user@example.com?subject=hi",
  );
  assert.equal(parseAllowedExternalUrl("  HTTPS://EXAMPLE.COM/a  "), "https://example.com/a");
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedHttpUrl("https://example.com"), true);
  assert.equal(isAllowedHttpUrl("mailto:user@example.com"), false);
});

test("parseAllowedExternalUrl blocks file, script, and custom schemes", () => {
  const blocked = [
    "file:///etc/passwd",
    "file:///C:/Windows/System32/cmd.exe",
    "file://localhost/Users/admin/.ssh/id_rsa",
    "FILE:///path/to/script.sh",
    "ms-msdt:/id%20PCWDiagnostic",
    "search-ms:query=calc.exe",
    "custom-scheme://execute?cmd=calc",
    "ssh://user@attacker.com",
    "telnet://attacker.com:23",
    "javascript:alert(1)",
    "JAVASCRIPT:console.log('xss')",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox('hi')",
    "https:alert(1)",
    "http:",
    "http://",
    "mailto:",
  ];
  for (const url of blocked) {
    assert.equal(parseAllowedExternalUrl(url), null, url);
  }
});

test("parseAllowedExternalUrl rejects malformed or control-character input", () => {
  const blocked = ["", "   ", null, undefined, ":::invalid", "not-a-url", 12345, "https://example.com\nfile:///etc/passwd"];
  for (const input of blocked) {
    assert.equal(parseAllowedExternalUrl(input), null, String(input));
  }
});

test("openAllowedExternal calls the opener only for allowlisted hrefs and throws otherwise", async () => {
  const calls = [];
  const mockOpen = async (url) => {
    calls.push(url);
  };

  assert.equal(
    await openAllowedExternal("https://example.com/path", mockOpen),
    "https://example.com/path",
  );
  assert.equal(await openAllowedExternal("mailto:a@b.test", mockOpen), "mailto:a@b.test");
  await assert.rejects(
    () => openAllowedExternal("file:///etc/passwd", mockOpen),
    (error) => error instanceof Error && error.message === DISALLOWED_EXTERNAL_URL,
  );
  await assert.rejects(() => openAllowedExternal("ms-msdt:foo", mockOpen));
  assert.deepEqual(calls, ["https://example.com/path", "mailto:a@b.test"]);
});

test("main, plugins, preview, and updater share the allowlist before openExternal", () => {
  assert.match(desktopServicesSource, /import \{ parseAllowedExternalUrl \} from "\.\.\/safe-open-external"/);
  assert.match(desktopServicesSource, /const safeOpenExternal = async \(rawUrl: unknown\)/);
  assert.match(desktopServicesSource, /const url = parseAllowedExternalUrl\(rawUrl\)/);
  assert.match(desktopServicesSource, /throw new Error\("DISALLOWED_EXTERNAL_URL"\)/);
  assert.match(
    windowSource,
    /window\.webContents\.setWindowOpenHandler\(\(\{ url \}\) => \{\s*void safeOpenExternal\(url\)\.catch/,
  );
  assert.match(mainIndexSource, /openExternal: async \(url\) => \{\s*await safeOpenExternal\(url\);/);
  assert.match(appIpcSource, /assertFeedbackIssueUrl\(url\);\s*await safeOpenExternal\(url\);/);
  assert.doesNotMatch(
    windowSource,
    /setWindowOpenHandler\(\(\{ url \}\) => \{\s*void shell\.openExternal\(url\)/,
  );

  assert.match(runtimeSource, /import \{ parseAllowedExternalUrl \} from "\.\/safe-open-external"/);
  const openExternalGate = runtimeSource.slice(
    runtimeSource.indexOf("openExternal: async (url: string)"),
    runtimeSource.indexOf("net: {"),
  );
  assert.match(openExternalGate, /const allowed = parseAllowedExternalUrl\(url\)/);
  assert.match(openExternalGate, /only http\(s\)\/mailto URLs allowed/);
  assert.doesNotMatch(openExternalGate, /\^https\?:\\\/\\\//);
  assert.doesNotMatch(openExternalGate, /\^mailto:/);

  assert.match(viewHostSource, /parseAllowedExternalUrl\(url\)/);
  assert.match(viewHostSource, /if \(allowed\) void shell\.openExternal\(allowed\)/);
  assert.doesNotMatch(viewHostSource, /\^https\?:/);

  assert.match(browserSource, /parseAllowedExternalUrl\(url\)/);
  assert.match(browserSource, /isAllowedHttpUrl\(url\)/);
  assert.match(browserSource, /shell\.openPath\(fileURLToPath\(url\)\)/);
  assert.doesNotMatch(
    browserSource,
    /openExternal\(\): void \{[\s\S]*void shell\.openExternal\(url\);/,
  );

  assert.match(updaterSource, /parseAllowedExternalUrl\(RELEASES_URL\)/);
});
