import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { browser, createLanServer, desktop } from "./helpers/lan-webui-fixture.mjs";

const allProjects = { projectScope: "all-local", temporary: false, chat: true, organize: true };

async function setup(t, grants, wrapHandler = (workspace) => workspace) {
  const fake = desktop();
  const server = createLanServer({ handler: wrapHandler(fake.workspace), assets: new Map([["/index.html", { type: "text/html", body: "<p>ok</p>" }]]) });
  const { port } = await server.start("127.0.0.1", 0);
  t.after(async () => {
    await server.stop();
    fake.workspace.dispose();
  });
  const origin = `http://127.0.0.1:${port}`;
  const phone = browser(origin);
  server.issueCode();
  const code = server.code().value;
  assert.equal((await phone.request("POST", "/pair", { code, label: "iPhone" })).status, 200);
  assert.equal((await phone.request("GET", "/pair/status")).body.state, "pending");
  assert.equal((await phone.request("GET", "/v1/me")).status, 401, "no data before Desktop confirms");
  assert.equal((await phone.request("GET", "/v1/projects")).status, 401);
  const [pending] = server.pending();
  assert.equal(pending.label, "iPhone");
  assert.throws(() => server.confirm(pending.id, { projectIds: ["g-a"], temporary: false, chat: true, organize: true }), { code: "INVALID_SCOPE" });
  assert.equal((await phone.request("GET", "/pair/status")).body.state, "pending");
  server.confirm(pending.id, grants);
  assert.equal((await phone.request("GET", "/pair/status")).body.state, "paired");
  await phone.signIn();
  return { ...fake, server, phone, origin };
}

test("pair, browse all local projects, create, chat and organize from a phone", async (t) => {
  const { phone, calls, turns, activeTurns, meta, server } = await setup(t, allProjects);

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

test("remote projects, temporary scope, mutation grants and request guards fail closed", async (t) => {
  const { phone, origin, server } = await setup(t, { ...allProjects, chat: false, organize: false });

  for (const path of ["/v1/sessions?projectId=g-r", "/v1/sessions/s-ssh", "/v1/sessions/s-ungrouped", "/v1/sessions/s-tmp", "/v1/sessions?projectId=__temporary__"]) {
    assert.equal((await phone.request("GET", path)).status, 404, path);
  }
  assert.equal((await phone.request("GET", "/v1/sessions/s-b1")).status, 200);
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" })).body.code, "FORBIDDEN");
  assert.equal((await phone.request("POST", "/v1/sessions/s-a1/turns", { text: "x" })).body.code, "FORBIDDEN");
  const session = (await phone.request("GET", "/v1/sessions?projectId=g-a")).body.items[0];
  assert.equal((await phone.request("POST", `/v1/sessions/${session.id}/organize`, { revision: session.revision, pinned: true })).body.code, "FORBIDDEN");

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
  const { phone, groups } = await setup(t, allProjects);
  assert.deepEqual((await phone.request("GET", "/v1/projects")).body.items.map((project) => project.id), ["g-a", "g-b"]);
  groups.push({ id: "g-a2", name: "Alpha", primaryPath: "/elsewhere/clone/a", roots: [{ path: "/elsewhere/clone/a", name: "a", position: 0 }], pinned: false, lastOpenedAt: 0, createdAt: 0, updatedAt: 0 });
  const projects = (await phone.request("GET", "/v1/projects")).body.items;
  assert.deepEqual(projects.map(({ id, label }) => [id, label]), [["g-a", "Alpha · work"], ["g-b", "Beta"], ["g-a2", "Alpha · clone"]]);
  assert.equal((await phone.request("GET", "/v1/sessions?projectId=g-a2")).status, 200);
});

test("temporary conversations need their own grant", async (t) => {
  const { phone, calls } = await setup(t, { ...allProjects, temporary: true, organize: false });
  assert.deepEqual((await phone.request("GET", "/v1/sessions?projectId=__temporary__")).body.items.map((s) => s.id), ["s-tmp"]);
  assert.equal((await phone.request("GET", "/v1/sessions/s-a1")).status, 200);
  const created = await phone.request("POST", "/v1/sessions", { projectId: null });
  assert.equal(created.status, 200);
  assert.deepEqual(calls.find(([c]) => c === "create")[1], [{}], "no project is inherited");
});

test("editing temporary and mutation grants discards stale results without pairing again", { timeout: 10_000 }, async (t) => {
  const prepared = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { phone, server, calls } = await setup(t, {
    ...allProjects, temporary: true,
  }, (workspace) => ({
    ...workspace,
    async handle(request, key) {
      const result = await workspace.handle(request, key);
      if (request.path === "/v1/sessions/s-tmp") {
        prepared.resolve();
        await release.promise;
      }
      return result;
    },
  }));
  const id = server.devices()[0].id;
  assert.throws(() => server.update(id, { projectIds: ["g-a"], temporary: false, chat: true, organize: true }), { code: "INVALID_SCOPE" });
  const mutation = { "Idempotency-Key": "device-edit-create" };
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" }, mutation)).status, 200);
  const stream = await phone.events("/v1/sessions/s-tmp/events", t.signal);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).done, false);
  const inFlight = phone.request("GET", "/v1/sessions/s-tmp");
  await prepared.promise;

  server.update(id, { ...allProjects, chat: false, organize: false });
  release.resolve();
  assert.deepEqual(await inFlight, { status: 409, body: { code: "CONFLICT" } });
  assert.equal((await reader.read()).done, true, "editing grants closes the subscribed stream");
  assert.equal((await phone.events("/v1/sessions/s-tmp/events", t.signal)).status, 404);
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-a" }, mutation)).status, 409);
  assert.equal(calls.filter(([channel]) => channel === "create").length, 1);

  const me = await phone.request("GET", "/v1/me");
  assert.deepEqual(me.body.access, { deviceId: id, ...allProjects, chat: false, organize: false });
  assert.deepEqual((await phone.request("GET", "/v1/projects")).body.items.map((project) => project.id), ["g-a", "g-b"]);
  assert.equal((await phone.request("GET", "/v1/sessions/s-tmp")).status, 404);
  assert.equal((await phone.request("POST", "/v1/sessions", { projectId: "g-b" })).status, 403);
});
