import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/runtime/lifecycle.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("lifecycle.ts", source, ts.ScriptTarget.Latest, true);
const lifecycle = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "createRuntimeLifecycle",
);
const boot = lifecycle.body.statements
  .filter(ts.isVariableStatement)
  .flatMap((node) => [...node.declarationList.declarations])
  .find((node) => node.name.getText(ast) === "bootBackends");
const compiled = ts.transpileModule(`const ${boot.getText(ast)};\nreturn bootBackends;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const timeout = new Error("host RPC timeout: app.handshake");
const sidecarBoundary = new Error("fixture ends after the startup boundary");

function startupFixture(startFailure, isQuitting = () => false) {
  const events = [];
  let attempts = 0;
  const deps = {
    mkdirSync() {},
    join() {},
    dataDir: "/fixture",
    logger: { app() {} },
    APP_NAME: "PI-Desktop",
    APP_VERSION: "fixture",
    PROTOCOL_VERSION: 11,
    runtimeState: { host: { async call() { return {}; } } },
    async startHost() {
      events.push("host");
      const error = startFailure(++attempts);
      if (error) throw error;
    },
    isQuitting,
    async syncPluginDisplayLocale() {},
    getDisplayLocale: () => "en",
    async applyNetworkProxyFromAppSettings() {},
    async startSidecar() {
      events.push("sidecar");
      throw sidecarBoundary;
    },
  };
  return { events, run: new Function(...Object.keys(deps), compiled)(...Object.values(deps)) };
}

test("cold desktop boot retries the Host once before starting the sidecar", async () => {
  const fixture = startupFixture((attempt) => attempt === 1 ? timeout : undefined);
  await assert.rejects(fixture.run(), sidecarBoundary);
  assert.deepEqual(fixture.events, ["host", "host", "sidecar"]);
});

test("cold desktop boot stops after a second timeout, during quit or on other startup errors", async () => {
  const schemaError = new Error("database schema is newer than this build");
  for (const [error, quitting, attempts] of [[timeout, false, 2], [timeout, true, 1], [schemaError, false, 1]]) {
    const fixture = startupFixture(() => error, () => quitting);
    await assert.rejects(fixture.run(), error);
    assert.deepEqual(fixture.events, Array(attempts).fill("host"));
  }
});
