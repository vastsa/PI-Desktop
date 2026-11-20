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

test("Settings is a modal over the chat shell, which stays mounted and visible", async () => {
  const chatShell = appShell.match(
    /<div\s+className="app-chat-shell"[\s\S]*?>/,
  )?.[0];
  const dialog = await readFile(
    new URL("../src/features/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.ok(chatShell, "chat shell must exist");
  assert.doesNotMatch(chatShell, /hidden=|inert=|aria-hidden/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /useModalDialog\(dialogRef, \{ onClose \}\)/);
});

test("entering Settings moves focus to its first search control", () => {
  assert.match(settingsPage, /const settingsSearchRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(
    settingsPage,
    /settingsSearchRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(settingsPage, /<input\s+ref=\{settingsSearchRef\}/);
});

test("chat code loads inside the existing route boundary and stays mounted under Settings", () => {
  assert.match(
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  assert.match(
    appShell,
    /className="app-chat-shell"[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/,
  );
});
