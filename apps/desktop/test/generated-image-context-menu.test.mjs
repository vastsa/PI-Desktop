/**
 * A generated image is copyable from the picture itself: right-clicking the
 * card preview or the viewer image opens the image's own menu (copy, download)
 * instead of the turn menu. The hook runs for real; only the clipboard, the
 * menu renderer, and the toast store are stubbed at their edges.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function setup({ copyFails = false } = {}) {
  const calls = { copies: [], toasts: [], menus: [], menuProps: [] };
  const mod = loadModule("../src/features/chat/transcript/CopyGeneratedImageButton.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../../../components/ContextMenu": {
      useContextMenu: () => ({
        contextMenu: null,
        openContextMenu: (event, request) => {
          event.preventDefault();
          calls.menus.push(request);
        },
        closeContextMenu: () => {},
      }),
      ContextMenu: (props) => {
        calls.menuProps.push(props);
        return null;
      },
    },
    "../../../components/icons": { IconCopy: () => null, IconDownload: () => null },
    "../../../components/ui": { TooltipButton: () => null },
    "../../../stores/app-store": {
      useAppStore: {
        getState: () => ({
          showToast: (message, options) => calls.toasts.push({ message, variant: options?.variant }),
        }),
      },
    },
    "../../../lib/image-clipboard": {
      copyImageDataUrlToClipboard: async (dataUrl) => {
        calls.copies.push(dataUrl);
        if (copyFails) throw new Error("denied");
      },
    },
    "./generated-image-download": {
      generatedImageDownloadName: (dataUrl, index) => (dataUrl ? `generated-image-${index + 1}.png` : null),
    },
  });
  return { mod, calls };
}

function renderHook(useHook) {
  let result;
  function Probe() {
    result = useHook();
    return result.menu ?? null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return result;
}

function rightClick() {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  return event;
}

test("right-clicking an image offers copy then download, and copy writes that image", async () => {
  const { mod, calls } = setup();
  const menu = renderHook(() => mod.useGeneratedImageContextMenu(PNG, 0));
  const event = rightClick();
  menu.onContextMenu(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.menus.length, 1);
  const [request] = calls.menus;
  assert.deepEqual(request.items.map((item) => item.id), ["copy-image", "download-image"]);
  assert.equal(request.items[0].label, "settings.copyGeneratedImage");

  await request.items[0].onSelect("");
  assert.deepEqual(calls.copies, [PNG]);
  assert.deepEqual(calls.toasts, [{ message: "chat.copied", variant: undefined }]);
});

test("a failed copy is reported as an error toast", async () => {
  const { mod, calls } = setup({ copyFails: true });
  const menu = renderHook(() => mod.useGeneratedImageContextMenu(PNG, 0));
  menu.onContextMenu(rightClick());
  await calls.menus[0].items[0].onSelect("");
  assert.deepEqual(calls.toasts, [{ message: "chat.copyFailed", variant: "error" }]);
});

test("the viewer reports copy inline and portals the menu into its dialog", async () => {
  const { mod, calls } = setup();
  const reports = [];
  const dialog = { tagName: "DIALOG" };
  const menu = renderHook(() =>
    mod.useGeneratedImageContextMenu(PNG, 1, { container: dialog, onCopied: (copied) => reports.push(copied) }),
  );
  assert.equal(calls.menuProps.at(-1).container, dialog);
  menu.onContextMenu(rightClick());
  await calls.menus[0].items[0].onSelect("");
  assert.deepEqual(reports, [true]);
  assert.deepEqual(calls.toasts, [], "toasts render below the modal top layer");
});

test("an image that has not loaded keeps the native context menu", () => {
  const { mod, calls } = setup();
  const menu = renderHook(() => mod.useGeneratedImageContextMenu(null, 0));
  const event = rightClick();
  menu.onContextMenu(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(calls.menus.length, 0);
});

test("the card preview and the viewer image both open the image menu", () => {
  const card = read("../src/features/chat/transcript/GeneratedImages.tsx");
  const viewer = read("../src/features/chat/transcript/GeneratedImageViewer.tsx");
  assert.match(card, /onContextMenu=\{imageMenu\.onContextMenu\}/);
  assert.match(viewer, /onContextMenu=\{imageMenu\.onContextMenu\}/);
  assert.match(viewer, /container: dialogRef\.current/);
});

test("the context menu can portal into a modal dialog's top layer", () => {
  const source = read("../src/components/ContextMenu.tsx");
  assert.match(source, /container\?: HTMLElement \| null/);
  assert.match(source, /createPortal\(visiblePortalContent\(node\), container\)/);
});
