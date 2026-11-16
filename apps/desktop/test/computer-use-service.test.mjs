/**
 * The `Computer` tool handler's refusals and its automatic grant, against the
 * real module.
 *
 * Every case here is something the agent could plausibly try, and each one has
 * to fail with its own code rather than silently acting: a disabled feature, a
 * missing model binding, a grant that belongs to another session, and a user
 * Stop the agent tries to walk back (ADR 0344). The overlay is asserted to stay
 * closed in those cases, because a drawn cursor with no authority behind it is
 * a lie to the user.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))(
  "esbuild",
);

async function loadService(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-computer-use-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outfile = join(root, "service.mjs");
  // Electron cannot be imported by a plain Node test, and the capture module
  // pulls it in. Aliasing it to a stub keeps the production code unchanged and
  // still proves the handler's own paths: no case here reaches capture, which
  // every case injects anyway.
  const stub = join(root, "electron-stub.mjs");
  await writeFile(stub, "export const desktopCapturer = { getSources: async () => [] };\nexport const systemPreferences = { getMediaAccessStatus: () => \"not-determined\" };\n");
  // The provider call is injected in every case here, so the runtime package —
  // and the HTTP stack behind it — is stubbed rather than bundled.
  const runtimeStub = join(root, "runtime-stub.mjs");
  await writeFile(runtimeStub, "export async function completeOneShot() { throw new Error('not injected'); }\n");
  await build({
    entryPoints: [fileURLToPath(new URL("../electron/main/computer-use/service.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    alias: { electron: stub, "@pi-desktop/agent-runtime": runtimeStub },
  });
  return import(pathToFileURL(outfile).href);
}

function grantFixture(overrides = {}) {
  return {
    grantId: "cug_1",
    revision: 1,
    scope: "desktop",
    targetId: "77:12",
    targetLabel: "Example",
    appKey: "example",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    inputPolicy: "autonomous-in-scope",
    capture: "a11y-only",
    remainingBudget: 5,
    sessionId: "session-1",
    createdAt: "2026-11-04T00:00:00.000Z",
    expiresAt: "2026-11-04T00:15:00.000Z",
    state: "active",
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const log = [];
  const cursor = [];
  const settings = overrides.settings ?? {
    computerUse: { enabled: true, model: { providerId: "p1", modelId: "ui" } },
  };
  // `??` would swallow an explicit null, which is exactly the case where the
  // handler has to mint a grant of its own.
  const grant = "grant" in overrides ? overrides.grant : grantFixture();
  let current = grant;
  const host = {
    call: async (method, params) => {
      calls.push(method);
      log.push({ method, params });
      if (method === "settings.get") return settings;
      if (method === "computer.grantDescribe") return { grant: current };
      if (method === "computer.grantCreate") {
        if (overrides.grantCreate) return overrides.grantCreate(params);
        current = grantFixture({ grantId: "cug_auto" });
        return current;
      }
      if (method === "computer.listTargets") {
        return {
          targets: [
            { targetId: "77:12", appName: "Example", title: "Document", appKey: "example", bounds: current.bounds },
            { targetId: "88:4", appName: "Other", title: "Inbox", appKey: "other", bounds: current.bounds },
          ],
        };
      }
      if (method === "computer.inspect") {
        return {
          grantId: current?.grantId,
          revision: 1,
          bounds: current?.bounds,
          fidelity: "full",
          nodes: [
            {
              uid: "0.1#ab",
              role: "AXButton",
              label: "Save",
              hasValue: false,
              enabled: true,
              focused: false,
              bounds: { x: 10, y: 10, width: 40, height: 20 },
              actions: ["click"],
            },
          ],
          truncated: false,
          secureInput: false,
        };
      }
      if (method === "computer.act") {
        return { grantId: current.grantId, revision: 1, remainingBudget: 4, dispatched: "accessibility-action" };
      }
      if (method === "providers.get") return { provider: { id: "p1", name: "P", enabled: true, authKind: "none" } };
      throw new Error(`unexpected host call ${method} ${JSON.stringify(params)}`);
    },
  };
  return { calls, log, cursor, host, grant, settings };
}

function deps(h, overrides = {}) {
  return {
    getHost: () => h.host,
    overlay: { apply: (event) => h.cursor.push(event) },
    resolveProvider: async () => ({
      id: "p1",
      name: "P",
      modelId: "ui",
      apiKey: "",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    }),
    capture: async () => undefined,
    complete: async () => ({ text: '{"kind":"done","summary":"nothing to do"}' }),
    ...overrides,
  };
}

const input = (args = { instruction: "open preferences" }) => ({
  sessionId: "session-1",
  toolCallId: "call-1",
  args,
  signal: new AbortController().signal,
});

test("a disabled feature refuses before anything is read", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness({ settings: { computerUse: { enabled: false } } });
  const result = await createComputerUseTool(deps(h))(input());
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "COMPUTER_DISABLED");
  assert.ok(!h.calls.includes("computer.grantDescribe"), "no grant is read while disabled");
  assert.deepEqual(h.cursor, [], "nothing is drawn");
});

test("a missing model binding refuses instead of using the conversation model", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness({ settings: { computerUse: { enabled: true } } });
  const result = await createComputerUseTool(deps(h))(input());
  assert.equal(result.errorCode, "COMPUTER_NOT_CONFIGURED");
  assert.match(result.content.message, /Settings/);
});

test("an absent grant is minted for the session, carrying only the user's settings", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness({
    grant: null,
    settings: {
      computerUse: {
        enabled: true,
        model: { providerId: "p1", modelId: "ui" },
        defaultCapture: "a11y-and-pixels",
        actionBudget: 7,
      },
    },
  });
  const published = [];
  const result = await createComputerUseTool(deps(h, { onGrant: (next) => published.push(next) }))(input());
  assert.equal(result.ok, true);
  const minted = h.log.find((entry) => entry.method === "computer.grantCreate");
  assert.ok(minted, "the handler mints the grant itself (ADR 0344)");
  // No target: the scope is the host's decision, not this handler's.
  assert.equal(minted.params.targetId, undefined);
  assert.equal(minted.params.origin, "agent");
  assert.equal(minted.params.sessionId, "session-1");
  assert.equal(minted.params.capture, "a11y-and-pixels");
  assert.equal(minted.params.actionBudget, 7);
  assert.equal(published.at(0)?.grantId, "cug_auto", "the indicator is told at once");
});

test("a user Stop refuses the automatic mint instead of restarting the run", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness({
    grant: null,
    grantCreate: () => {
      throw Object.assign(new Error("the user stopped computer use"), {
        errorCode: "COMPUTER_STOPPED_BY_USER",
      });
    },
  });
  const result = await createComputerUseTool(deps(h))(input());
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "COMPUTER_STOPPED_BY_USER");
  assert.match(result.content.message, /Do not retry/i);
  assert.ok(!h.calls.includes("computer.inspect"), "nothing is read after a Stop");
  assert.deepEqual(h.cursor, [], "nothing is drawn");
});

test("a switch asks the host to bind the named window and nothing else", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  const answers = ['{"kind":"switch","window":"88:4"}', '{"kind":"done","summary":"read it"}'];
  let asked = 0;
  const result = await createComputerUseTool(
    deps(h, { complete: async () => ({ text: answers[Math.min(asked++, answers.length - 1)] }) }),
  )(input({ instruction: "read the other window" }));
  assert.equal(result.ok, true);
  const inspects = h.log.filter((entry) => entry.method === "computer.inspect");
  assert.equal(inspects.at(0)?.params.targetId, undefined, "the first look is the bound window");
  assert.equal(inspects.at(1)?.params.targetId, "88:4", "the switch goes through the host");
  assert.ok(!h.calls.includes("computer.act"), "a switch dispatches no input");
});

test("a grant owned by another session is refused", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  h.grant.sessionId = "session-2";
  const result = await createComputerUseTool(deps(h))(input());
  assert.equal(result.errorCode, "COMPUTER_GRANT_IN_USE");
});

test("an unavailable computer-use model reports configuration, not a failure to act", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  const result = await createComputerUseTool(deps(h, { resolveProvider: async () => null }))(input());
  assert.equal(result.errorCode, "COMPUTER_NOT_CONFIGURED");
});

test("invalid arguments are refused by the shared validator", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  const tool = createComputerUseTool(deps(h));
  for (const args of [{}, { instruction: "" }, { instruction: "x", uid: "0.1#ab" }]) {
    const result = await tool(input(args));
    assert.equal(result.errorCode, "INVALID_ARGUMENT", JSON.stringify(args));
  }
});

test("a run that the model ends immediately dispatches nothing and closes the overlay", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  const result = await createComputerUseTool(deps(h))(input());
  assert.equal(result.ok, true);
  assert.equal(result.content.outcome, "done");
  assert.ok(!h.calls.includes("computer.act"), "nothing was dispatched");
  assert.equal(h.cursor.at(-1).kind, "hide", "the drawn cursor is taken down");
});

test("observeOnly never asks the model and never acts", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  let asked = 0;
  const result = await createComputerUseTool(
    deps(h, {
      complete: async () => {
        asked += 1;
        return { text: '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}' };
      },
    }),
  )(input({ instruction: "what is on screen", observeOnly: true }));
  assert.equal(result.ok, true);
  assert.equal(asked, 0);
  assert.ok(!h.calls.includes("computer.act"));
});

test("a model answer naming an element the host never showed is refused locally", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  const result = await createComputerUseTool(
    deps(h, { complete: async () => ({ text: '{"kind":"action","action":{"kind":"click","uid":"9.9#ff"}}' }) }),
  )(input());
  assert.ok(!h.calls.includes("computer.act"), "the invented element never reaches the host");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "COMPUTER_ACTION_REJECTED");
});

test("a host refusal keeps its own code in the tool result", async (t) => {
  const { createComputerUseTool } = await loadService(t);
  const h = harness();
  const host = {
    call: async (method, params) => {
      if (method === "computer.act") {
        throw Object.assign(new Error("secure input is active"), {
          errorCode: "COMPUTER_SECURE_INPUT_REFUSED",
        });
      }
      return h.host.call(method, params);
    },
  };
  const result = await createComputerUseTool(
    deps(h, {
      getHost: () => host,
      complete: async () => ({ text: '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}' }),
    }),
  )(input());
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "COMPUTER_SECURE_INPUT_REFUSED");
});
