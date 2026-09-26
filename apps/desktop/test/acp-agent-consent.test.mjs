import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  acpConfigFrom,
  acpDraftEdited,
  acpDraftFrom,
  parseArgs,
  validateAcpDraft,
} = await import("../src/components/settings/acp-draft.ts");

/**
 * The consent gate for the external-agent section.
 *
 * An external agent runs with the project folder as its working directory and
 * edits it with its own tools, so the host cannot allow or deny any of that
 * (ADR 0287). The only control left is telling the user before the row is
 * saved, which is what these tests pin down: the gate refuses, the tick box
 * opens it, and nothing the caller does can persist an agent the user was
 * never shown.
 */

const AGENT = { command: "opencode", args: ["acp"] };

/** The draft a user reaches after typing a command but before ticking the box. */
function typed(draft) {
  return acpDraftEdited(draft, { enabled: true, command: AGENT.command, args: AGENT.args.join(" ") });
}

test("an enabled agent cannot be saved until the access model is acknowledged", () => {
  const draft = typed(acpDraftFrom(null));
  assert.equal(validateAcpDraft(draft), "consentRequired");
  assert.equal(acpConfigFrom(draft), null);

  const acknowledged = acpDraftEdited(draft, { acknowledged: true });
  assert.equal(validateAcpDraft(acknowledged), null);
  assert.deepEqual(acpConfigFrom(acknowledged), AGENT);
});

test("a command that has never been acknowledged is refused even if the gate is skipped", () => {
  // The dialog refuses to save through `onValidity`, but `acpConfigFrom` is the
  // only funnel to a persisted config_json.acp, so it refuses on its own too.
  const draft = { ...typed(acpDraftFrom(null)), acknowledged: false };
  assert.equal(acpConfigFrom(draft), null);
  assert.equal(acpConfigFrom({ ...draft, command: "" }), null);
  assert.equal(acpConfigFrom({ ...draft, args: '"' }), null);
});

test("changing which program runs drops the acknowledgement", () => {
  const acknowledged = acpDraftEdited(typed(acpDraftFrom(null)), { acknowledged: true });
  assert.equal(validateAcpDraft(acknowledged), null);

  // Consent was given for one program, not for whatever lands in the field next.
  const swapped = acpDraftEdited(acknowledged, { command: "some-other-agent" });
  assert.equal(swapped.acknowledged, false);
  assert.equal(validateAcpDraft(swapped), "consentRequired");
  assert.equal(acpConfigFrom(swapped), null);
});

test("a preset fill counts as a new program and re-asks", () => {
  const acknowledged = acpDraftEdited(typed(acpDraftFrom(null)), { acknowledged: true });
  const preset = acpDraftEdited(acknowledged, { command: "claude", args: "--acp" });
  assert.equal(preset.acknowledged, false);
  assert.equal(validateAcpDraft(preset), "consentRequired");
});

test("edits that do not change the program keep the acknowledgement", () => {
  const acknowledged = acpDraftEdited(typed(acpDraftFrom(null)), { acknowledged: true });
  for (const patch of [{ args: "acp --verbose" }, { modelId: "some/model" }, { acknowledged: false }]) {
    const next = acpDraftEdited(acknowledged, patch);
    assert.equal(next.acknowledged, patch.acknowledged ?? true, JSON.stringify(patch));
  }
  // Re-sending the same command is not a new program.
  assert.equal(acpDraftEdited(acknowledged, { command: AGENT.command }).acknowledged, true);
});

test("opening the dialog re-asks even for a row that already has an agent", () => {
  const stored = acpDraftFrom({ acp: AGENT });
  assert.equal(stored.enabled, true);
  assert.equal(stored.command, "opencode");
  assert.equal(stored.acknowledged, false);
  assert.equal(validateAcpDraft(stored), "consentRequired");
});

test("a row without an agent is not gated", () => {
  const stored = acpDraftFrom({});
  assert.equal(stored.enabled, false);
  assert.equal(validateAcpDraft(stored), null);
  assert.equal(acpConfigFrom(stored), null);
});

test("a command problem is reported before the tick box", () => {
  // Mid-typing the field is empty; saying "confirm the access model" while the
  // command is still being typed points at the wrong thing.
  const empty = acpDraftEdited(acpDraftFrom(null), { enabled: true, command: "  " });
  assert.equal(validateAcpDraft(empty), "emptyCommand");
  assert.equal(acpConfigFrom(empty), null);
});

test("the user path from an empty dialog to a saved agent", () => {
  let draft = acpDraftFrom(null);
  assert.equal(acpConfigFrom(draft), null, "nothing to save before the section is on");

  draft = acpDraftEdited(draft, { enabled: true });
  assert.equal(validateAcpDraft(draft), "emptyCommand");

  draft = acpDraftEdited(draft, { command: "opencode" });
  assert.equal(validateAcpDraft(draft), "consentRequired");

  draft = acpDraftEdited(draft, { modelId: "opencode/muse-spark-1.3" });
  assert.equal(validateAcpDraft(draft), "consentRequired", "a model does not stand in for consent");

  draft = acpDraftEdited(draft, { acknowledged: true });
  assert.equal(validateAcpDraft(draft), null);
  assert.deepEqual(acpConfigFrom(draft), {
    command: "opencode",
    args: ["acp"],
    modelId: "opencode/muse-spark-1.3",
  });
});

test("arguments parse the way the command field documents", () => {
  assert.deepEqual(parseArgs("acp"), ["acp"]);
  assert.deepEqual(parseArgs('acp --flag "two words"'), ["acp", "--flag", "two words"]);
  assert.deepEqual(parseArgs(""), []);
  // An unclosed quote is kept verbatim rather than swallowed, so a flag the
  // user typed survives into the command instead of being dropped. This is why
  // the section reports no parse failure: `(\S+)` always matches, so there is
  // no argument text the parser cannot make sense of.
  assert.deepEqual(parseArgs('"'), ['"']);
  assert.deepEqual(parseArgs('"a b"'), ["a b"]);
});
