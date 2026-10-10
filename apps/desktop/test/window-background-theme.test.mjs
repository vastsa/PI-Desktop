import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export class BrowserWindow extends EventEmitter {
    static fromWebContents() { return null; }
  }
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { MAX_WINDOW_CORNER_RADIUS } = await import("@pi-desktop/plugin-sdk");
const { builtinWindowBackground, ErrorCodes, IPC } = await import("@pi-desktop/shared");
const { registerWindowIpc } = await import("../electron/main/ipc/window-ipc.ts");

const hostPlatform = process.platform;

function definePlatform(platform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function backgroundHarness({
  t,
  platform = "darwin",
  vibrancy = false,
  destroyed = false,
  senderId = 1,
  mainId = 1,
} = {}) {
  definePlatform(platform);
  t.after(() => definePlatform(hostPlatform));
  const colors = [];
  const window = {
    isDestroyed: () => destroyed,
    setBackgroundColor(color) {
      colors.push(color);
    },
  };
  const handlers = new Map();
  registerWindowIpc({
    registrar: {
      ipcMain: {},
      handle() {},
      handleWithEvent(channel, handler) {
        handlers.set(channel, handler);
      },
      assertMainWindowSender(event) {
        if (event.sender.id !== mainId) {
          throw Object.assign(new Error("renderer is not the main window"), {
            errorCode: "PERMISSION_DENIED",
          });
        }
      },
    },
    getMainWindow: () => window,
    getWorkPanelReservationWidth: () => 0,
    setWorkPanelReservationWidth() {},
    setWorkPanelReservation() {},
    getWorkPanelChatWidthSetter: () => null,
    applyCloseBehavior() {},
    getCloseBehavior: () => "quit",
    markMenuRendererReady: () => false,
    executeNativeMenuAction() {},
    setTraySessionPreferences: async () => {},
    isMacosSidebarVibrancyEnabled: () => vibrancy,
  });
  return {
    colors,
    invoke(input, event = { sender: { id: senderId } }) {
      return handlers.get(IPC.invoke.windowSetBackgroundColor)(event, input);
    },
  };
}


test("opaque macOS paints the built-in light and dark plates", async (t) => {
  const { invoke, colors } = backgroundHarness({ t, vibrancy: false });
  assert.deepEqual(await invoke({ theme: "light" }), {
    applied: true,
    theme: "light",
    color: builtinWindowBackground("light"),
    cornerRadius: null,
  });
  assert.deepEqual(await invoke({ theme: "dark" }), {
    applied: true,
    theme: "dark",
    color: builtinWindowBackground("dark"),
    cornerRadius: null,
  });
  assert.deepEqual(colors, [
    builtinWindowBackground("light"),
    builtinWindowBackground("dark"),
  ]);
});

test("a contributed colour is applied then restored from the built-in table", async (t) => {
  const { invoke, colors } = backgroundHarness({ t, vibrancy: false });
  assert.deepEqual(await invoke({ theme: "dark", color: "#112233" }), {
    applied: true,
    theme: "dark",
    color: "#112233",
    cornerRadius: null,
  });
  assert.deepEqual(await invoke({ theme: "dark" }), {
    applied: true,
    theme: "dark",
    color: builtinWindowBackground("dark"),
    cornerRadius: null,
  });
  assert.deepEqual(colors, ["#112233", builtinWindowBackground("dark")]);
});

test("macOS vibrancy leaves the native plate untouched", async (t) => {
  const { invoke, colors } = backgroundHarness({ t, vibrancy: true });
  assert.deepEqual(await invoke({ theme: "dark", color: "#112233" }), {
    applied: false,
    theme: "dark",
  });
  assert.deepEqual(colors, []);
});

test("linux still paints when the macOS vibrancy callback would skip", async (t) => {
  const { invoke, colors } = backgroundHarness({ t, platform: "linux", vibrancy: true });
  assert.deepEqual(await invoke({ theme: "light" }), {
    applied: true,
    theme: "light",
    color: builtinWindowBackground("light"),
    cornerRadius: null,
  });
  assert.deepEqual(colors, [builtinWindowBackground("light")]);
});

test("invalid colour, theme, and radius are refused", async (t) => {
  const { invoke, colors } = backgroundHarness({ t, vibrancy: false });
  await assert.rejects(() => invoke({ theme: "system" }), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
  });
  await assert.rejects(() => invoke({ theme: "dark", color: "red" }), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
  });
  await assert.rejects(() => invoke({ theme: "dark", color: "#fff" }), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
  });
  await assert.rejects(() => invoke({ theme: "dark", cornerRadius: -1 }), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
  });
  await assert.rejects(
    () => invoke({ theme: "dark", cornerRadius: MAX_WINDOW_CORNER_RADIUS + 1 }),
    { errorCode: ErrorCodes.INVALID_ARGUMENT },
  );
  await assert.rejects(() => invoke({ theme: "dark", cornerRadius: 1.5 }), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
  });
  assert.deepEqual(colors, []);
});

test("a forbidden sender cannot paint the window", async (t) => {
  const { invoke, colors } = backgroundHarness({ t, vibrancy: false, senderId: 2, mainId: 1 });
  await assert.rejects(() => invoke({ theme: "dark" }), { errorCode: "PERMISSION_DENIED" });
  assert.deepEqual(colors, []);
});

test("a destroyed window cannot paint", async (t) => {
  const { invoke } = backgroundHarness({ t, vibrancy: false, destroyed: true });
  await assert.rejects(() => invoke({ theme: "dark" }), { message: "main window unavailable" });
});
