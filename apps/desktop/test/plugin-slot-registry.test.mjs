import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The renderer slot registry (`docs/plugin-plan/slot-contract.html` §2):
 * what `pi.slots.register` accepts, how additive slots stack, how keyed slots
 * refuse a second claim, and that a disposer removes exactly its own
 * registration. Outlets only ever read what this store publishes.
 */
const { SlotRegistry } = await import("../src/plugins/renderer-slots/registry.ts");
const { PluginRendererError } = await import("../src/plugins/renderer-error.ts");

const PLUGIN = "demo.lab";
const OTHER = "demo.other";
const component = () => null;
const named = (name) => Object.assign(() => null, { displayName: name });

function refusedWith(code) {
  return (error) => {
    assert.ok(error instanceof PluginRendererError, `expected a PluginRendererError, got ${error}`);
    assert.equal(error.name, "PluginRendererError");
    assert.equal(error.code, code);
    return true;
  };
}

test("additive slots stack in registration order across plugins", () => {
  const registry = new SlotRegistry();
  const a1 = named("a1");
  const b1 = named("b1");
  const a2 = named("a2");
  registry.register(PLUGIN, { slot: "entryExtra", component: a1 }, []);
  registry.register(OTHER, { slot: "entryExtra", component: b1 }, []);
  registry.register(PLUGIN, { slot: "entryExtra", component: a2 }, []);
  registry.register(PLUGIN, { slot: "assistantAction", component }, []);

  const stacked = registry.entriesFor("entryExtra");
  assert.deepEqual(
    stacked.map((entry) => entry.component),
    [a1, b1, a2],
  );
  assert.deepEqual(
    stacked.map((entry) => entry.pluginId),
    [PLUGIN, OTHER, PLUGIN],
  );
  assert.equal(new Set(stacked.map((entry) => entry.id)).size, 3, "entry ids are unique");
  for (const entry of stacked) {
    assert.equal(entry.slot, "entryExtra");
    assert.deepEqual(entry.sides, []);
    assert.equal(entry.key, undefined);
  }
});

test("a disposer removes exactly its own registration, once", () => {
  const registry = new SlotRegistry();
  const first = named("first");
  const second = named("second");
  const disposeFirst = registry.register(PLUGIN, { slot: "entryExtra", component: first }, []);
  registry.register(PLUGIN, { slot: "entryExtra", component: second }, []);

  disposeFirst();
  assert.deepEqual(
    registry.entriesFor("entryExtra").map((entry) => entry.component),
    [second],
  );
  const version = registry.getSnapshot().version;
  disposeFirst();
  assert.equal(registry.getSnapshot().version, version, "a second call publishes nothing");
  assert.equal(registry.entriesFor("entryExtra").length, 1);

  // Registering the same component again is a new registration of its own.
  const disposeAgain = registry.register(PLUGIN, { slot: "entryExtra", component: second }, []);
  assert.equal(registry.entriesFor("entryExtra").length, 2);
  disposeAgain();
  assert.equal(registry.entriesFor("entryExtra").length, 1);
});

test("every accepted registration and disposal publishes a new snapshot; a refusal does not", () => {
  const registry = new SlotRegistry();
  let notified = 0;
  const unsubscribe = registry.subscribe(() => {
    notified += 1;
  });
  const empty = registry.getSnapshot();
  assert.equal(empty.version, 0);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.triggers, []);

  const dispose = registry.register(PLUGIN, { slot: "entryExtra", component }, []);
  const registered = registry.getSnapshot();
  assert.equal(notified, 1);
  assert.equal(registered.version, 1);
  assert.notEqual(registered, empty, "a change is a new snapshot object");
  assert.equal(registry.getSnapshot(), registered, "no change keeps the snapshot");

  assert.throws(() => registry.register(PLUGIN, { slot: "nope", component }, []));
  assert.equal(notified, 1);
  assert.equal(registry.getSnapshot(), registered);

  dispose();
  assert.equal(notified, 2);
  assert.equal(registry.getSnapshot().version, 2);
  assert.deepEqual(registry.getSnapshot().entries, []);

  unsubscribe();
  registry.register(PLUGIN, { slot: "entryExtra", component }, []);
  assert.equal(notified, 2, "an unsubscribed listener hears nothing");
});

test("positioned slots take both sides by default and the listed sides in canonical order", () => {
  const registry = new SlotRegistry();
  const both = named("both");
  const right = named("right");
  const reversed = named("reversed");
  const repeated = named("repeated");
  for (const slot of ["userAction", "assistantAction", "composerControl"]) {
    registry.register(PLUGIN, { slot, component: both }, []);
    registry.register(PLUGIN, { slot, component: right, positions: ["right"] }, []);
    registry.register(PLUGIN, { slot, component: reversed, positions: ["right", "left"] }, []);
    registry.register(PLUGIN, { slot, component: repeated, positions: ["left", "left"] }, []);

    assert.deepEqual(
      registry.entriesFor(slot).map((entry) => entry.sides),
      [["left", "right"], ["right"], ["left", "right"], ["left"]],
      slot,
    );
    assert.deepEqual(
      registry.entriesForSide(slot, "left").map((entry) => entry.component),
      [both, reversed, repeated],
      `${slot} left`,
    );
    assert.deepEqual(
      registry.entriesForSide(slot, "right").map((entry) => entry.component),
      [both, right, reversed],
      `${slot} right`,
    );
  }
  assert.deepEqual(registry.entriesForSide("entryExtra", "left"), []);
});

test("malformed registrations are refused with their code and change nothing", () => {
  const cases = [
    ["not an object", null, "PLUGIN_SLOT_UNKNOWN"],
    ["a string", "entryExtra", "PLUGIN_SLOT_UNKNOWN"],
    ["no slot", { component }, "PLUGIN_SLOT_UNKNOWN"],
    ["an unknown slot", { slot: "sidebar", component }, "PLUGIN_SLOT_UNKNOWN"],
    ["a non-string slot", { slot: 3, component }, "PLUGIN_SLOT_UNKNOWN"],
    ["no component", { slot: "entryExtra" }, "PLUGIN_SLOT_INVALID_COMPONENT"],
    ["an element for a component", { slot: "entryExtra", component: {} }, "PLUGIN_SLOT_INVALID_COMPONENT"],
    ["positions on a sideless slot", { slot: "entryExtra", component, positions: ["left"] }, "PLUGIN_SLOT_INVALID_POSITION"],
    ["empty positions", { slot: "userAction", component, positions: [] }, "PLUGIN_SLOT_INVALID_POSITION"],
    ["an unknown side", { slot: "assistantAction", component, positions: ["top"] }, "PLUGIN_SLOT_INVALID_POSITION"],
    ["a bare side", { slot: "composerControl", component, positions: "left" }, "PLUGIN_SLOT_INVALID_POSITION"],
    ["a toolCard without a tool", { slot: "toolCard", component }, "PLUGIN_SLOT_INVALID_KEY"],
    ["a blank tool name", { slot: "toolCard", component, toolName: "  " }, "PLUGIN_SLOT_INVALID_KEY"],
    ["another plugin's tool", { slot: "toolCard", component, toolName: "search" }, "PLUGIN_SLOT_NOT_OWNED"],
    ["a qualified tool name", { slot: "toolCard", component, toolName: "plugin_demo_lab_lookup" }, "PLUGIN_SLOT_NOT_OWNED"],
    ["a blockRenderer without a language", { slot: "blockRenderer", component }, "PLUGIN_SLOT_INVALID_KEY"],
    ["another plugin's language", { slot: "blockRenderer", component, language: "demo.other:chart" }, "PLUGIN_SLOT_INVALID_KEY"],
    ["a bare language", { slot: "blockRenderer", component, language: "chart" }, "PLUGIN_SLOT_INVALID_KEY"],
    ["an empty suffix", { slot: "blockRenderer", component, language: "demo.lab:" }, "PLUGIN_SLOT_INVALID_KEY"],
    ["a suffix with a space", { slot: "blockRenderer", component, language: "demo.lab:bar chart" }, "PLUGIN_SLOT_INVALID_KEY"],
    ["a trigger without items", { slot: "composerTrigger", trigger: "#" }, "PLUGIN_SLOT_INVALID_COMPONENT"],
    ["a trigger with a component", { slot: "composerTrigger", trigger: "#", component }, "PLUGIN_SLOT_INVALID_COMPONENT"],
    ["a trigger with positions", { slot: "composerTrigger", trigger: "#", items: () => [], positions: ["left"] }, "PLUGIN_SLOT_INVALID_POSITION"],
    ["a trigger without a symbol", { slot: "composerTrigger", items: () => [] }, "PLUGIN_SLOT_INVALID_KEY"],
    ["a trigger of another symbol", { slot: "composerTrigger", trigger: "$", items: () => [] }, "PLUGIN_SLOT_INVALID_KEY"],
    ["a trigger of two symbols", { slot: "composerTrigger", trigger: "##", items: () => [] }, "PLUGIN_SLOT_INVALID_KEY"],
  ];
  const registry = new SlotRegistry();
  for (const [label, registration, code] of cases) {
    assert.throws(
      () => registry.register(PLUGIN, registration, ["lookup"]),
      refusedWith(code),
      label,
    );
  }
  assert.equal(registry.getSnapshot().version, 0);
  assert.deepEqual(registry.getSnapshot().entries, []);
  assert.deepEqual(registry.getSnapshot().triggers, []);
});

test("a tool card is keyed by the plugin's qualified tool name, first claim wins", () => {
  const registry = new SlotRegistry();
  const card = named("card");
  const disposeCard = registry.register(
    PLUGIN,
    { slot: "toolCard", component: card, toolName: "lookup" },
    ["lookup", "fetch"],
  );
  const [entry] = registry.entriesFor("toolCard");
  assert.equal(entry.key, "plugin_demo_lab_lookup");
  assert.equal(entry.toolName, "lookup");
  assert.equal(registry.entryForKey("toolCard", "plugin_demo_lab_lookup")?.component, card);
  assert.equal(registry.entryForKey("toolCard", "lookup"), undefined, "the bare name is not the key");

  assert.throws(
    () =>
      registry.register(PLUGIN, { slot: "toolCard", component: named("late"), toolName: "lookup" }, [
        "lookup",
      ]),
    refusedWith("PLUGIN_SLOT_DUPLICATE"),
  );
  assert.equal(registry.entryForKey("toolCard", "plugin_demo_lab_lookup")?.component, card);

  // Another plugin's tool of the same bare name is another key.
  const theirs = named("theirs");
  registry.register(OTHER, { slot: "toolCard", component: theirs, toolName: "lookup" }, ["lookup"]);
  assert.equal(registry.entryForKey("toolCard", "plugin_demo_other_lookup")?.component, theirs);
  assert.equal(registry.entryForKey("toolCard", "plugin_demo_lab_lookup")?.component, card);

  // The key frees up with its disposer.
  disposeCard();
  const next = named("next");
  registry.register(PLUGIN, { slot: "toolCard", component: next, toolName: "lookup" }, ["lookup"]);
  assert.equal(registry.entryForKey("toolCard", "plugin_demo_lab_lookup")?.component, next);
});

test("a block renderer is keyed by its normalized language tag, first claim wins", () => {
  const registry = new SlotRegistry();
  const chart = named("chart");
  registry.register(PLUGIN, { slot: "blockRenderer", component: chart, language: " Demo.Lab:Chart " }, []);
  const [entry] = registry.entriesFor("blockRenderer");
  assert.equal(entry.key, "demo.lab:chart");
  assert.equal(entry.toolName, undefined);
  assert.equal(registry.entryForKey("blockRenderer", "demo.lab:chart")?.component, chart);

  assert.throws(
    () =>
      registry.register(PLUGIN, { slot: "blockRenderer", component: named("late"), language: "demo.lab:CHART" }, []),
    refusedWith("PLUGIN_SLOT_DUPLICATE"),
  );
  registry.register(PLUGIN, { slot: "blockRenderer", component: named("table"), language: "demo.lab:table" }, []);
  assert.deepEqual(
    registry.entriesFor("blockRenderer").map((candidate) => candidate.key),
    ["demo.lab:chart", "demo.lab:table"],
  );
  // Keys are per slot: the same string never matches another slot's entry.
  assert.equal(registry.entryForKey("toolCard", "demo.lab:chart"), undefined);
});

test("a composer trigger is keyed by its symbol, full-width folded, first claim wins", () => {
  const registry = new SlotRegistry();
  const items = () => [];
  let notified = 0;
  registry.subscribe(() => {
    notified += 1;
  });
  const disposeHash = registry.register(PLUGIN, { slot: "composerTrigger", trigger: "\uFF03", items }, []);
  assert.equal(notified, 1);
  const hash = registry.triggerFor("#");
  assert.equal(hash?.pluginId, PLUGIN);
  assert.equal(hash?.trigger, "#");
  assert.equal(hash?.items, items);
  assert.equal("component" in hash, false, "a trigger registers no component");
  assert.deepEqual(registry.getSnapshot().entries, [], "triggers never reach component outlets");

  // One plugin per symbol, the same plugin included, whichever form it names.
  for (const [pluginId, trigger] of [[OTHER, "#"], [PLUGIN, "#"], [OTHER, "\uFF03"]]) {
    assert.throws(
      () => registry.register(pluginId, { slot: "composerTrigger", trigger, items }, []),
      refusedWith("PLUGIN_SLOT_DUPLICATE"),
      `${pluginId} ${trigger}`,
    );
  }
  assert.equal(notified, 1, "a refused claim publishes nothing");

  registry.register(OTHER, { slot: "composerTrigger", trigger: "@", items }, []);
  registry.register(PLUGIN, { slot: "composerTrigger", trigger: "/", items }, []);
  assert.deepEqual(
    registry.getSnapshot().triggers.map((entry) => [entry.trigger, entry.pluginId]),
    [["#", PLUGIN], ["@", OTHER], ["/", PLUGIN]],
  );

  // The symbol frees up with its disposer, once.
  disposeHash();
  disposeHash();
  assert.equal(registry.triggerFor("#"), undefined);
  assert.equal(registry.getSnapshot().triggers.length, 2);
  registry.register(OTHER, { slot: "composerTrigger", trigger: "#", items }, []);
  assert.equal(registry.triggerFor("#")?.pluginId, OTHER);
});
