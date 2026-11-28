import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browser, desktop } from "./helpers/lan-webui-fixture.mjs";

const { createLanWebUiService } = await import("../electron/main/lan-webui/service.ts");
const address = "127.0.0.1";

async function reserve(port = 0) {
  const socket = createServer().listen(port, address);
  await once(socket, "listening");
  return { port: socket.address().port, close: () => new Promise((resolve) => socket.close(resolve)) };
}

async function setup(t) {
  const reservation = await reserve();
  const { port } = reservation;
  await reservation.close();
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "lan-restart-"));
  const fixture = desktop();
  const launch = () => createLanWebUiService({ workspace: fixture.workspaceDeps, dataDir, assets: () => new Map(), sendToRenderer: () => {}, log: () => {} });
  let service = launch();
  t.after(async () => {
    await service.dispose();
    fixture.workspace.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  const admin = (action) => service.admin(action);
  const start = () => admin({ kind: "start", address, port });
  const state = () => admin({ kind: "state" });
  const origin = `http://${address}:${port}`;
  return {
    origin, port, admin, start, state, file: join(dataDir, "lan-webui.json"),
    async restart(beforeLaunch = () => {}) {
      await service.dispose();
      await beforeLaunch();
      service = launch();
      return state();
    },
    async pair(label) {
      const { code } = await admin({ kind: "issueCode" });
      const response = await fetch(`${origin}/pair`, {
        method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ code: code.value, label }),
      });
      assert.equal(response.status, 200);
      const [cookie] = response.headers.getSetCookie()[0].split(";");
      const auth = { Cookie: cookie, Connection: "close" };
      // Keep the original cookie even after logout to test host-side revocation.
      const me = await fetch(`${origin}/v1/me`, { headers: auth }).then((response) => response.json());
      const phone = browser(origin);
      return { id: me.access.deviceId, auth, csrf: me.csrf, request: (method, path, body, extra) => phone.request(method, path, body, { ...auth, "X-CSRF-Token": me.csrf, ...extra }) };
    },
  };
}

test("enabled LAN WebUI and paired browsers survive a Desktop restart", async (t) => {
  const lan = await setup(t);
  assert.equal((await lan.state()).running, false);
  assert.equal((await lan.start()).origin, lan.origin);
  const phone = await lan.pair("iPhone");
  const tablet = await lan.pair("Tablet");
  const { code } = await lan.admin({ kind: "issueCode" });

  const restored = await lan.restart();
  assert.equal(restored.origin, lan.origin, "Desktop automatically listens at the same origin");
  assert.equal(restored.code, null, "unused pairing codes do not survive a restart");
  assert.deepEqual(restored.devices.map(({ id, label }) => [id, label]), [[phone.id, "iPhone"], [tablet.id, "Tablet"]]);
  assert.equal((await phone.request("GET", "/pair/status")).status, 200);
  assert.deepEqual((await phone.request("GET", "/v1/projects")).body.items.map(({ id }) => id), ["g-a", "g-b"]);
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" }, { "X-CSRF-Token": "" })).body.code, "CSRF");
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" })).status, 200, "the already-open page can still mutate");
  assert.equal((await browser(lan.origin).request("POST", "/pair", { code: code.value })).body.code, "PAIRING_CLOSED");
  const saved = await readFile(lan.file, "utf8");
  assert.equal(saved.includes(phone.auth.Cookie.split("=")[1]), false, "the browser bearer credential is not stored on disk");
  assert.equal(saved.includes(phone.csrf), false, "CSRF tokens are not stored on disk");

  await lan.admin({ kind: "revoke", id: phone.id });
  assert.equal((await tablet.request("POST", "/v1/logout", {})).status, 200);
  assert.equal((await lan.restart()).devices.length, 0);
  assert.equal((await phone.request("GET", "/v1/me")).status, 401);
  assert.equal((await tablet.request("GET", "/v1/me")).status, 401, "even the old cookie cannot sign back in");

  const replacement = await lan.pair("New phone");
  await lan.admin({ kind: "stop" });
  const stopped = await lan.restart();
  assert.equal(stopped.running, false);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.port, lan.port);
  assert.equal((await lan.start()).origin, lan.origin);
  assert.equal((await replacement.request("GET", "/v1/me")).status, 401, "explicit disable forgets all pairings");
});

test("a blocked restore retains the exact binding for retry and can be turned off", async (t) => {
  const lan = await setup(t);
  assert.equal((await lan.start()).origin, lan.origin);
  const remembered = await lan.pair("Tablet");
  let blocker;
  const blockPort = async () => { blocker = await reserve(lan.port); };
  try {
    const unavailable = await lan.restart(blockPort);
    assert.equal(unavailable.enabled, true);
    assert.equal(unavailable.running, false);
    assert.equal(unavailable.port, lan.port);
    assert.equal(unavailable.error, "PORT_IN_USE");
    assert.equal(unavailable.origin, null);
  } finally {
    await blocker?.close();
    blocker = null;
  }
  assert.equal((await lan.start()).origin, lan.origin);
  assert.equal((await remembered.request("GET", "/v1/me")).status, 200);
  try {
    assert.equal((await lan.restart(blockPort)).error, "PORT_IN_USE");
    assert.equal((await lan.admin({ kind: "stop" })).enabled, false, "an enabled but unavailable listener can be turned off");
  } finally {
    await blocker?.close();
  }
  assert.equal((await lan.restart()).running, false);
});

test("restore refuses an unsafe saved bind address instead of falling back", async (t) => {
  const lan = await setup(t);
  const unavailable = await lan.restart(() => writeFile(lan.file, JSON.stringify({
    version: 1, enabled: true, binding: { address: "0.0.0.0", port: lan.port }, devices: [],
  })));
  assert.equal(unavailable.error, "INVALID_ADDRESS");
  assert.equal(unavailable.origin, null);
  assert.equal(unavailable.running, false);
  const reservation = await reserve(lan.port);
  await reservation.close();
});

test("expired pairings cannot reopen a session after restart", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const lan = await setup(t);
  await lan.start();
  const phone = await lan.pair("iPhone");
  now += 29 * 86_400_000;
  assert.equal((await lan.restart()).devices.length, 1);
  assert.equal((await phone.request("GET", "/v1/me")).status, 200);
  now += 86_400_000;
  assert.equal((await phone.request("GET", "/v1/me")).status, 401);
  assert.equal((await lan.restart()).devices.length, 0);
  assert.equal((await phone.request("GET", "/v1/me")).status, 401);
});

test("a pairing is not issued if it cannot be saved", async (t) => {
  const lan = await setup(t);
  assert.equal((await lan.start()).origin, lan.origin);
  await rm(lan.file, { force: true });
  await mkdir(lan.file); // Atomic replacement cannot write over a directory.
  const { code } = await lan.admin({ kind: "issueCode" });
  const response = await fetch(`${lan.origin}/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.value }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.deepEqual((await lan.state()).devices, []);
});
