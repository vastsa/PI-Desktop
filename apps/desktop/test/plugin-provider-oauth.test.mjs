import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function createRuntime(t, services = {}) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return runtime;
}

function writePlugin(t, { id, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-oauth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: "0.1.0",
    main: "main.js",
    permissions: ["provider.register", "provider.oauth"],
    contributes: {
      providers: [{
        id: "gateway",
        name: "Fixture Gateway",
        authKind: "oauth",
        baseUrl: "https://api.example.test/v1",
        oauth: { loginLabel: "Sign in to Fixture Gateway" },
        models: [{ id: "fixture-model" }],
      }],
    },
  }), "utf8");
  writeFileSync(join(dir, "main.js"), typeof main === "function" ? main(dir) : main, "utf8");
  return dir;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const testOAuthProviderHooks = async (t) => {
  const audits = [];
  const notices = [];
  const notificationSeen = deferred();
  const promptSeen = deferred();
  const promptAnswer = deferred();
  const runtime = createRuntime(t, {
    audit: (entry) => audits.push(entry),
    providerOAuthNotify: async (pluginId, loginId, event) => {
      notices.push({ pluginId, loginId, event });
      notificationSeen.resolve();
    },
    providerOAuthPrompt: async (pluginId, loginId, input) => {
      promptSeen.resolve({ pluginId, loginId, input });
      return promptAnswer.promise;
    },
  });
  const main = `module.exports = {
    onProviderOAuth: async (request) => {
      await pi.providers.oauth.notify(request.loginId, {
        kind: "deviceCode",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
      });
      const code = await pi.providers.oauth.prompt(request.loginId, {
        type: "secret",
        message: "Enter the device code",
      });
      return {
        accessToken: "fixture-access-token",
        refreshToken: "fixture-refresh-token",
        accountLabel: code,
      };
    },
  };\n`;
  const dir = writePlugin(t, { id: "demo.oauth", main });
  await runtime.loadFromPath(dir, ["provider.register", "provider.oauth"]);

  const [provider] = runtime.listOAuthProviders();
  assert.equal(provider.pluginId, "demo.oauth");
  assert.equal(provider.providerId, "plugin:demo.oauth:gateway");
  assert.ok(provider.runtimeId);

  const callback = runtime.invokeProviderOAuth("demo.oauth", "gateway", {
    operation: "login",
    providerId: "gateway",
    loginId: "login-fixture",
  }, undefined, provider.runtimeId);
  await notificationSeen.promise;
  assert.deepEqual(notices, [{
    pluginId: "demo.oauth",
    loginId: "login-fixture",
    event: {
      kind: "deviceCode",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.test/device",
    },
  }]);
  const prompt = await promptSeen.promise;
  assert.deepEqual(prompt, {
    pluginId: "demo.oauth",
    loginId: "login-fixture",
    input: { type: "secret", message: "Enter the device code" },
  });
  promptAnswer.resolve("user@example.test");

  const credential = await callback;
  assert.equal(credential.accessToken, "fixture-access-token");
  assert.equal(credential.refreshToken, "fixture-refresh-token");
  assert.equal(credential.accountLabel, "user@example.test");
  assert.ok(audits.some((entry) => entry.api === "provider.oauth" && entry.ok === true));
  assert.equal(JSON.stringify(audits).includes("fixture-access-token"), false);

  const deniedDir = writePlugin(t, {
    id: "demo.oauth.denied",
    main: "module.exports = { onProviderOAuth: async () => ({ accessToken: 'nope' }) };\n",
  });
  await runtime.loadFromPath(deniedDir, ["provider.register"]);
  assert.deepEqual(runtime.listOAuthProviders().map((entry) => entry.pluginId), ["demo.oauth"]);
  await assert.rejects(
    runtime.invokeProviderOAuth("demo.oauth.denied", "gateway", {
      operation: "login",
      providerId: "gateway",
      loginId: "denied-login",
    }),
    (error) => error.code === "PERMISSION_DENIED",
  );
};

test(
  "OAuth provider hooks cross the plugin process and use permission-gated host prompts",
  { timeout: 10_000 },
  testOAuthProviderHooks,
);

test("unloading a plugin aborts its in-flight OAuth callback context", async (t) => {
  const progress = [];
  const started = deferred();
  const runtime = createRuntime(t, {
    providerOAuthNotify: async (_pluginId, _loginId, event) => {
      progress.push(event.message);
      if (event.message === "started") started.resolve();
    },
  });
  const dir = writePlugin(t, {
    id: "demo.oauth.cancel",
    main: (pluginPath) => `const { writeFileSync } = require("node:fs");
const abortMarker = ${JSON.stringify(join(pluginPath, "oauth-aborted"))};
module.exports = {
    onProviderOAuth: async (request, { signal }) => {
      const cancelled = new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          writeFileSync(abortMarker, "aborted");
          resolve({ accessToken: "late-token" });
        }, { once: true });
      });
      await pi.providers.oauth.notify(request.loginId, { kind: "progress", message: "started" });
      return cancelled;
    },
  };\n`,
  });
  await runtime.loadFromPath(dir, ["provider.register", "provider.oauth"]);
  const [provider] = runtime.listOAuthProviders();
  const callback = runtime.invokeProviderOAuth("demo.oauth.cancel", "gateway", {
    operation: "login",
    providerId: "gateway",
    loginId: "cancel-login",
  }, undefined, provider.runtimeId);
  await started.promise;
  const unloading = runtime.unload("demo.oauth.cancel");
  await assert.rejects(callback, (error) => error.code === "PLUGIN_UNLOADED");
  await unloading;
  assert.equal(existsSync(join(dir, "oauth-aborted")), true, "the child callback sees its abort signal");
  assert.deepEqual(progress, ["started"]);
});

test("an OAuth manifest without its callback fails closed at plugin load", async (t) => {
  const runtime = createRuntime(t);
  const dir = writePlugin(t, { id: "demo.oauth.no-hook", main: "module.exports = {};\n" });
  await assert.rejects(runtime.loadFromPath(dir, ["provider.register", "provider.oauth"]), /OAuth providers require an onProviderOAuth hook/);
  assert.deepEqual(runtime.listOAuthProviders(), []);
});
