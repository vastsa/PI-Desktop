import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");

// RemoteHostsPage pulls `showToast`/`openProject` from the real app store, which
// composes many unrelated slices and their own IPC traffic on creation. This
// fixture does not need any of that: it stands the hook in for a plain object
// so the only thing actually exercised across an IPC-shaped boundary is the
// SSH install call the test is about.
const fakeAppStore = String.raw`
const state = {
  showToast: (message, options) => {
    globalThis.__toasts = globalThis.__toasts ?? [];
    globalThis.__toasts.push({ message, options });
  },
  openProject: async () => undefined,
};
export function useAppStore(selector) {
  return selector(state);
}
`;

const redirectAppStore = {
  name: "redirect-app-store",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /fake-app-store\.js$/ }, () => ({
      contents: fakeAppStore,
      loader: "js",
    }));
    pluginBuild.onResolve({ filter: /^\.\.\/\.\.\/stores\/app-store$/ }, () => ({
      path: join(root, "apps/desktop/__fixture_fake-app-store.js"),
      namespace: "file",
    }));
  },
};

const fixture = String.raw`
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { loadRendererResources } from "./src/lib/renderer-catalogs";
import { api } from "./src/lib/api";
import { RemoteHostsPage } from "./src/components/settings/RemoteHostsPage";

window.piDesktop = {
  channels: IPC,
  platform: "linux",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
};

// The only mocked collaborator: the SSH/IPC edge the component calls out to.
// Everything else (form state, validation, error mapping, i18n, the toast
// store stand-in above) runs as the real production code would.
api.listRemoteHosts = async () => ({ hosts: [] });
api.onSessionsChanged = () => () => undefined;
api.bootstrapRemoteHost = async () => {
  const error = new Error("ssh command failed with exit code 255: Permission denied, please try again.");
  error.errorCode = "HOST_BOOTSTRAP_FAILED";
  throw error;
};

const host = document.createElement("div");
document.body.append(host);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const waitFor = async (predicate, frames = 60) => {
  for (let frame = 0; frame < frames; frame += 1) {
    const value = predicate();
    if (value) return value;
    await nextFrame();
  }
  throw new Error("condition did not become true in time");
};

function setNativeValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  );
  descriptor.set.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

globalThis.sshInstallFailureProbe = async () => {
  const resources = await loadRendererResources("en");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources, interpolation: { escapeValue: false } });

  const root = createRoot(host);
  flushSync(() => {
    root.render(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(RemoteHostsPage, null),
      ),
    );
  });

  // Initial inventory load (mocked to an empty list) before "Add via SSH" is enabled.
  const addButton = await waitFor(() =>
    document.getElementById("remote-host-add-ssh")?.hasAttribute("disabled") === false
      ? document.getElementById("remote-host-add-ssh")
      : undefined,
  );
  addButton.click();

  const form = await waitFor(() => document.getElementById("remote-host-add-panel-ssh"));
  setNativeValue(form.querySelector('[aria-label="Label"]'), "A6000");
  setNativeValue(form.querySelector('[aria-label="Host"]'), "10.246.1.5");

  const submitButton = form.querySelector('button[type="submit"]');
  await waitFor(() => !submitButton.hasAttribute("disabled"));
  submitButton.click();

  const toast = await waitFor(() => globalThis.__toasts?.at(-1));
  return { message: toast.message };
};
`;

test(
  "a failed SSH install shows the specific bootstrap-failure message, not the generic fallback",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-remote-host-ssh-install-"));
    try {
      await build({
        stdin: {
          contents: fixture,
          resolveDir: join(root, "apps/desktop"),
          loader: "tsx",
        },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        loader: { ".css": "empty" },
        plugins: [redirectAppStore],
        alias: {
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><script src="renderer.js"></script>',
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.sshInstallFailureProbe()");
    console.log("SSH_INSTALL_FAILURE_PROBE " + JSON.stringify({ ok: true, result }));
    app.exit(0);
  } catch (error) {
    console.error("SSH_INSTALL_FAILURE_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        resolveElectronBinary(root).electronBinary,
        [join(temp, "main.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timeout);
      }

      const line = output
        .split(/\r?\n/)
        .find((item) => item.startsWith("SSH_INSTALL_FAILURE_PROBE "));
      assert.ok(line, output.slice(-6000));
      assert.equal(code, 0, output.slice(-6000));
      const report = JSON.parse(line.slice("SSH_INSTALL_FAILURE_PROBE ".length));
      assert.equal(report.ok, true, output.slice(-6000));
      assert.equal(
        report.result.message,
        "Install failed: Installing or starting the remote Host over SSH failed. Check connectivity, credentials, and that the remote machine meets the Host's requirements, then try again.",
      );
      assert.doesNotMatch(
        report.result.message,
        /The remote operation failed\. Check the Host connection and try again\./,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
