import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const electronProxy = await readFile(
  new URL("../electron/main/network-proxy.ts", import.meta.url),
  "utf8",
);
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);
const nodeProxy = await readFile(
  new URL("../../../packages/agent-runtime/src/node-proxy.ts", import.meta.url),
  "utf8",
);
const hostProcess = await readFile(
  new URL("../electron/main/host-process.ts", import.meta.url),
  "utf8",
);
const hostProxy = await readFile(
  new URL("../../../crates/host-core/src/network_proxy.rs", import.meta.url),
  "utf8",
);

test("Electron main applies Chromium proxy and net.fetch", () => {
  assert.match(electronProxy, /ses\.setProxy\(config\)/);
  assert.match(electronProxy, /net\.fetch\.bind\(net\)/);
  assert.match(electronProxy, /session-created/);
  assert.match(electronProxy, /pi-desktop\/network\/testProxy|PROXY_TEST_URL/);
  assert.match(electronProxy, /PI_DESKTOP_PROXY_JSON/);
});

test("sidecar reconfigures undici without a restart", () => {
  assert.match(sidecarSource, /applyNodeNetworkProxy/);
  assert.match(sidecarSource, /sidecar\.configure/);
  assert.match(nodeProxy, /ProxyAgent/);
  assert.match(nodeProxy, /socks5Connect/);
  assert.match(nodeProxy, /setGlobalDispatcher/);
});

test("host-core marketplace curl uses --proxy and Bash does not inherit env", () => {
  assert.match(hostProxy, /curl_proxy_args/);
  assert.match(hostProxy, /"--proxy"/);
  assert.match(hostProcess, /stripProxyEnv\(process\.env\)/);
});
