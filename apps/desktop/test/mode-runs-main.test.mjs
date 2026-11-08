import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createModeRunCoordinator, modeContinuationOrigin, modeContinuationRequest, MODE_CONTINUATION_CONTENT } =
  await import("../electron/main/runtime/mode-runs.ts");
const { createModeCatalogService } = await import("../electron/main/runtime/mode-catalog.ts");

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

function fixture({ open = null, claim, settle = { run: null, continue: false } } = {}) {
  const calls = [];
  const continuations = [];
  const aborts = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "modes.get") return { run: open };
      if (method === "modes.start" || method === "modes.claimTurn") {
        return claim ?? { claimed: true, run: run({ activeTurnId: params.turnId }), enteredStage: method === "modes.start", definition: staged };
      }
      if (method === "modes.settleTurn") return settle;
      if (method === "modes.control" || method === "modes.resolve") return settle;
      throw new Error(`unexpected ${method}`);
    },
  };
  const catalog = {
    async definition(id) {
      if (id === "feature") return staged;
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
    logger: { app() {} },
    isQuitting: () => false,
  });
  return { coordinator, calls, continuations, aborts };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("simple custom modes resolve their definition for prompt dispatch", async () => {
  const { coordinator } = fixture();
  assert.equal((await coordinator.definitionForPrompt("review")).id, "review");
  assert.equal((await coordinator.definitionForPrompt("review")).permission, "agent");
  await assert.rejects(coordinator.definitionForPrompt("missing"), { errorCode: "MODE_NOT_FOUND" });
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
