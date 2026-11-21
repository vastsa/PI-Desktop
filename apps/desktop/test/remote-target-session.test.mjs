import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach, beforeEach } from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createNavigationIntentController } = await import("../src/lib/navigation-intent.ts");
const { useSessionTargetStore } = await import(
  "../src/features/chat/session-target/session-target-store.ts"
);
const { materializeRemoteTargetSession } = await import(
  "../src/stores/runtime/remote-target-session.ts"
);

const ENVIRONMENT = {
  id: "env:ssh-one",
  hostKey: "ssh-one",
  label: "Remote Linux",
};

const originalListEnvironments = api.listEnvironments;
const originalCreateRemoteSession = api.createRemoteSession;

let createCalls = [];

beforeEach(() => {
  createCalls = [];
  useSessionTargetStore.getState().beginDraft({
    environmentId: ENVIRONMENT.id,
    remoteProject: { hostKey: ENVIRONMENT.hostKey, projectId: "proj-1", label: "app" },
  });
  api.listEnvironments = async () => ({ environments: [ENVIRONMENT] });
  api.createRemoteSession = async (input) => {
    createCalls.push(input);
    return {
      session: {
        id: `remote:${input.hostKey}:created-${createCalls.length}`,
        source: "remote",
        remoteHostKey: input.hostKey,
        remoteProjectId: input.projectId,
        title: "Remote chat",
        mode: input.mode,
        permissionMode: input.permissionMode,
        updatedAt: "2026-11-21T00:00:00Z",
      },
    };
  };
});

afterEach(() => {
  api.listEnvironments = originalListEnvironments;
  api.createRemoteSession = originalCreateRemoteSession;
  useSessionTargetStore.getState().beginDraft({ environmentId: "local" });
});

function createFixture({ draftConfiguration = null, settings = undefined } = {}) {
  const nav = createNavigationIntentController();
  const selections = [];
  let state = {
    sessions: [],
    activeSessionId: undefined,
    draftConfiguration,
    settings,
    selectSession: async (id, options) => {
      selections.push({ id, options });
      state = { ...state, activeSessionId: id };
    },
  };
  return {
    access: {
      get: () => state,
      set: (patch) => {
        state = {
          ...state,
          ...(typeof patch === "function" ? patch(state) : patch),
        };
      },
    },
    runtime: {
      beginNavigationIntent: nav.begin,
      navigationIntentIsCurrent: nav.isCurrent,
    },
    persist: async () => {
      throw new Error("persist should not be called for remote host target without repository");
    },
    selections,
  };
}

test("forwards explicit draft permissionMode values to api.createRemoteSession", async () => {
  for (const permissionMode of ["accept-edits", "auto", "ask"]) {
    const f = createFixture({
      draftConfiguration: { permissionMode },
      settings: { defaultPermissionMode: permissionMode === "ask" ? "auto" : "ask" },
    });
    const sessionId = await materializeRemoteTargetSession(f.access, f.runtime, f.persist);
    assert.equal(sessionId, `remote:ssh-one:created-${createCalls.length}`);
    assert.equal(f.selections.at(-1)?.id, sessionId);
  }
  assert.deepEqual(createCalls, [
    { hostKey: "ssh-one", projectId: "proj-1", mode: "agent", permissionMode: "accept-edits" },
    { hostKey: "ssh-one", projectId: "proj-1", mode: "agent", permissionMode: "auto" },
    { hostKey: "ssh-one", projectId: "proj-1", mode: "agent", permissionMode: "ask" },
  ]);
});

test("falls back to settings.defaultPermissionMode when draft permissionMode is inherit or omitted", async () => {
  const inheritFixture = createFixture({
    draftConfiguration: { permissionMode: "inherit" },
    settings: { defaultPermissionMode: "accept-edits" },
  });
  await materializeRemoteTargetSession(
    inheritFixture.access,
    inheritFixture.runtime,
    inheritFixture.persist,
  );

  const omittedFixture = createFixture({
    draftConfiguration: { mode: "agent" },
    settings: { defaultPermissionMode: "auto" },
  });
  await materializeRemoteTargetSession(
    omittedFixture.access,
    omittedFixture.runtime,
    omittedFixture.persist,
  );

  const nullDraftFixture = createFixture({
    draftConfiguration: null,
    settings: { defaultPermissionMode: "accept-edits" },
  });
  await materializeRemoteTargetSession(
    nullDraftFixture.access,
    nullDraftFixture.runtime,
    nullDraftFixture.persist,
  );

  assert.deepEqual(
    createCalls.map((call) => call.permissionMode),
    ["accept-edits", "auto", "accept-edits"],
  );
});

test("falls back to ask when neither draft nor settings has a valid global permissionMode", async () => {
  const missingFixture = createFixture({
    draftConfiguration: null,
    settings: undefined,
  });
  await materializeRemoteTargetSession(
    missingFixture.access,
    missingFixture.runtime,
    missingFixture.persist,
  );

  const invalidFixture = createFixture({
    draftConfiguration: { permissionMode: "inherit" },
    settings: { defaultPermissionMode: "inherit" },
  });
  await materializeRemoteTargetSession(
    invalidFixture.access,
    invalidFixture.runtime,
    invalidFixture.persist,
  );

  assert.deepEqual(
    createCalls.map((call) => call.permissionMode),
    ["ask", "ask"],
  );
});

test("resolves draft mode and falls back to settings.defaultMode or agent", async () => {
  const cases = [
    { draftConfiguration: { mode: "plan" }, settings: { defaultMode: "agent" }, expected: "plan" },
    { draftConfiguration: { mode: "goal" }, settings: { defaultMode: "plan" }, expected: "goal" },
    { draftConfiguration: { mode: "agent" }, settings: { defaultMode: "goal" }, expected: "agent" },
    { draftConfiguration: null, settings: { defaultMode: "plan" }, expected: "plan" },
    { draftConfiguration: null, settings: { defaultMode: "goal" }, expected: "goal" },
    { draftConfiguration: null, settings: { defaultMode: "agent" }, expected: "agent" },
    { draftConfiguration: null, settings: undefined, expected: "agent" },
    { draftConfiguration: null, settings: { defaultMode: "custom" }, expected: "agent" },
  ];

  for (const testCase of cases) {
    const f = createFixture({
      draftConfiguration: testCase.draftConfiguration,
      settings: testCase.settings,
    });
    await materializeRemoteTargetSession(f.access, f.runtime, f.persist);
  }

  assert.deepEqual(
    createCalls.map((call) => call.mode),
    cases.map((testCase) => testCase.expected),
  );
});
