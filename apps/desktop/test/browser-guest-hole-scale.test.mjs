import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost, scaleGuestHole } = await import(
  "../electron/main/browser-host.ts"
);

/**
 * The Browser chrome reports the rect of its guest hole in its own CSS pixels
 * while the window places the guest in DIP. A docked view follows the app's
 * type scale as page zoom, so one chrome CSS pixel covers more than one DIP once
 * the user raises the Appearance font size; the guest has to follow, or it would
 * sit in a hole smaller than the chrome actually draws.
 */

const VIEW = { x: 100, y: 20, width: 400, height: 600 };

function harness() {
  const panes = [];
  const host = new BrowserHost({
    createPane: (onState) => {
      let state = null;
      const pane = {
        bounds: null,
        visible: false,
        setWindow: () => {},
        setBounds(bounds) {
          this.bounds = bounds;
        },
        setVisible(visible) {
          this.visible = visible;
        },
        getState: () => state,
        getWebContents: () => null,
        invalidateNavigation: () => {},
        navigateAndWait(target) {
          state = {
            url: target,
            title: target,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          };
          onState(state);
          return Promise.resolve(state);
        },
        dispose() {
          this.visible = false;
        },
      };
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true,
    getFileRoots: async () => [],
    onState: () => {},
  });
  host.setWindow({
    isDestroyed: () => false,
    contentView: { children: [], addChildView() {}, removeChildView() {} },
  });
  return { host, panes };
}

async function place(hole, surface) {
  const { host, panes } = harness();
  host.setChromeSurface({
    pluginId: "pi.browser",
    viewId: "browser",
    visible: true,
    bounds: VIEW,
    ...surface,
  });
  host.setChromeSession("session", "tab");
  await host.navigate({ url: "/page.html" }, "session");
  host.setGuestHole("pi.browser", hole);
  return panes.at(-1).bounds;
}

test("scaleGuestHole leaves a 100% chrome hole in DIP", () => {
  assert.deepEqual(scaleGuestHole({ x: 0, y: 30, width: 400, height: 570 }, 1), {
    x: 0,
    y: 30,
    width: 400,
    height: 570,
  });
  assert.deepEqual(scaleGuestHole({ x: 8, y: 8, width: 8, height: 8 }, undefined), {
    x: 8,
    y: 8,
    width: 8,
    height: 8,
  });
});

test("scaleGuestHole multiplies a zoomed chrome hole by its page zoom", () => {
  assert.deepEqual(
    scaleGuestHole({ x: 4, y: 36, width: 320, height: 480 }, 1.25),
    { x: 5, y: 45, width: 400, height: 600 },
  );
});

test("an unusable chrome zoom keeps the hole at 100%", () => {
  const hole = { x: 1, y: 2, width: 3, height: 4 };
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(scaleGuestHole(hole, bad), hole);
  }
});

test("the guest is placed under the chrome at the app's type scale", async () => {
  const hole = { x: 0, y: 30, width: 400, height: 570 };
  // 100%: the chrome's CSS pixels already are DIP.
  assert.deepEqual(await place(hole), { x: 100, y: 50, width: 400, height: 570 });
  // 125%: a 30 CSS px chrome bar is 37.5 DIP tall, and the guest fills the rest
  // of the same 400x600 view instead of ending 142 DIP too early.
  assert.deepEqual(await place(hole, { scale: 1.25 }), {
    x: 100,
    y: 57,
    width: 400,
    height: 562,
  });
});