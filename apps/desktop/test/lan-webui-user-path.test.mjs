import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { browser, createLanServer, desktop } from "./helpers/lan-webui-fixture.mjs";

async function setup(t, { wrapHandler = (workspace) => workspace, now } = {}) {
  const fake = desktop();
  const server = createLanServer({ handler: wrapHandler(fake.workspace), now, assets: new Map([["/index.html", { type: "text/html", body: "<p>ok</p>" }]]) });
  const { port } = await server.start("127.0.0.1", 0);
  t.after(async () => {
    await server.stop();
    fake.workspace.dispose();
  });
  const origin = `http://127.0.0.1:${port}`;
  const phone = browser(origin);
  assert.equal((await phone.request("GET", "/v1/me")).status, 401);
  assert.equal((await phone.request("GET", "/pair/status")).status, 401);
  assert.equal((await phone.request("GET", "/v1/projects")).status, 401);
  const { value: code } = server.issueCode();
  assert.deepEqual(await phone.request("POST", "/pair", { code, label: "iPhone" }), { status: 200, body: { state: "paired" } });
  assert.equal(server.code(), null);
  assert.equal(server.devices()[0].label, "iPhone");
  await phone.signIn();
  assert.deepEqual(await phone.request("GET", "/pair/status"), { status: 200, body: { state: "paired" } });
  return { ...fake, server, phone, origin };
}

test("pair, browse all local projects, create, chat and organize from a phone", async (t) => {
  const { phone, calls, turns, activeTurns, meta, server } = await setup(t);

  // No project choices are required; the SSH-backed group stays hidden.
  const projects = await phone.request("GET", "/v1/projects?q=");
  assert.deepEqual(projects.body.items.map((p) => p.id), ["g-a", "g-b"]);

  // A session on a secondary root belongs to its logical group.
  const beta = await phone.request("GET", "/v1/sessions?projectId=g-b");
  assert.deepEqual(beta.body.items.map((s) => s.id), ["s-b1"]);
  const alpha = await phone.request("GET", "/v1/sessions?projectId=g-a");
  assert.deepEqual(alpha.body.items.map((s) => [s.id, s.readOnly]), [["s-a1", false], ["s-plan", true]]);

  // Conversation projection: no tool output, no nested subagent rows.
  const chat = await phone.request("GET", "/v1/sessions/s-a1");
  assert.deepEqual(chat.body.messages.items.map((m) => [m.role, m.text]), [["user", "hello"], ["assistant", "hi there"], ["tool", "Bash"]]);
  assert.equal(JSON.stringify(chat.body).includes("/secret/path"), false);
  assert.equal((await phone.request("GET", "/v1/sessions/s-b1")).body.waiting, "approval");
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-r" })).status, 404);

  // New session in the explicit project; a double tap with the same key creates one.
  const key = "create-key-123";
  const first = await phone.request("POST", "/v1/sessions", { projectId: "g-b" }, { "Idempotency-Key": key });
  const again = await phone.request("POST", "/v1/sessions", { projectId: "g-b" }, { "Idempotency-Key": key });
  assert.equal(first.body.id, again.body.id);
  assert.equal(calls.filter(([c]) => c === "create").length, 1);
  assert.deepEqual(calls.find(([c]) => c === "create")[1], [{ projectPath: "/work/b" }]);

  // Send runs under a non-owner principal; busy sessions reject unless queued.
  const sent = await phone.request("POST", `/v1/sessions/${first.body.id}/turns`, { text: "hi" }, { "Idempotency-Key": "send-key-0001" });
  assert.equal(sent.status, 200);
  assert.deepEqual(turns[0].principal, { subject: turns[0].principal.subject, roles: ["viewer", "controller"], pairedDevice: false });
  const busy = await phone.request("POST", `/v1/sessions/${first.body.id}/turns`, { text: "again" });
  assert.deepEqual([busy.status, busy.body.code], [409, "BUSY"]);
  const queued = await phone.request("POST", `/v1/sessions/${first.body.id}/turns`, { text: "later", queue: true });
  const conversation = await phone.request("GET", `/v1/sessions/${first.body.id}`);
  assert.deepEqual(conversation.body.queue.map((q) => q.text), ["later"]);
  assert.equal((await phone.request("POST", `/v1/turns/${queued.body.id}:cancel`, { sessionId: first.body.id })).body.canceled, true);
  const runId = activeTurns.get(first.body.id);
  assert.equal((await phone.request("POST", `/v1/turns/${encodeURIComponent(runId)}:interrupt`, { sessionId: first.body.id })).body.stopped, true);

  // Read-only sessions cannot be sent to from the browser.
  assert.equal((await phone.request("POST", "/v1/sessions/s-plan/turns", { text: "x" })).body.code, "READ_ONLY");

  // Organize with optimistic revisions; a stale revision is a conflict.
  const before = (await phone.request("GET", "/v1/sessions?projectId=g-a")).body.items.find((s) => s.id === "s-a1");
  assert.equal((await phone.request("POST", "/v1/sessions/s-a1/organize", { revision: before.revision, pinned: true })).status, 200);
  assert.equal(meta.sessionMeta["s-a1"].pinned, true);
  const stale = await phone.request("POST", "/v1/sessions/s-a1/organize", { revision: before.revision, archived: true });
  assert.deepEqual([stale.status, stale.body.code], [409, "CONFLICT"]);
  const current = (await phone.request("GET", "/v1/sessions?projectId=g-a")).body.items.find((s) => s.id === "s-a1");
  await phone.request("POST", "/v1/sessions/s-a1/organize", { revision: current.revision, name: "Fix login flow" });
  assert.deepEqual(calls.find(([c]) => c === "rename")[1], ["s-a1", "Fix login flow"]);
  assert.equal(meta.sessionMeta["s-a1"].manualTitle, true);

  // Archive is reversible and hides the session from the default list.
  const renamed = (await phone.request("GET", "/v1/sessions?projectId=g-a")).body.items.find((s) => s.id === "s-a1");
  await phone.request("POST", "/v1/sessions/s-a1/organize", { revision: renamed.revision, archived: true });
  assert.deepEqual((await phone.request("GET", "/v1/sessions?projectId=g-a")).body.items.map((s) => s.id), ["s-plan"]);
  assert.deepEqual((await phone.request("GET", "/v1/sessions?projectId=g-a&archived=1")).body.items.map((s) => s.id), ["s-a1"]);
  const project = (await phone.request("GET", "/v1/projects")).body.items[0];
  await phone.request("POST", "/v1/projects/g-a/organize", { revision: project.revision, pinned: true });
  assert.equal(meta.projectMeta["/work/a"].pinned, true);
  assert.ok(calls.some(([c]) => c === "notify"), "Desktop was told to refresh without navigating");

  // Revoking the device ends access immediately.
  server.revoke(server.devices()[0].id);
  assert.equal((await phone.request("GET", "/v1/projects")).status, 401);
});

test("remote projects, unregistered sessions and transport guards stay restricted", async (t) => {
  const { phone, origin, server } = await setup(t);

  for (const path of ["/v1/sessions?projectId=g-r", "/v1/sessions/s-ssh", "/v1/sessions/s-ungrouped"]) {
    assert.equal((await phone.request("GET", path)).status, 404, path);
  }
  assert.equal((await phone.request("GET", "/v1/sessions/s-b1")).status, 200);
  assert.equal((await phone.request("POST", "/v1/permissions/approve", {})).status, 404);

  // Missing CSRF, foreign Origin and a wrong Host are rejected.
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" }, { "X-CSRF-Token": "" })).body.code, "CSRF");
  assert.equal((await phone.request("GET", "/v1/projects", null, { Origin: "http://evil.example" })).body.code, "FORBIDDEN_ORIGIN");
  // fetch() refuses to send a custom Host, so use a raw request for rebinding.
  const rebinding = await new Promise((resolve, reject) => {
    const url = new URL(`${origin}/v1/projects`);
    request({ host: url.hostname, port: url.port, path: url.pathname, headers: { Host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject).end();
  });
  assert.equal(rebinding, 403);

  // A wrong code burns attempts and then closes pairing.
  server.issueCode();
  const stranger = browser(origin);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await stranger.request("POST", "/pair", { code: "000000x", label: "x" })).body.code, "PAIRING_FAILED");
  }
  assert.equal(server.code(), null);
  assert.equal((await stranger.request("POST", "/pair", { code: "123456", label: "x" })).body.code, "PAIRING_CLOSED");

  // Stopping signs every device out.
  await server.stop();
  await server.start("127.0.0.1", 0);
  assert.equal(server.devices().length, 0);
});

test("a paired device sees newly added projects and distinguishes duplicate names without paths", async (t) => {
  const { phone, groups } = await setup(t);
  assert.deepEqual((await phone.request("GET", "/v1/projects")).body.items.map((project) => project.id), ["g-a", "g-b"]);
  groups.push({ id: "g-a2", name: "Alpha", primaryPath: "/elsewhere/clone/a", roots: [{ path: "/elsewhere/clone/a", name: "a", position: 0 }], pinned: false, lastOpenedAt: 0, createdAt: 0, updatedAt: 0 });
  const projects = (await phone.request("GET", "/v1/projects")).body.items;
  assert.deepEqual(projects.map(({ id, label }) => [id, label]), [["g-a", "Alpha · work"], ["g-b", "Beta"], ["g-a2", "Alpha · clone"]]);
  assert.equal((await phone.request("GET", "/v1/sessions?projectId=g-a2")).status, 200);
});

test("pairing grants temporary conversations without a separate permission", async (t) => {
  const { phone, calls, turns } = await setup(t);
  assert.deepEqual((await phone.request("GET", "/v1/sessions?projectId=__temporary__")).body.items.map((s) => s.id), ["s-tmp"]);
  assert.equal((await phone.request("GET", "/v1/sessions/s-a1")).status, 200);
  const created = await phone.request("POST", "/v1/sessions", { projectId: null });
  assert.equal(created.status, 200);
  assert.deepEqual(calls.find(([c]) => c === "create")[1], [{}], "no project is inherited");
  assert.equal((await phone.request("POST", `/v1/sessions/${created.body.id}/turns`, { text: "hello" })).status, 200);
  assert.equal(turns[0].params.sessionId, created.body.id);
});

test("pairing codes expire and exactly one redemption creates a device", async (t) => {
  let time = Date.now();
  const { server, origin } = await setup(t, { now: () => time });
  const expired = server.issueCode();
  time = expired.expiresAt;
  assert.equal((await browser(origin).request("POST", "/pair", { code: expired.value })).body.code, "PAIRING_CLOSED");

  const { value: code } = server.issueCode();
  const redeem = () => fetch(`${origin}/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
  });
  const responses = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
  const accepted = responses.find((response) => response.ok);
  const [cookie] = accepted.headers.getSetCookie();
  assert.match(cookie, /^pi_lan=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  assert.equal(responses.find((response) => !response.ok).headers.getSetCookie().length, 0);
  assert.equal(server.devices().length, 2);
});

test("removing a device closes its stream and discards in-flight results", { timeout: 10_000 }, async (t) => {
  const prepared = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { phone, server, calls } = await setup(t, {
    wrapHandler: (workspace) => ({
      ...workspace,
      async handle(request, key) {
        const result = await workspace.handle(request, key);
        if (request.path === "/v1/sessions/s-tmp") {
          prepared.resolve();
          await release.promise;
        }
        return result;
      },
    }),
  });
  const id = server.devices()[0].id;
  const mutation = { "Idempotency-Key": "device-edit-create" };
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" }, mutation)).status, 200);
  const stream = await phone.events("/v1/sessions/s-tmp/events", t.signal);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).done, false);
  const inFlight = phone.request("GET", "/v1/sessions/s-tmp");
  await prepared.promise;

  server.revoke(id);
  release.resolve();
  assert.deepEqual(await inFlight, { status: 401, body: { code: "UNAUTHORIZED" } });
  assert.equal((await reader.read()).done, true, "removing the device closes the subscribed stream");
  assert.equal((await phone.events("/v1/sessions/s-tmp/events", t.signal)).status, 401);
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" }, mutation)).status, 401);
  assert.equal(calls.filter(([channel]) => channel === "create").length, 1);
  assert.equal((await phone.request("GET", "/v1/projects")).status, 401);
});

test("direct pairing respects the device limit without disconnecting other devices", async (t) => {
  const { server, origin, phone } = await setup(t);
  for (let index = 1; index < 16; index += 1) {
    const { value: code } = server.issueCode();
    assert.equal((await browser(origin).request("POST", "/pair", { code, label: `Device ${index}` })).status, 200);
  }
  const { value: code } = server.issueCode();
  const next = browser(origin);
  assert.deepEqual(await next.request("POST", "/pair", { code }), { status: 429, body: { code: "RATE_LIMITED" } });
  assert.equal((await next.request("GET", "/v1/me")).status, 401);
  server.revoke(server.devices()[1].id);
  assert.equal((await next.request("POST", "/pair", { code })).status, 200);
  assert.equal((await phone.request("GET", "/v1/projects")).status, 200);
  assert.equal(server.devices().length, 16);
});

test("the recent list spans every visible scope, lifts running work and names each project", async (t) => {
  const { phone, activeTurns, meta } = await setup(t);
  activeTurns.set("s-plan", "turn-plan");

  const recent = await phone.request("GET", "/v1/sessions?q=");
  assert.equal(recent.status, 200);
  // Running first, then most recent; SSH and unregistered sessions stay hidden.
  assert.deepEqual(recent.body.items.map((s) => s.id), ["s-plan", "s-tmp", "s-b1", "s-a1"]);
  assert.deepEqual(
    Object.fromEntries(recent.body.items.map((s) => [s.id, s.projectLabel])),
    { "s-plan": "Alpha", "s-tmp": null, "s-b1": "Beta", "s-a1": "Alpha" },
  );
  assert.equal(recent.body.items[0].status, "running");

  // Title search works across projects.
  assert.deepEqual((await phone.request("GET", "/v1/sessions?q=login")).body.items.map((s) => s.id), ["s-a1"]);

  // The conversation names its project, so a deep link still shows where it lives.
  assert.equal((await phone.request("GET", "/v1/sessions/s-b1")).body.session.projectLabel, "Beta");

  // Sessions of an archived project drop out of the recent list, not out of their project.
  const beta = (await phone.request("GET", "/v1/projects")).body.items.find((p) => p.id === "g-b");
  assert.equal((await phone.request("POST", "/v1/projects/g-b/organize", { revision: beta.revision, archived: true })).status, 200);
  assert.ok(meta.projectMeta["/work/b"].archived);
  assert.deepEqual((await phone.request("GET", "/v1/sessions")).body.items.map((s) => s.id), ["s-plan", "s-tmp", "s-a1"]);
  assert.deepEqual((await phone.request("GET", "/v1/sessions?projectId=g-b")).body.items.map((s) => s.id), ["s-b1"]);

  // An unknown explicit project is still not found.
  assert.equal((await phone.request("GET", "/v1/sessions?projectId=nope")).status, 404);
});

test("a paired browser can switch only to configured chat models in an idle local session", async (t) => {
  const { phone, origin, activeTurns, queue, sessions, calls } = await setup(t);
  const path = "/v1/sessions/s-a1";
  assert.equal((await browser(origin).request("GET", `${path}/models`)).status, 401);
  const { status, body: catalog } = await phone.request("GET", `${path}/models`);
  assert.equal(status, 200);
  assert.deepEqual(catalog.items, [
    { providerId: "local-ai", modelId: "swift-chat", label: "Swift", providerLabel: "Local AI" },
    { providerId: "local-ai", modelId: "steady-chat", label: "Steady", providerLabel: "Local AI" },
  ]);
  assert.equal(catalog.selected, null);
  const choose = { providerId: "local-ai", modelId: "steady-chat", revision: catalog.revision };
  assert.equal((await phone.request("POST", `${path}/model`, choose, { "X-CSRF-Token": "" })).status, 403);
  assert.equal((await phone.request("POST", `${path}/model`, { ...choose, mode: "plan" })).body.code, "INVALID_ARGUMENT");
  assert.equal((await phone.request("POST", `${path}/model`, { ...choose, modelId: "unconfigured-chat" })).body.code, "MODEL_UNAVAILABLE");
  assert.equal((await phone.request("POST", "/v1/sessions/s-plan/model", choose)).body.code, "READ_ONLY");
  assert.equal((await phone.request("POST", "/v1/sessions/s-ssh/model", choose)).status, 404);
  activeTurns.set("s-a1", "active-turn");
  assert.equal((await phone.request("POST", `${path}/model`, choose)).body.code, "MODEL_BUSY");
  activeTurns.delete("s-a1");
  queue.set("s-a1", [{ id: "queued-turn", content: "next" }]);
  assert.equal((await phone.request("POST", `${path}/model`, choose)).body.code, "MODEL_BUSY");
  queue.delete("s-a1");

  assert.deepEqual(await phone.request("POST", `${path}/model`, choose), { status: 200, body: { ok: true } });
  assert.equal((await phone.request("GET", path)).body.modelLabel, "steady-chat");
  assert.deepEqual((await phone.request("GET", `${path}/models`)).body.selected, { providerId: "local-ai", modelId: "steady-chat" });
  assert.equal((await phone.request("POST", `${path}/model`, { ...choose, modelId: "swift-chat" })).body.code, "CONFLICT");
  assert.equal(calls.filter(([channel]) => channel === "configure").length, 1);
  assert.equal(sessions.find(({ id }) => id === "s-a1").mode, "agent");
  assert.equal(sessions.find(({ id }) => id === "s-tmp").modelId, undefined);
});
