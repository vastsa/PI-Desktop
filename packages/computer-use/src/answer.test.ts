import { describe, expect, it } from "vitest";
import type { ComputerInspection, ComputerNode } from "@pi-desktop/shared";

import { extractJsonObject, parseLoopAnswer, validateAnswerAction } from "./answer.js";

function node(overrides: Partial<ComputerNode> = {}): ComputerNode {
  return {
    uid: "0.1#ab",
    role: "AXButton",
    label: "Save",
    hasValue: false,
    enabled: true,
    focused: false,
    bounds: { x: 10, y: 20, width: 80, height: 24 },
    actions: ["click"],
    ...overrides,
  };
}

function inspection(nodes: ComputerNode[] = [node()], overrides: Partial<ComputerInspection> = {}): ComputerInspection {
  return {
    grantId: "cug_1",
    revision: 3,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    fidelity: "full",
    nodes,
    truncated: false,
    secureInput: false,
    ...overrides,
  };
}

describe("extractJsonObject", () => {
  it("accepts a bare object and a fenced one", () => {
    expect(extractJsonObject('{"kind":"done","summary":"ok"}')).toMatchObject({ ok: true });
    expect(extractJsonObject('```json\n{"kind":"done","summary":"ok"}\n```')).toMatchObject({ ok: true });
    expect(extractJsonObject('Sure!\n{"kind":"done","summary":"ok"}')).toMatchObject({ ok: true });
  });

  it("refuses empty, prose-only, and malformed replies", () => {
    for (const text of ["", "   ", "I clicked the button.", "{not json}", "[1,2]"]) {
      expect(extractJsonObject(text), text).toMatchObject({ ok: false });
    }
  });
});

describe("parseLoopAnswer", () => {
  it("parses the three answer kinds", () => {
    expect(parseLoopAnswer('{"kind":"done","summary":"dark mode is on"}')).toEqual({
      ok: true,
      answer: { kind: "done", summary: "dark mode is on" },
    });
    expect(parseLoopAnswer('{"kind":"ask","question":"which account?"}')).toEqual({
      ok: true,
      answer: { kind: "ask", question: "which account?" },
    });
    expect(
      parseLoopAnswer('{"kind":"action","action":{"kind":"click","uid":"0.1#ab"},"note":"the Save button"}'),
    ).toEqual({
      ok: true,
      answer: { kind: "action", action: { kind: "click", uid: "0.1#ab" }, note: "the Save button" },
    });
  });

  it("refuses an unknown answer kind or action kind", () => {
    expect(parseLoopAnswer('{"kind":"shell","command":"rm -rf /"}')).toMatchObject({ ok: false });
    expect(parseLoopAnswer('{"kind":"action","action":{"kind":"drag","uid":"0.1#ab"}}')).toMatchObject({
      ok: false,
    });
  });

  it("refuses fields the schema does not define, including a target or a basis", () => {
    for (const text of [
      '{"kind":"done","summary":"ok","extra":1}',
      '{"kind":"ask","question":"q","extra":1}',
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"},"grantId":"cug_2"}',
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab","targetId":"42"}}',
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab","basis":{"revision":9,"bounds":{}}}}',
    ]) {
      expect(parseLoopAnswer(text), text).toMatchObject({ ok: false });
    }
  });

  it("requires the field each action kind needs", () => {
    for (const text of [
      '{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab"}}',
      '{"kind":"action","action":{"kind":"press_keys","uid":"0.1#ab"}}',
      '{"kind":"action","action":{"kind":"select","uid":"0.1#ab"}}',
      '{"kind":"action","action":{"kind":"scroll","uid":"0.1#ab"}}',
      '{"kind":"action","action":{"kind":"click"}}',
    ]) {
      expect(parseLoopAnswer(text), text).toMatchObject({ ok: false });
    }
  });

  it("refuses non-finite and oversized values", () => {
    expect(
      parseLoopAnswer('{"kind":"action","action":{"kind":"click","point":{"x":1e999,"y":0}}}'),
    ).toMatchObject({ ok: false });
    expect(
      parseLoopAnswer(
        `{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab","text":"${"x".repeat(2_001)}"}}`,
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseLoopAnswer('{"kind":"action","action":{"kind":"press_keys","uid":"0.1#ab","keys":[]}}'),
    ).toMatchObject({ ok: false });
  });
});

describe("validateAnswerAction", () => {
  it("binds a coordinate to the host's own measurement", () => {
    const result = validateAnswerAction({ kind: "click", point: { x: 5, y: 6 } }, inspection());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The basis is the inspection's, so a model cannot claim a geometry.
    expect(result.action.basis).toEqual({ revision: 3, bounds: { x: 100, y: 100, width: 800, height: 600 } });
  });

  it("refuses a uid the observation did not contain", () => {
    const result = validateAnswerAction({ kind: "click", uid: "9.9#ff" }, inspection());
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses an action the element does not offer", () => {
    const result = validateAnswerAction({ kind: "right_click", uid: "0.1#ab" }, inspection());
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses typing into an element that holds no value", () => {
    const result = validateAnswerAction({ kind: "set_value", uid: "0.1#ab", text: "hi" }, inspection());
    expect(result).toMatchObject({ ok: false });
    const field = node({ uid: "0.2#cd", role: "AXTextField", hasValue: true, actions: [] });
    expect(
      validateAnswerAction({ kind: "set_value", uid: "0.2#cd", text: "hi" }, inspection([field])).ok,
    ).toBe(true);
  });

  it("refuses a disabled element", () => {
    const disabled = node({ enabled: false });
    expect(validateAnswerAction({ kind: "click", uid: disabled.uid }, inspection([disabled]))).toMatchObject({
      ok: false,
    });
  });

  it("refuses a point outside the scope", () => {
    expect(validateAnswerAction({ kind: "click", point: { x: 5_000, y: 1 } }, inspection())).toMatchObject({
      ok: false,
    });
    expect(validateAnswerAction({ kind: "click", point: { x: -1, y: 1 } }, inspection())).toMatchObject({
      ok: false,
    });
  });

  it("refuses everything while secure input is active", () => {
    const secure = inspection([node()], { secureInput: true });
    expect(validateAnswerAction({ kind: "click", uid: "0.1#ab" }, secure)).toMatchObject({ ok: false });
  });

  it("allows press_keys without an element action, since keys go to the process", () => {
    const result = validateAnswerAction({ kind: "press_keys", uid: "0.1#ab", keys: ["cmd+s"] }, inspection());
    expect(result.ok).toBe(true);
  });
});
