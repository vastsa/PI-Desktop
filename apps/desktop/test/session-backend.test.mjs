import assert from "node:assert/strict";
import test from "node:test";

import { externalAgentForSession } from "../src/lib/session-backend.ts";

/**
 * Which backend runs a session, and therefore whether the access model has to
 * be repeated next to the composer.
 *
 * The rule matters because a wrong `null` is the dangerous direction: it hides
 * the disclosure from a session whose external agent is about to edit the
 * project. So the cases below lean on the awkward ones — a missing row, a
 * cleared agent, a whitespace command — rather than only the obvious one.
 */

const AGENT = { id: "agent", acp: { command: "opencode" } };
const NATIVE = { id: "native" };

test("a session on an agent row reports the program that runs it", () => {
  assert.deepEqual(externalAgentForSession("agent", [AGENT, NATIVE]), {
    command: "opencode",
  });
});

test("a session on an ordinary provider reports no external agent", () => {
  assert.equal(externalAgentForSession("native", [AGENT, NATIVE]), null);
});

test("a session with no provider yet reports no external agent", () => {
  assert.equal(externalAgentForSession(undefined, [AGENT, NATIVE]), null);
  assert.equal(externalAgentForSession("", [AGENT, NATIVE]), null);
});

test("a provider that no longer exists reports no external agent", () => {
  // The row can be deleted while a session still points at it. Falling back to
  // the built-in agent is the safe read: there is no program to disclose.
  assert.equal(externalAgentForSession("deleted", [AGENT, NATIVE]), null);
});

test("a cleared agent is not an external agent", () => {
  // Clearing writes an empty command rather than removing the block, so an
  // empty command is the shape a row takes once it is a native provider again.
  assert.equal(externalAgentForSession("cleared", [{ id: "cleared", acp: { command: "" } }]), null);
  assert.equal(externalAgentForSession("blank", [{ id: "blank", acp: { command: "   " } }]), null);
});

test("an absent or null agent block is not an external agent", () => {
  assert.equal(externalAgentForSession("a", [{ id: "a" }]), null);
  assert.equal(externalAgentForSession("b", [{ id: "b", acp: null }]), null);
  assert.equal(externalAgentForSession("c", [{ id: "c", acp: {} }]), null);
});

test("a command is trimmed so the tooltip never carries stray whitespace", () => {
  assert.deepEqual(externalAgentForSession("pad", [{ id: "pad", acp: { command: "  opencode  " } }]), {
    command: "opencode",
  });
});

test("the first row with the id wins, matching the rest of the store", () => {
  // `providers` is a list the store keeps in order; a duplicate id is not
  // something the app produces, and this pins the tie-break rather than
  // leaving it to `find`'s incidental behaviour.
  const providers = [
    { id: "dup", acp: { command: "first" } },
    { id: "dup", acp: { command: "second" } },
  ];
  assert.deepEqual(externalAgentForSession("dup", providers), { command: "first" });
});
