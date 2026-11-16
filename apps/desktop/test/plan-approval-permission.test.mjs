import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const compile = text => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(permissionMode, defaultPermissionMode = "ask", remembered = "ask") {
  const preferences = { exports: {} };
  vm.runInNewContext(compile(source("lib/plan-approval-preferences.ts")), {
    exports: preferences.exports,
    localStorage: { getItem: () => remembered, setItem: () => {} },
  });
  const session = { id: "owner", mode: "agent", permissionMode };
  const resolutions = [];
  const state = {
    activeSessionId: "other",
    sessions: [session, { id: "other", permissionMode: "ask" }],
    settings: { defaultPermissionMode },
    resolvePlan: async resolution => {
      resolutions.push(resolution);
      if (resolution.action === "approve") {
        session.mode = "agent";
        session.permissionMode = resolution.targetPermissionMode;
      }
    },
  };
  const store = selector => selector(state);
  store.getState = () => state;
  const hooks = [];
  let cursor = 0;
  const effects = [];
  const component = { exports: {} };
  vm.runInNewContext(compile(source("components/PlanApprovalBar.tsx")), {
    exports: component.exports,
    require: id => {
      if (id === "react") return {
        useState: initial => {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
          return [hooks[index], value => { hooks[index] = value; }];
        },
        useEffect: effect => effects.push(effect),
      };
      if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
      if (id.endsWith("/app-store")) return { useAppStore: store };
      if (id.endsWith("/plan-approval-preferences")) return preferences.exports;
      if (id.endsWith("/plan-mode-state")) return { PLAN_APPROVAL_DEFAULT_MODE: "ask" };
      if (id === "react/jsx-runtime") return require(id);
      return {};
    },
  });
  const proposal = { id: "proposal", sessionId: session.id, turnId: "turn", toolCallId: "call", version: 1, kind: "plan", title: "Synthetic plan", status: "pending" };
  const render = () => { cursor = 0; return component.exports.PlanApprovalBar({ proposal }); };
  return {
    session, resolutions, proposal,
    mount: () => { session.mode = "plan"; render(); effects.splice(0).forEach(effect => effect()); return render(); },
  };
}

function find(node, predicate) {
  if (!node) return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat()) {
    const match = find(child, predicate);
    if (match) return match;
  }
  // AnchoredMenu renders the approval button through its trigger callback.
  if (node.props?.trigger) return find(node.props.trigger(null), predicate);
}

test("Agent bypass survives Plan submission and approval in the owning session", async () => {
  const h = harness("auto");
  const tree = h.mount();
  const button = find(tree, node => node.props?.className === "plan-approval-approve-main");
  await button.props.onClick();
  assert.equal(h.resolutions[0].targetPermissionMode, "auto");
  assert.equal(button.props["aria-label"], "plan.approveAuto");
  assert.equal(h.session.mode, "agent");
  assert.equal(h.session.permissionMode, "auto");
});

test("approval follows session overrides and inherited settings, ignoring another session's remembered choice", async () => {
  for (const [permissionMode, globalMode, remembered, expected] of [
    ["ask", "auto", "auto", "ask"],
    ["accept-edits", "auto", "ask", "accept-edits"],
    ["inherit", "auto", "ask", "auto"],
    ["inherit", "accept-edits", "auto", "accept-edits"],
    ["inherit", "ask", "auto", "ask"],
    [undefined, undefined, "auto", "ask"],
  ]) {
    const h = harness(permissionMode, globalMode, remembered);
    const tree = h.mount();
    await find(tree, node => node.props?.className === "plan-approval-approve-main").props.onClick();
    assert.equal(h.resolutions[0].targetPermissionMode, expected);
    assert.equal(h.session.permissionMode, expected);
  }
});

test("an explicit approval choice still changes the execution permission", async () => {
  const h = harness("auto");
  const tree = h.mount();
  await find(tree, node => node.props?.["data-approval-mode"] === "ask").props.onClick();
  assert.equal(h.resolutions[0].targetPermissionMode, "ask");
  assert.equal(h.session.permissionMode, "ask");
});

test("reject does not send or change the session permission", async () => {
  const h = harness("auto");
  const tree = h.mount();
  await find(tree, node => node.props?.className === "plan-approval-reject").props.onClick();
  assert.equal(h.resolutions[0].action, "reject");
  assert.equal("targetPermissionMode" in h.resolutions[0], false);
  assert.equal(h.session.permissionMode, "auto");
  assert.equal(h.session.mode, "plan");
});
