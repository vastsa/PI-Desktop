import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The Live panel and the call bar are the only surfaces a voice user has while
// the bound session waits on an ask/permission/plan decision. These checks use
// the real components and the real store, so "the decision is surfaced for the
// bound session" is asserted on the rendered output rather than on a helper.
const detailsSource = readFileSync(
  new URL("../src/features/voice/live/LiveVoiceDetails.tsx", import.meta.url),
  "utf8",
);

const binding = {
  bindingId: "voice-a",
  adapterId: "codex-live",
  configured: true,
  credentialsPresent: true,
  selectable: true,
  providerLabel: "Fixture voice",
};
const status = {
  enabled: true,
  settingsRevision: 1,
  selectedBindingId: binding.bindingId,
  bindings: [binding],
  call: null,
};
const workBinding = {
  workSessionId: "work-a",
  workBindingRevision: 1,
  label: "Release session",
  sessionSource: "desktop",
  contextEnabled: false,
};
const operation = (execution, workSessionId = "work-a") => ({
  operationId: "operation-1",
  admission: "accepted",
  execution,
  workSessionId,
  turnId: "turn-1",
});
const call = {
  callId: "call-a",
  revision: 1,
  bindingId: binding.bindingId,
  adapterId: binding.adapterId,
  phase: "connected",
  muted: true,
  microphoneActive: true,
  userSpeaking: false,
  assistantSpeaking: false,
  workBinding,
  workOperations: [operation("running")],
};

test("a bound work session's pending decision reaches the voice surfaces", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      piDesktop: {
        on: () => () => undefined,
        invoke: async () => ({ ok: true, data: status }),
      },
    },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveVoiceCallBar } = await server.ssrLoadModule("/src/features/voice/live/LiveVoiceCallBar.tsx");
  const { LiveWorkDecisionNotice, liveWorkDecisionText } = await server.ssrLoadModule(
    "/src/features/voice/live/LiveWorkDecisionNotice.tsx",
  );
  const { liveWorkDecision, operationAwaitsDecision, LIVE_WORK_DECISION_TEXT_LIMIT } = await server.ssrLoadModule(
    "/src/features/voice/live/live-work-decision.ts",
  );
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const { liveVoiceIssue } = await server.ssrLoadModule("/src/features/voice/live/live-voice-presentation.ts");

  const translate = (key, options) => {
    if (!options) return key;
    return [key, ...Object.entries(options).map(([name, value]) => `${name}=${value}`)].join("|");
  };
  // The bar is presentational: the owner frame derives the waiting flag from its
  // own store and reports it to the widget window, which has no store of its own.
  // This harness derives it the same way, so the assertions still run against the
  // real component fed by the real helper.
  const deriveDecisionWaiting = (nextCall) => {
    const state = useAppStore.getState();
    return Boolean(liveWorkDecision({
      sessionId: nextCall?.workBinding?.workSessionId,
      awaiting: operationAwaitsDecision(nextCall?.workOperations, nextCall?.workBinding?.workSessionId),
      asks: state.pendingAsks,
      permissions: state.pendingPermissions,
      planCheckpoints: state.planCheckpoints,
    }));
  };
  const renderBar = (nextCall) => {
    const snapshot = { status, call: nextCall, transcripts: [], starting: false, stopping: false };
    return renderToStaticMarkup(React.createElement(LiveVoiceCallBar, {
      t: translate,
      snapshot,
      issue: liveVoiceIssue(snapshot),
      decisionWaiting: deriveDecisionWaiting(nextCall),
      detailsOpen: false,
      detailsRef: { current: null },
      actionPending: null,
      onCancel() {}, onMute() {}, onEnd() {}, onDetails() {}, onResume() {}, onSettings() {}, onDismiss() {},
    }));
  };
  const seed = ({ asks = {}, permissions = {}, plans = {} }) => {
    useAppStore.setState({ pendingAsks: asks, pendingPermissions: permissions, planCheckpoints: plans });
  };
  const askRequest = {
    requestId: "ask-1",
    sessionId: "work-a",
    toolCallId: "call_ask",
    questions: [
      { question: "Which version should ship?", options: [{ label: "beta.1" }] },
      { question: "Push the tag?", options: [{ label: "yes" }] },
    ],
  };

  await t.test("the bound session's waiting turn is announced in the call bar", () => {
    seed({});
    const html = renderBar({ ...call, workOperations: [operation("waiting-input")] });
    assert.match(html, /liveVoice\.decisionWaiting/);
    assert.match(html, /aria-label="liveVoice\.details"/);
  });

  await t.test("a pending ask outranks the generic waiting state and names the session", () => {
    seed({ asks: { "work-a": [askRequest] } });
    const decision = liveWorkDecision({
      sessionId: workBinding.workSessionId,
      awaiting: true,
      asks: { "work-a": [askRequest] },
      permissions: {},
      planCheckpoints: {},
    });
    assert.equal(decision.kind, "ask");
    assert.equal(decision.question, "Which version should ship?");
    assert.equal(decision.additionalQuestions, 1);
    const text = liveWorkDecisionText(decision, translate);
    assert.match(text, /liveVoice\.decisionAsk\|question=Which version should ship\?/);
    assert.match(text, /liveVoice\.decisionMoreQuestions\|count=1/);
  });

  await t.test("another session's pending decision does not surface", () => {
    seed({ asks: { "work-b": [askRequest] } });
    assert.equal(renderBar({ ...call, workOperations: [operation("running")] }), renderBar(call));
    assert.doesNotMatch(renderBar(call), /liveVoice\.decisionWaiting/);
    assert.equal(liveWorkDecision({
      sessionId: "work-b",
      awaiting: false,
      asks: { "work-a": [askRequest] },
      permissions: {},
      planCheckpoints: {},
    }), undefined);
    assert.equal(liveWorkDecision({
      sessionId: undefined,
      awaiting: true,
      asks: { "work-a": [askRequest] },
      permissions: {},
      planCheckpoints: {},
    }), undefined);
    assert.equal(operationAwaitsDecision([operation("waiting-input", "work-b")], "work-a"), false);
    assert.equal(operationAwaitsDecision([operation("waiting-permission")], "work-a"), true);
    assert.equal(operationAwaitsDecision([operation("running")], "work-a"), false);
  });

  await t.test("permission and plan waits keep their own identity", () => {
    seed({});
    const permission = liveWorkDecision({
      sessionId: "work-a",
      awaiting: true,
      asks: {},
      permissions: {
        "work-a": [{
          requestId: "perm-1",
          sessionId: "work-a",
          toolCallId: "call_bash",
          toolName: "Bash",
          argsPreview: "rm -rf build",
          risk: "high",
          reason: "writes outside the workspace",
        }],
      },
      planCheckpoints: {},
    });
    assert.equal(permission.kind, "permission");
    assert.equal(liveWorkDecisionText(permission, translate), "liveVoice.decisionPermission|toolName=Bash");
    const plan = liveWorkDecision({
      sessionId: "work-a",
      awaiting: true,
      asks: {},
      permissions: {},
      planCheckpoints: {
        "work-a": { id: "plan-1", sessionId: "work-a", status: "pending", title: "Ship 0.16.0" },
      },
    });
    assert.equal(plan.kind, "plan");
    assert.equal(
      liveWorkDecisionText(plan, translate),
      "liveVoice.decisionPlan|title=Ship 0.16.0",
    );
  });

  await t.test("request text is bounded, flattened and rendered as text", () => {
    seed({});
    const long = `${"x".repeat(400)}\n  <b>not markup</b>`;
    const question = `${"x".repeat(LIVE_WORK_DECISION_TEXT_LIMIT)}`;
    const decision = liveWorkDecision({
      sessionId: "work-a",
      awaiting: false,
      asks: {
        "work-a": [{ ...askRequest, questions: [{ question: long, options: [{ label: "a" }] }] }],
      },
      permissions: {},
      planCheckpoints: {},
    });
    assert.equal(decision.question, question);
    assert.doesNotMatch(decision.question, /\n/);
    const html = renderToStaticMarkup(React.createElement(LiveWorkDecisionNotice, {
      decision: { kind: "ask", sessionId: "work-a", question: "a<b>b</b>", additionalQuestions: 0 },
      t: translate,
      onOpen() {},
    }));
    assert.match(html, /liveVoice\.decisionAsk\|question=a/);
    assert.match(html, /&lt;b&gt;/);
    assert.doesNotMatch(html, /<b>/);
    assert.match(html, /liveVoice\.decisionHint/);
    assert.match(html, /liveVoice\.decisionOpen/);
    assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  });

  await t.test("the panel hands the decision to the exact session's own card", () => {
    // The answer/approval itself never happens here: the panel selects the
    // bound session and closes itself so the Composer card is the surface.
    assert.match(detailsSource, /liveWorkDecision\(/);
    assert.match(detailsSource, /operationAwaitsDecision\(call\.workOperations, boundSessionId\)/);
    assert.match(detailsSource, /<LiveWorkDecisionNotice/);
    assert.match(detailsSource, /onOpen=\{\(\) => openDecision\(decision\.sessionId\)\}/);
    assert.match(detailsSource, /void selectSession\(sessionId\)\.then\(/);
    assert.match(detailsSource, /\(\) => onClose\(\),/);
    assert.doesNotMatch(detailsSource, /resolveAsk|resolvePermission|resolvePlan/);
  });
});
