import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const probeSource = await readFile(
  new URL("../electron/main/plan-ui-probe.ts", import.meta.url),
  "utf8",
);
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);
const harnessSource = await readFile(
  new URL("../../../scripts/e2e-plan-ui.mjs", import.meta.url),
  "utf8",
);

test("Plan UI probe is Main-only, explicitly gated, and reuses the live Host", () => {
  assert.match(mainSource, /if \(!bootError\) planUiProbe\.install\(\)/);
  assert.match(probeSource, /PI_DESKTOP_PLAN_UI_PROBE/);
  assert.match(probeSource, /if \(process\.env\.PI_DESKTOP_PLAN_UI_PROBE !== "1"\) return/);
  assert.match(probeSource, /__PI_DESKTOP_PLAN_UI_PROBE/);
  for (const method of [
    "workspace\\.set",
    "session\\.create",
    "session\\.beginTurn",
    "plans\\.submit",
  ]) {
    assert.match(probeSource, new RegExp(`(?:host|activeHost)\\.call[\\s\\S]*?"${method}"`));
  }
  assert.match(probeSource, /electronMainPid: process\.pid/);
  assert.match(probeSource, /hostChildPid:/);
});

test("runtime identity is a probe-gated WeakMap identity for the live runtime object", () => {
  assert.match(sidecarSource, /PI_DESKTOP_PLAN_UI_PROBE/);
  assert.match(sidecarSource, /WeakMap<DesktopAgentRuntime, string>/);
  assert.match(sidecarSource, /testRuntimeIds\.get\(runtime\)/);
  assert.match(sidecarSource, /testRuntimeIds\.set\(runtime, runtimeId\)/);
  assert.match(sidecarSource, /runtimes\.get\(sessionId\)/);
  assert.match(sidecarSource, /agent\.testRuntimeIdentity/);
  const identityBlock = sidecarSource.slice(
    sidecarSource.indexOf("function testRuntimeIdentity"),
    sidecarSource.indexOf("type RuntimeParams"),
  );
  assert.doesNotMatch(identityBlock, /apiKey|secretValue|baseUrl/);
  assert.match(probeSource, /agent\.testRuntimeIdentity/);
  assert.match(probeSource, /sidecarChildPid/);
});

test("live setup is Main-env gated and the harness never sends credentials through CDP", () => {
  assert.match(probeSource, /PI_DESKTOP_TEST_API_KEY/);
  assert.match(probeSource, /PI_DESKTOP_TEST_BASE_URL/);
  assert.match(probeSource, /PI_DESKTOP_TEST_MODEL/);
  assert.match(probeSource, /secretValue: apiKey/);
  assert.match(probeSource, /operation === "liveSetup"/);
  assert.match(harnessSource, /E2E-106-live-agent/);
  assert.match(harnessSource, /LIVE_ENV_AVAILABLE/);
  assert.match(harnessSource, /submitComposerPrompt/);
  assert.match(harnessSource, /operation: "liveSetup"/);
  assert.doesNotMatch(harnessSource, /secretValue/);
  assert.doesNotMatch(
    harnessSource,
    /JSON\.stringify\([\s\S]{0,240}PI_DESKTOP_TEST_API_KEY/,
  );
});

test("Plan UI harness uses the second inspector and never starts a fixture Host", () => {
  assert.match(harnessSource, /--inspect=\$\{state\.inspectorPort\}/);
  assert.match(harnessSource, /candidate\.type === "node"/);
  assert.match(harnessSource, /globalThis\.__PI_DESKTOP_PLAN_UI_PROBE/);
  assert.match(harnessSource, /createHash\("sha256"\)/);
  assert.match(harnessSource, /hostChildPid/);
  assert.doesNotMatch(harnessSource, /e2e-plan-ui-fixture|runFixture|fixtureChildren/);
});
