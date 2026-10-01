import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

test("settings hides and inerts chat without aria-hiding a focused descendant", () => {
  const chatShell = appShell.match(
    /<div\s+className="app-chat-shell"[\s\S]*?>/,
  )?.[0];

  assert.ok(chatShell, "chat shell must exist");
  assert.match(chatShell, /hidden=\{page === "settings"\}/);
  assert.match(chatShell, /inert=\{page === "settings" \? true : undefined\}/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
});

test("entering Settings moves focus to its first search control", () => {
  assert.match(settingsPage, /const settingsSearchRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(
    settingsPage,
    /settingsSearchRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(settingsPage, /<input\s+ref=\{settingsSearchRef\}/);
});
