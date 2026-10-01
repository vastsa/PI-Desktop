import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createNotificationChime,
  shouldPlayToastSound,
} from "../src/lib/notification-sound.ts";

const toastSource = await readFile(
  new URL("../src/components/Toast.tsx", import.meta.url),
  "utf8",
);
const promptNotificationSource = await readFile(
  new URL("../src/stores/runtime/notification-runtime.ts", import.meta.url),
  "utf8",
);
const englishLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const chineseLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const germanLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/de/index.ts", import.meta.url),
  "utf8",
);
const spanishLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/es/index.ts", import.meta.url),
  "utf8",
);
const frenchLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/fr/index.ts", import.meta.url),
  "utf8",
);
const shellNotificationSource = await readFile(
  new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url),
  "utf8",
);
const nativeNotificationSource = await readFile(
  new URL("../electron/main/ipc/notification-ipc.ts", import.meta.url),
  "utf8",
);
const pluginNotificationSource = await readFile(
  new URL("../electron/main/services/plugin-services.ts", import.meta.url),
  "utf8",
);
const pluginNativeSource = await readFile(
  new URL("../electron/main/services/desktop-services.ts", import.meta.url),
  "utf8",
);

function audioFixture() {
  const calls = { frequency: [], gain: [], start: [], stop: [], closes: 0 };
  const oscillator = {
    type: "",
    frequency: { setValueAtTime: (...args) => calls.frequency.push(args) },
    connect() {},
    start: (...args) => calls.start.push(args),
    stop: (...args) => calls.stop.push(args),
    onended: undefined,
  };
  const gain = {
    gain: {
      setValueAtTime: (...args) => calls.gain.push(["set", ...args]),
      linearRampToValueAtTime: (...args) => calls.gain.push(["linear", ...args]),
      exponentialRampToValueAtTime: (...args) => calls.gain.push(["exponential", ...args]),
    },
    connect() {},
  };
  const context = {
    state: "running",
    currentTime: 4,
    destination: {},
    createOscillator: () => oscillator,
    createGain: () => gain,
    resume: async () => undefined,
    close: async () => { calls.closes += 1; },
  };
  return { calls, context, oscillator };
}

test("notification chime is a brief, low-gain sine tone and releases audio resources", () => {
  const fixture = audioFixture();
  const play = createNotificationChime(() => fixture.context, () => 1_000);

  play();

  assert.equal(fixture.oscillator.type, "sine");
  assert.deepEqual(fixture.calls.frequency, [[660, 4]]);
  assert.deepEqual(fixture.calls.gain, [
    ["set", 0.0001, 4],
    ["linear", 0.022, 4.012],
    ["exponential", 0.0001, 4.16],
  ]);
  assert.deepEqual(fixture.calls.start, [[4]]);
  assert.deepEqual(fixture.calls.stop, [[4.17]]);
  fixture.oscillator.onended();
  assert.equal(fixture.calls.closes, 1);
});

test("notification chime coalesces rapid events and skips unavailable audio", () => {
  let now = 1_000;
  let created = 0;
  const play = createNotificationChime(() => {
    created += 1;
    return audioFixture().context;
  }, () => now);

  play();
  play();
  assert.equal(created, 1);
  now += 200;
  play();
  assert.equal(created, 2);
  assert.doesNotThrow(() => createNotificationChime(() => undefined, () => 1_000)());
});

test("toast chimes only for newly visible toasts that have not opted out", () => {
  const visible = new Set([2]);
  assert.equal(shouldPlayToastSound({ id: 1 }, visible), true);
  assert.equal(shouldPlayToastSound({ id: 2 }, visible), false);
  assert.equal(shouldPlayToastSound({ id: 3, sound: false }, visible), false);
});

test("ask notifications use a stable title instead of the generated session title", () => {
  const askBranch = promptNotificationSource.match(
    /if \(kind === "ask"\) \{([\s\S]*?)\} else if \(kind === "permission"\)/,
  )?.[1];
  assert.ok(askBranch, "ask notification branch exists");
  assert.match(askBranch, /i18n\.t\("notifications\.askTitle"\)/);
  assert.doesNotMatch(askBranch, /sessionTitle/);
  assert.match(askBranch, /payload\?\.question/);
  assert.match(englishLocaleSource, /askTitle: "A question needs your answer"/);
  assert.match(chineseLocaleSource, /askTitle: "有问题需要你回答"/);
  assert.match(germanLocaleSource, /"askTitle": "Eine Frage braucht Ihre Antwort"/);
  assert.match(spanishLocaleSource, /"askTitle": "Hay una pregunta que requiere su respuesta"/);
  assert.match(frenchLocaleSource, /"askTitle": "Une question attend votre réponse"/);
});

test("app and plugin notification surfaces share one chime without native double-sounds", () => {
  assert.match(toastSource, /shouldPlayToastSound\(toast, visibleToastIds\.current\)/);
  assert.match(toastSource, /if \(shouldPlay\) playNotificationChime\(\)/);
  assert.match(promptNotificationSource, /playNotificationChime\(\)/);
  assert.match(promptNotificationSource, /get\(\)\.showToast\([\s\S]*sound: false/);
  assert.match(
    shellNotificationSource,
    /if \(!accepted\) return;\s*playNotificationChime\(\)/,
  );
  assert.match(nativeNotificationSource, /new SystemNotification\(\{ title, body, silent: true \}\)/);
  assert.match(shellNotificationSource, /api\.onNotificationSound\(playNotificationChime\)/);
  assert.match(pluginNotificationSource, /if \(result\.shown\) sendToRenderer\(IPC\.event\.notificationSound/);
  assert.match(pluginNotificationSource, /permission === "granted"[\s\S]*IPC\.event\.notificationSound/);
  assert.match(pluginNativeSource, /new SystemNotification\(\{ title, body, silent: true \}\)/);
});
