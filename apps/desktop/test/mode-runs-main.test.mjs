import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createModeRunCoordinator, modeContinuationOrigin, modeContinuationRequest, MODE_CONTINUATION_CONTENT } =
  await import("../electron/main/runtime/mode-runs.ts");
const { createModeCatalogService } = await import("../electron/main/runtime/mode-catalog.ts");
const { registerModesIpc } = await import("../electron/main/ipc/modes-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

const staged = {
  version: 1,
  id: "feature",
  label: "Feature",
  description: "",
  permission: "agent",
  prompt: "",
  source: "user",
  artifacts: [],
  budget: { maxTurns: 20, maxTokens: null },
  returnTo: "agent",
  stages: [{ id: "build", prompt: "", permission: "agent", loop: true, onEnter: [], onCompaction: [], exit: [] }],
};

function run(overrides = {}) {
  return {
    id: "run1",
    sessionId: "s1",
    modeId: "feature",
    snapshotHash: "h",
    input: "build it",
    stageId: "build",
    state: "running",
    revision: 3,
    roundsCompleted: 0,
    tokensUsed: 0,
    maxTurns: 20,
    maxTokens: null,
    artifactPaths: {},
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

function fixture({ open = null, claim, settle = { run: null, continue: false }, pendingReturn = null, catalogModes = null, featureReturnTo = "agent" } = {}) {
  const calls = [];
  const continuations = [];
  const aborts = [];
  const notices = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "modes.get") return { run: open };
      if (method === "modes.start" || method === "modes.claimTurn") {
        return claim ?? { claimed: true, run: run({ activeTurnId: params.turnId }), enteredStage: method === "modes.start", definition: staged };
      }
      if (method === "modes.settleTurn") return settle;
      if (method === "modes.control" || method === "modes.resolve" || method === "modes.update") return settle;
      if (method === "modes.settleReturn") {
        if (params.mode === undefined) return { pending: pendingReturn, applied: null };
        return { pending: null, applied: params.modeSnapshot ? params.mode : "agent" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const catalog = {
    async definition(id) {
      if (catalogModes && !catalogModes.includes(id)) return undefined;
      if (id === "feature") return { ...staged, returnTo: featureReturnTo };
      if (id === "review") return { ...staged, id: "review", stages: [] };
      return undefined;
    },
  };
  const coordinator = createModeRunCoordinator({
    getHost: () => host,
    catalog,
    startContinuation: async (sessionId, origin, content) => {
      continuations.push({ sessionId, origin, content });
    },
    abortTurn: async (sessionId) => {
      aborts.push(sessionId);
    },
    notifyTurn: async (sessionId, turnId, notice) => {
      notices.push({ sessionId, turnId, ...notice });
    },
    logger: { app() {} },
    isQuitting: () => false,
  });
  return { coordinator, calls, continuations, aborts, notices };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("simple custom modes resolve their definition for prompt dispatch", async () => {
  const { coordinator } = fixture();
  assert.equal((await coordinator.definitionForPrompt("review")).id, "review");
  assert.equal((await coordinator.definitionForPrompt("review")).permission, "agent");
  await assert.rejects(coordinator.definitionForPrompt("missing"), { errorCode: "MODE_NOT_FOUND" });
});

test("Agent and Plan dispatch use builtin runtime instructions without a snapshot", async () => {
  const coordinator = createModeRunCoordinator({
    catalog: { definition: async () => assert.fail("plain modes need no catalog snapshot") },
  });
  assert.equal(await coordinator.definitionForPrompt("agent"), undefined);
  assert.equal(await coordinator.definitionForPrompt("plan"), undefined);
});

test("a user turn in a simple mode claims nothing", async () => {
  const { coordinator, calls } = fixture();
  const prepared = await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "review", content: "x", origin: "user" });
  assert.equal(prepared, undefined);
  assert.equal(calls.length, 0);
});

test("the first user turn of a staged mode starts a run and carries the snapshot", async () => {
  const { coordinator, calls } = fixture();
  const prepared = await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "feature", content: "build it", origin: "user" });
  assert.deepEqual(calls.map((call) => call.method), ["modes.get", "modes.start"]);
  assert.deepEqual(calls[1].params, { sessionId: "s1", input: "build it", turnId: "t1" });
  assert.equal(prepared.definition.id, "feature");
  assert.deepEqual(prepared.modeTurn, {
    runId: "run1",
    stageId: "build",
    origin: "user",
    enteredStage: true,
    input: "build it",
    artifactPaths: {},
  });
  assert.equal(coordinator.claimedTurns().get("t1").runId, "run1");
});

test("an open run is claimed with its revision, and a host turn without a run fails closed", async () => {
  const { coordinator, calls } = fixture({ open: run() });
  await coordinator.prepareTurn({ sessionId: "s1", turnId: "t2", sessionMode: "feature", content: "more", origin: "host" });
  assert.deepEqual(calls[1], {
    method: "modes.claimTurn",
    params: { sessionId: "s1", runId: "run1", expectedRevision: 3, turnId: "t2", origin: "host" },
  });
  const empty = fixture();
  await assert.rejects(
    empty.coordinator.prepareTurn({ sessionId: "s1", turnId: "t3", sessionMode: "feature", content: "x", origin: "host" }),
    { errorCode: "MODE_RUN_NOT_FOUND" },
  );
});

test("a rejected claim runs a user turn plainly but refuses a continuation", async () => {
  const rejected = { claimed: false, run: null, enteredStage: false };
  const { coordinator } = fixture({ open: run({ activeTurnId: "other" }), claim: rejected });
  assert.equal(
    await coordinator.prepareTurn({ sessionId: "s1", turnId: "t4", sessionMode: "feature", content: "x", origin: "user" }),
    undefined,
  );
  await assert.rejects(
    coordinator.prepareTurn({ sessionId: "s1", turnId: "t5", sessionMode: "feature", content: "x", origin: "host" }),
    { errorCode: "MODE_CLAIM_REJECTED" },
  );
});

test("settling a claimed turn reports tokens and starts the Host continuation", async () => {
  const { coordinator, calls, continuations } = fixture({ settle: { run: run(), continue: true } });
  await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "feature", content: "x", origin: "user" });
  await coordinator.settleTurn("s1", "t1", {
    reason: "completed",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
  });
  const settle = calls.find((call) => call.method === "modes.settleTurn");
  assert.deepEqual(settle.params, { sessionId: "s1", runId: "run1", turnId: "t1", tokens: 125, outcome: "completed" });
  await tick();
  assert.deepEqual(continuations, [{ sessionId: "s1", origin: "host", content: MODE_CONTINUATION_CONTENT }]);
  // A second settlement of the same turn is a no-op.
  await coordinator.settleTurn("s1", "t1", { reason: "completed" });
  assert.equal(calls.filter((call) => call.method === "modes.settleTurn").length, 1);
});

test("an unclaimed turn settles nothing", async () => {
  const { coordinator, calls } = fixture({ settle: { run: null, continue: true } });
  await coordinator.settleTurn("s1", "unknown", { reason: "completed" });
  assert.equal(calls.length, 0);
});

test("stop aborts the claimed turn; approval continues with the approval origin", async () => {
  const { coordinator, aborts, continuations } = fixture({ settle: { run: run(), continue: true } });
  await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "feature", content: "x", origin: "user" });
  await coordinator.control({ sessionId: "s1", runId: "run1", expectedRevision: 3, action: "stop" });
  assert.deepEqual(aborts, ["s1"]);
  await coordinator.resolve({ sessionId: "s1", runId: "run1", expectedRevision: 4, action: "approve" });
  await tick();
  assert.ok(continuations.every((entry) => entry.origin === "approval"));
});

test("pause closes out the claimed turn once, without aborting it", async () => {
  const { coordinator, aborts, notices } = fixture({ settle: { run: run({ state: "paused", revision: 4 }), continue: false } });
  await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "feature", content: "x", origin: "user" });
  await coordinator.control({ sessionId: "s1", runId: "run1", expectedRevision: 3, action: "pause" });
  assert.deepEqual(aborts, []);
  assert.deepEqual(notices, [{ sessionId: "s1", turnId: "t1", runId: "run1", action: "closeout" }]);
  // An unchanged (already paused) run sends no second notice.
  await coordinator.control({ sessionId: "s1", runId: "run1", expectedRevision: 4, action: "pause" });
  assert.equal(notices.length, 1);
});

test("pause without a claimed turn sends no notice", async () => {
  const { coordinator, notices } = fixture({ settle: { run: run({ state: "paused", revision: 4 }), continue: false } });
  await coordinator.control({ sessionId: "s1", runId: "run1", expectedRevision: 3, action: "pause" });
  assert.deepEqual(notices, []);
});

test("remove releases the claimed turn to the return mode instead of aborting it", async () => {
  const { coordinator, aborts, notices, continuations } = fixture({
    settle: { run: run({ state: "stopped", revision: 4, finishedAt: "t" }), continue: false },
  });
  await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "feature", content: "x", origin: "user" });
  await coordinator.control({ sessionId: "s1", runId: "run1", expectedRevision: 3, action: "remove" });
  assert.deepEqual(aborts, []);
  assert.deepEqual(notices, [{ sessionId: "s1", turnId: "t1", runId: "run1", action: "release", mode: "agent" }]);
  await tick();
  assert.deepEqual(continuations, []);
});

test("an edit is forwarded to the Host as is and starts no turn", async () => {
  const { coordinator, calls, continuations } = fixture({ settle: { run: run({ input: "new", revision: 4 }), continue: false } });
  const request = { sessionId: "s1", runId: "run1", expectedRevision: 3, input: "new", budget: { maxTurns: 5, maxTokens: null } };
  const result = await coordinator.update(request);
  assert.deepEqual(calls, [{ method: "modes.update", params: request }]);
  assert.equal(result.run.input, "new");
  await tick();
  assert.deepEqual(continuations, []);
});

test("continuation authority survives only on the registered object", () => {
  const request = modeContinuationRequest({ sessionId: "s1", content: "x" }, "host");
  assert.equal(modeContinuationOrigin(request), "host");
  assert.equal(modeContinuationOrigin(structuredClone(request)), undefined);
  assert.equal(modeContinuationOrigin(JSON.parse(JSON.stringify(request))), undefined);
});

test("the catalog reads, validates, writes and deletes user modes in its own directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-modes-"));
  try {
    const changes = [];
    const catalog = createModeCatalogService({ dir, onChanged: (next) => changes.push(next) });
    const initial = await catalog.catalog();
    assert.deepEqual(initial.modes.slice(0, 3).map((mode) => mode.id), ["agent", "plan", "goal"]);
    assert.equal(initial.directory, dir);

    const source = "---\nname: review\nlabel: Review\npermission: contract\n---\nReview only.\n";
    assert.equal((await catalog.validate("review", source)).ok, true);
    const invalid = await catalog.validate("review", "---\nname: review\ntools: [Read]\n---\n");
    assert.equal(invalid.ok, false);
    await assert.rejects(catalog.write("plan", source), { errorCode: "MODE_ID_RESERVED" });
    await assert.rejects(catalog.write("review", "---\nname: review\npermission: auto\n---\n"), { errorCode: "MODE_DEFINITION_INVALID" });

    const written = await catalog.write("review", source);
    assert.ok(written.modes.some((mode) => mode.id === "review" && mode.available));
    assert.equal(await readFile(join(dir, "review", "mode.md"), "utf8"), source);
    assert.equal((await catalog.read("review")).source, source);
    assert.equal((await catalog.read("plan")).builtin, true);
    assert.equal((await catalog.snapshotFor("review")).permission, "contract");
    assert.equal(await catalog.snapshotFor("plan"), undefined);
    await assert.rejects(catalog.snapshotFor("missing"), { errorCode: "MODE_NOT_FOUND" });

    // A user document that claims a builtin id is reported, never loaded.
    await mkdir(join(dir, "goal"), { recursive: true });
    await writeFile(join(dir, "goal", "mode.md"), "---\nname: goal\n---\nmine\n");
    const refreshed = await catalog.refresh();
    assert.ok(refreshed.modes.some((mode) => mode.id === "goal" && mode.reserved));
    assert.equal((await catalog.definition("goal")).source, "builtin");

    const removed = await catalog.remove("review");
    assert.ok(!removed.modes.some((mode) => mode.id === "review"));
    assert.ok(changes.length >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a closed run hands the session its existing return mode with a snapshot (#2204)", async () => {
  const { coordinator, calls } = fixture({ pendingReturn: "review" });
  assert.equal(await coordinator.settleReturn("s1", run({ state: "finished" })), true);
  const settles = calls.filter((call) => call.method === "modes.settleReturn");
  assert.equal(settles.length, 2);
  assert.equal(settles[1].params.mode, "review");
  assert.equal(settles[1].params.modeSnapshot.id, "review");
});

test("a deleted return mode is settled without a snapshot, so the Host falls back to agent (#2204)", async () => {
  const { coordinator, calls } = fixture({ pendingReturn: "review", catalogModes: ["feature"] });
  assert.equal(await coordinator.settleReturn("s1", run({ state: "stopped" })), true);
  const last = calls.filter((call) => call.method === "modes.settleReturn").at(-1);
  assert.deepEqual(last.params, { sessionId: "s1", runId: "run1", mode: "review" });
});

test("an open run or a settled session asks the Host nothing more (#2204)", async () => {
  const open = fixture({ pendingReturn: "review" });
  assert.equal(await open.coordinator.settleReturn("s1", run({ state: "paused" })), false);
  assert.deepEqual(open.calls, []);
  const settled = fixture();
  assert.equal(await settled.coordinator.settleReturn("s1", run({ state: "finished" })), false);
  assert.equal(settled.calls.length, 1);
});

test("remove releases the turn to agent when the return mode was deleted (#2204)", async () => {
  const { coordinator, notices } = fixture({
    settle: { run: run({ state: "stopped", revision: 4, finishedAt: "t" }), continue: false },
    catalogModes: ["feature"],
    featureReturnTo: "review",
  });
  await coordinator.prepareTurn({ sessionId: "s1", turnId: "t1", sessionMode: "feature", content: "x", origin: "user" });
  await coordinator.control({ sessionId: "s1", runId: "run1", expectedRevision: 3, action: "remove" });
  assert.deepEqual(notices, [{ sessionId: "s1", turnId: "t1", runId: "run1", action: "release", mode: "agent" }]);
});

test("a user mode whose name differs from its directory is read, saved and deleted in place (#2202)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-modes-"));
  try {
    const source = "---\nname: review\nlabel: Review\npermission: contract\n---\nReview only.\n";
    await mkdir(join(dir, "my-review", "templates"), { recursive: true });
    await writeFile(join(dir, "my-review", "mode.md"), source);
    await writeFile(join(dir, "my-review", "templates", "notes.md"), "notes\n");
    const catalog = createModeCatalogService({ dir });

    const read = await catalog.read("review");
    assert.equal(read.source, source);
    assert.equal(read.filePath, join(dir, "my-review", "mode.md"));

    const edited = source.replace("Review only.", "Review twice.");
    assert.equal((await catalog.validate("review", edited)).ok, true);
    const written = await catalog.write("review", edited);
    assert.equal(await readFile(join(dir, "my-review", "mode.md"), "utf8"), edited);
    assert.equal(await readdir(dir).then((names) => names.join(",")), "my-review");
    assert.deepEqual(
      written.modes.filter((mode) => mode.id === "review").map((mode) => mode.available),
      [true],
    );

    const removed = await catalog.remove("review");
    assert.ok(!removed.modes.some((mode) => mode.id === "review"));
    assert.deepEqual(await readdir(dir), []);
    await assert.rejects(catalog.remove("review"), { errorCode: "MODE_NOT_FOUND" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new mode id never overwrites another mode that lives in that directory (#2202)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-modes-"));
  try {
    const other = "---\nname: other\npermission: contract\n---\nOther.\n";
    await mkdir(join(dir, "review"), { recursive: true });
    await writeFile(join(dir, "review", "mode.md"), other);
    const catalog = createModeCatalogService({ dir });

    const source = "---\nname: review\npermission: contract\n---\nReview.\n";
    assert.equal((await catalog.validate("review", source)).ok, false);
    await assert.rejects(catalog.write("review", source), { errorCode: "MODE_DEFINITION_INVALID" });
    assert.equal(await readFile(join(dir, "review", "mode.md"), "utf8"), other);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the catalog channel rescans the directory and announces the change (#2203)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-modes-"));
  try {
    const changes = [];
    const catalog = createModeCatalogService({ dir, onChanged: (next) => changes.push(next) });
    const handlers = new Map();
    registerModesIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn) }, catalog, runs: {} });
    const readCatalog = () => handlers.get(IPC.invoke.modesCatalog)();
    const write = async (name, label) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "mode.md"), `---\nname: ${name}\nlabel: ${label}\npermission: contract\n---\nx\n`);
    };
    await write("review", "First");
    assert.equal((await readCatalog()).modes.find((mode) => mode.id === "review")?.label, "First");

    await write("review", "Second");
    await write("debug", "Debug");
    const rescanned = await readCatalog();
    assert.equal(rescanned.modes.find((mode) => mode.id === "review")?.label, "Second");
    assert.ok(rescanned.modes.some((mode) => mode.id === "debug"));
    assert.equal((await catalog.definition("debug"))?.label, "Debug");
    assert.equal(changes.at(-1), rescanned);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
