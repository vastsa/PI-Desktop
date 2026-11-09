/**
 * Renderer rules for user-definable modes (ADR mode-definitions): what the
 * composer picker offers, what the run status bar says and sends, how the
 * plan pipeline treats Goal and user modes, what Settings → Modes creates,
 * and that a custom mode id survives the renderer's normalization paths.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { register } from "node:module";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const picker = await import("../src/features/modes/mode-picker-model.ts");
const runModel = await import("../src/features/modes/mode-run-model.ts");
const store = await import("../src/features/modes/modes-store.ts");
const modesApi = await import("../src/features/modes/modes-api.ts");
const settingsModel = await import("../src/features/modes/modes-settings-model.ts");
const planning = await import("../src/stores/helpers/planning-projection.ts");
const safety = await import("../src/lib/remote-session-safety.ts");

const t = (key) => `t:${key}`;

function entry(id, overrides = {}) {
  return {
    id,
    label: id[0].toUpperCase() + id.slice(1),
    description: "",
    source: "user",
    staged: false,
    available: true,
    ...overrides,
  };
}

const CATALOG = {
  directory: "/home/user/.pi/modes",
  modes: [
    entry("agent", { source: "builtin", label: "Agent" }),
    entry("plan", { source: "builtin", label: "Plan" }),
    entry("goal", { source: "builtin", label: "Goal", staged: true }),
    entry("review", { label: "Code review", description: "Review the diff", staged: true }),
    entry("broken", { label: "Broken", available: false }),
    entry("plan", { label: "My plan", reserved: true, available: false }),
    entry("drafting", { label: "  ", description: "Write drafts" }),
  ],
  diagnostics: [
    { modeId: "broken", errors: ["stages.work.exit[0]: unknown action \"deploy\"", "second"], warnings: [] },
    { modeId: "plan", errors: ["name: \"plan\" is a builtin mode"], warnings: [] },
  ],
};

const RUN = {
  id: "run-1",
  sessionId: "session-1",
  modeId: "review",
  snapshotHash: "hash",
  input: "review it",
  stageId: "design",
  state: "running",
  revision: 7,
  roundsCompleted: 2,
  tokensUsed: 10,
  maxTurns: 20,
  maxTokens: null,
  artifactPaths: {},
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};

test("the picker lists available and unavailable user modes after the builtins, never a reserved document", () => {
  const entries = picker.userModePickerEntries(CATALOG);
  assert.deepEqual(entries.map((item) => item.id), ["review", "broken", "drafting"]);
  const review = entries.find((item) => item.id === "review");
  assert.equal(review.label, "Code review");
  assert.equal(review.description, "Review the diff");
  assert.equal(review.available, true);
  assert.equal(review.reason, undefined);
  // An unavailable mode stays listed with the first diagnostic as its reason.
  const broken = entries.find((item) => item.id === "broken");
  assert.equal(broken.available, false);
  assert.equal(broken.reason, "stages.work.exit[0]: unknown action \"deploy\"");
  // A blank label falls back to the id rather than an empty row.
  assert.equal(entries.find((item) => item.id === "drafting").label, "drafting");
  assert.deepEqual(picker.userModePickerEntries(null), []);
});

test("cycling covers the builtins and the available user modes only", () => {
  const cycle = picker.pickerModeCycle(CATALOG);
  assert.deepEqual(cycle, ["agent", "plan", "goal", "review", "drafting"]);
  assert.equal(picker.nextPickerMode("goal", cycle), "review");
  assert.equal(picker.nextPickerMode("drafting", cycle), "agent");
  // A mode that left the catalog starts the cycle over.
  assert.equal(picker.nextPickerMode("broken", cycle), "agent");
  assert.deepEqual(picker.pickerModeCycle(null), ["agent", "plan", "goal"]);
});

test("labels are localized for builtins and written as-is for custom ids", () => {
  assert.equal(picker.modeDisplayLabel(t, "plan", CATALOG), "t:settings.modePlan");
  assert.equal(picker.modeDisplayLabel(t, "goal", CATALOG), "t:settings.modeGoal");
  assert.equal(picker.modeDisplayLabel(t, "review", CATALOG), "Code review");
  // No `${mode}.xxx` key is built for an id the catalog does not know.
  assert.equal(picker.modeDisplayLabel(t, "gone-mode", CATALOG), "gone-mode");
  assert.equal(picker.modeDisplayLabel(t, "review", null), "review");
});

test("the composer picker reads labels from the catalog and keeps Plan-only planning copy", () => {
  const source = fs.readFileSync(
    new URL("../src/features/chat/composer/ComposerModePicker.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\$\{mode\}\./);
  assert.doesNotMatch(source, /MODE_LABEL_KEYS\[/);
  assert.match(source, /const planningCopy = t\("plan\.planning"\)/);
});

test("a pushed catalog is normalized and a malformed one is dropped", () => {
  const parsed = modesApi.parseModeCatalog({
    directory: "/m",
    modes: [{ id: "x", label: "X", source: "user", available: true }, { id: 3 }],
    diagnostics: [{ modeId: "x", errors: ["e", 4] }, { errors: [] }],
  });
  assert.deepEqual(parsed, {
    directory: "/m",
    modes: [{ id: "x", label: "X", description: "", source: "user", staged: false, available: true }],
    diagnostics: [{ modeId: "x", errors: ["e"], warnings: [] }],
  });
  assert.equal(modesApi.parseModeCatalog({ modes: [] }), null);
  assert.equal(modesApi.parseModesChangedEvent({ sessionId: "s", run: { id: "r" } }), null);
  assert.deepEqual(modesApi.parseModesChangedEvent({ sessionId: "s", run: null }), { sessionId: "s", run: null });
});

test("every run state has its own label and the controls the run allows", () => {
  const cases = [
    [{ state: "running" }, "running", { pause: true, resume: false, stop: true, approve: false, reject: false }],
    [{ state: "waiting", waitReason: "approval" }, "waitingApproval", { pause: true, resume: false, stop: true, approve: true, reject: true }],
    [{ state: "waiting", waitReason: "retries" }, "blocked", { pause: true, resume: false, stop: true, approve: false, reject: false }],
    [{ state: "waiting", waitReason: "turn_end" }, "waitingInput", { pause: true, resume: false, stop: true, approve: false, reject: false }],
    [{ state: "waiting", waitReason: "error" }, "error", { pause: true, resume: false, stop: true, approve: false, reject: false }],
    [{ state: "paused" }, "paused", { pause: false, resume: true, stop: true, approve: false, reject: false }],
    [{ state: "budget_exhausted" }, "budgetExhausted", { pause: false, resume: true, stop: true, approve: false, reject: false }],
  ];
  const labels = new Set();
  for (const [run, key, controls] of cases) {
    assert.equal(runModel.modeRunStateKey(run), key, JSON.stringify(run));
    assert.deepEqual(runModel.modeRunControls(run), controls, key);
    labels.add(runModel.MODE_RUN_STATE_LABEL_KEYS[key]);
  }
  assert.equal(labels.size, cases.length);
  assert.deepEqual(runModel.modeRunControls({ state: "finished" }).stop, false);
});

test("control and resolve requests carry the revision the user acted on", () => {
  assert.deepEqual(runModel.modeControlRequest(RUN, "pause"), {
    sessionId: "session-1",
    runId: "run-1",
    expectedRevision: 7,
    action: "pause",
  });
  assert.deepEqual(runModel.modeResolveRequest({ ...RUN, revision: 9 }, "approve"), {
    sessionId: "session-1",
    runId: "run-1",
    expectedRevision: 9,
    action: "approve",
  });
  assert.deepEqual(runModel.modeRunRounds(RUN), { completed: 2, max: "20" });
  assert.deepEqual(runModel.modeRunRounds({ roundsCompleted: 3, maxTurns: null }), { completed: 3, max: "∞" });
});

test("mode failures are named in the user's language", () => {
  const failure = (code, message = "raw") => Object.assign(new Error(message), { code });
  assert.equal(runModel.modeErrorMessage(t, failure("MODE_RUN_ACTIVE")), "t:modes.errors.runActive");
  assert.equal(runModel.modeErrorMessage(t, failure("MODE_NOT_FOUND")), "t:modes.errors.notFound");
  assert.equal(
    runModel.modeErrorMessage(t, failure("MODE_DEFINITION_INVALID", "stages: unknown key")),
    "t:modes.errors.definitionInvalid stages: unknown key",
  );
  assert.equal(runModel.modeErrorMessage(t, failure("SOMETHING_ELSE", "kept")), "kept");
  for (const key of runModel.MODE_ERROR_MESSAGE_KEYS) assert.match(key, /^modes\.errors\./);
});

test("a run read that a push overtakes is dropped, and a closing push is reported", async () => {
  const sessionId = "store-session";
  let release;
  const pending = store.loadModeRun(sessionId, () => new Promise((resolve) => { release = resolve; }));
  const pushed = { ...RUN, sessionId, revision: 8, state: "paused" };
  assert.deepEqual(store.applyModeRun(sessionId, pushed), { closed: false });
  release({ ...RUN, sessionId, revision: 7 });
  await pending;
  assert.equal(store.useModesStore.getState().runs[sessionId].revision, 8);
  assert.equal(store.openModeRun(sessionId).state, "paused");
  // An older revision of the same run never replaces a newer one.
  store.applyModeRun(sessionId, { ...pushed, revision: 5, state: "running" });
  assert.equal(store.useModesStore.getState().runs[sessionId].state, "paused");
  assert.deepEqual(store.applyModeRun(sessionId, { ...pushed, revision: 9, state: "stopped" }), { closed: true });
  assert.equal(store.openModeRun(sessionId), null);
});

test("a catalog push during the startup read wins", async () => {
  let release;
  const pending = store.loadModeCatalog(() => new Promise((resolve) => { release = resolve; }));
  store.setModeCatalog({ ...CATALOG, directory: "/pushed" });
  release({ ...CATALOG, directory: "/stale" });
  await pending;
  assert.equal(store.useModesStore.getState().catalog.directory, "/pushed");
});

test("Goal and user modes are never shown as Plan-style planning and keep their mode", () => {
  const agent = () => "agent";
  const plan = () => "plan";
  // Plan keeps the ADR 0053 behavior.
  assert.equal(planning.visiblePlanningState("plan", "planning", false), "planning");
  assert.equal(planning.modeAfterPlanningUpdate("agent", "planning", plan), "plan");
  assert.equal(planning.modeAfterPlanningUpdate("plan", "inactive", agent), "agent");
  // host-core answers `planning` for any non-Agent session.
  for (const mode of ["goal", "review"]) {
    assert.equal(planning.visiblePlanningState(mode, "planning", false), "inactive", mode);
    assert.equal(planning.visiblePlanningState(mode, "awaiting_approval", false), "inactive", mode);
    assert.equal(planning.modeAfterPlanningUpdate(mode, "planning", plan), mode, mode);
  }
  // A legacy Goal proposal still awaiting approval stays resolvable.
  assert.equal(planning.visiblePlanningState("goal", "awaiting_approval", true), "awaiting_approval");
  // `inactive` means the Host moved the session back to Agent.
  assert.equal(planning.modeAfterPlanningUpdate("goal", "inactive", agent), "agent");
});

test("Settings → Modes starts documents with valid ids and an exact name", () => {
  assert.equal(settingsModel.newModeIdProblem("Bad Id", CATALOG), "invalid");
  assert.equal(settingsModel.newModeIdProblem("goal", CATALOG), "reserved");
  assert.equal(settingsModel.newModeIdProblem("review", CATALOG), "taken");
  assert.equal(settingsModel.newModeIdProblem("fresh-mode", CATALOG), null);

  const template = settingsModel.simpleModeTemplate("fresh-mode", {
    description: "Für: \"Zitate\"",
    prompt: "Work carefully.",
  });
  assert.equal(
    template,
    '---\nname: fresh-mode\nlabel: "Fresh mode"\ndescription: "Für: \\"Zitate\\""\npermission: agent\n---\nWork carefully.\n',
  );

  const goal = "---\nname: goal\nlabel: Goal\nstages:\n  work:\n    name: inner\n---\nBody name: stays\n";
  assert.equal(
    settingsModel.duplicateModeSource(goal, "my-goal"),
    "---\nname: my-goal\nlabel: Goal\nstages:\n  work:\n    name: inner\n---\nBody name: stays\n",
  );
  assert.equal(
    settingsModel.duplicateModeSource("---\nlabel: X\n---\nbody", "copy"),
    "---\nname: copy\nlabel: X\n---\nbody",
  );
  assert.equal(settingsModel.duplicateModeSource("just a prompt", "copy"), "---\nname: copy\n---\njust a prompt");

  assert.deepEqual(
    settingsModel.settingsModeEntries(CATALOG).map((item) => `${item.source}:${item.id}`),
    ["builtin:agent", "builtin:plan", "builtin:goal", "user:broken", "user:drafting", "user:plan", "user:review"],
  );
  assert.deepEqual(settingsModel.modeEntryDiagnostic(CATALOG, { id: "plan", source: "builtin" }).errors, []);
  assert.deepEqual(
    settingsModel.rejectedValidation(Object.assign(new Error("x"), { details: { errors: ["a"], warnings: ["w"] } })),
    { ok: false, errors: ["a"], warnings: ["w"] },
  );
});

function loadApi(bridge) {
  const source = fs.readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const imports = {
    "@pi-desktop/shared": shared,
    "./plan-history": { projectPlanHistory: (messages) => messages },
    "./remote-session-safety": safety,
    "./remote-ipc-safety": { guardRemoteInvocation() {} },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", "window", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
    { piDesktop: bridge },
  );
  return module.exports;
}

test("a custom mode id survives the session list and detail reads; the default mode stays builtin", async () => {
  const session = { id: "s1", title: "Review", mode: "review-flow", source: "desktop" };
  const { api, normalizeSettings } = loadApi({
    invoke: async (channel) => {
      if (channel === shared.IPC.invoke.sessionList) return { ok: true, data: { sessions: [session, { ...session, id: "s2", mode: "Not A Mode" }] } };
      if (channel === shared.IPC.invoke.sessionGet) return { ok: true, data: { session: { ...session, messages: [] } } };
      throw new Error(`unexpected channel ${channel}`);
    },
  });
  const listed = await api.listSessions();
  assert.deepEqual(listed.sessions.map((item) => item.mode), ["review-flow", "agent"]);
  const detail = await api.getSession("s1");
  assert.equal(detail.session.mode, "review-flow");
  // Settings keep a builtin default mode; user modes are chosen per session.
  assert.equal(normalizeSettings({ defaultMode: "review-flow" }).defaultMode, "agent");
  assert.equal(normalizeSettings({ defaultMode: "chat" }).defaultMode, "plan");
});
