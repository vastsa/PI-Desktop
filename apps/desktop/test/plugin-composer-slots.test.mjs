import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const here = dirname(fileURLToPath(import.meta.url));
const src = (relative) => join(here, "..", "src", relative);

const {
  detectPluginHashTrigger,
  pluginTokenAtLimit,
  serializePluginTokens,
  COMPOSER_PLUGIN_TOKEN_LIMIT,
} = await import("../src/features/chat/composer/plugin-trigger.ts");
const { normalizeFullWidthTrigger, formatPluginTriggerInsert } = await import(
  "@pi-desktop/shared"
);
const {
  registerComposerTriggerAccept,
  acceptComposerTriggerItem,
  resetComposerTriggerBridge,
} = await import("../src/features/chat/composer/trigger-bridge.ts");
const {
  insertComposerText,
  registerComposerInsert,
  resetComposerInsertBridge,
} = await import("../src/features/chat/composer/insert-bridge.ts");
const { SlotRegistry } = await import("../src/plugins/renderer-slots/registry.ts");

test.afterEach(() => {
  resetComposerTriggerBridge();
  resetComposerInsertBridge();
});

test("full-width trigger symbols normalize to ASCII", () => {
  assert.equal(normalizeFullWidthTrigger("＠file"), "@file");
  assert.equal(normalizeFullWidthTrigger("＃tag"), "#tag");
  assert.equal(normalizeFullWidthTrigger("／cmd"), "/cmd");
  assert.equal(normalizeFullWidthTrigger("plain"), "plain");
});

test("the # token fires only from line start or after whitespace", () => {
  // Line start.
  assert.deepEqual(detectPluginHashTrigger("#ta", 3), {
    query: "ta",
    tokenStart: 0,
    tokenEnd: 3,
  });
  // After whitespace.
  assert.deepEqual(detectPluginHashTrigger("hi #ta", 6), {
    query: "ta",
    tokenStart: 3,
    tokenEnd: 6,
  });
  // Mid-word never fires.
  assert.equal(detectPluginHashTrigger("abc#de", 6), null);
  // A bare # with no query still fires (empty query is valid).
  assert.deepEqual(detectPluginHashTrigger("#", 1), {
    query: "",
    tokenStart: 0,
    tokenEnd: 1,
  });
  // Not a # token at all.
  assert.equal(detectPluginHashTrigger("plain", 5), null);
});

test("plugin trigger items insert as #label chips", () => {
  assert.equal(formatPluginTriggerInsert("alpha"), "#alpha ");
});

test("the trigger bridge routes accept only while a menu is open", () => {
  // No listener: refused (UNROUTED upstream), never a silent drop.
  assert.equal(acceptComposerTriggerItem({ label: "x", value: 1 }), false);
  const received = [];
  registerComposerTriggerAccept((item) => received.push(item));
  assert.equal(acceptComposerTriggerItem({ label: "alpha", value: { a: 1 } }), true);
  assert.deepEqual(received, [{ label: "alpha", value: { a: 1 } }]);
  // Malformed payloads are refused.
  assert.equal(acceptComposerTriggerItem({ value: 1 }), false);
  assert.equal(acceptComposerTriggerItem(null), false);
  assert.equal(acceptComposerTriggerItem("nope"), false);
});

test("the insert bridge routes text into the mounted composer", () => {
  assert.equal(insertComposerText("hi"), false);
  const inserted = [];
  registerComposerInsert((text) => inserted.push(text));
  assert.equal(insertComposerText("hi"), true);
  assert.deepEqual(inserted, ["hi"]);
});

test("composerTrigger claims are keyed by symbol and @ / / stay host-owned", () => {
  const registry = new SlotRegistry();
  const component = () => null;
  registry.register("demo.ui-slots", "composerTrigger", component, { trigger: "#" });
  assert.equal(registry.entryForKey("composerTrigger", "#")?.pluginId, "demo.ui-slots");
  assert.throws(
    () =>
      registry.register("demo.other", "composerTrigger", component, { trigger: "#" }),
    (error) => error.code === "PLUGIN_SLOT_DUPLICATE",
  );
  // SDK vocabulary: only @ # / exist.
  const sdk = readFileSync(
    join(here, "../../../packages/plugin-sdk/src/renderer.ts"),
    "utf8",
  );
  assert.match(sdk, /PLUGIN_COMPOSER_TRIGGERS = \["@", "#", "\/"\] as const/);
  // 宿主先占: @ and / are host-owned; a plugin claim of either is refused
  // at registration (docs/plugin-plan/ui/composer/requirements.html:139).
  assert.match(sdk, /plugins claim "#"/);
  const registry2 = new SlotRegistry();
  assert.throws(
    () => registry2.register("demo.other", "composerTrigger", component, { trigger: "@" }),
    (error) => error.code === "PLUGIN_SLOT_INVALID_KEY",
  );
  assert.throws(
    () => registry2.register("demo.other", "composerTrigger", component, { trigger: "/" }),
    (error) => error.code === "PLUGIN_SLOT_INVALID_KEY",
  );
});
test("the token cap is 8; the ninth folds but the payload keeps everything", () => {
  assert.equal(COMPOSER_PLUGIN_TOKEN_LIMIT, 8);
  assert.equal(pluginTokenAtLimit(7), false);
  assert.equal(pluginTokenAtLimit(8), true);
  const payload = serializePluginTokens("draft text", [
    { pluginId: "p1", label: "one", send: { n: 1 } },
    { pluginId: "p2", label: "two", send: "x" },
  ]);
  assert.match(payload, /^draft text/);
  assert.match(payload, /#one #two/);
  assert.match(payload, /```pi-plugin-tokens\n/);
  assert.match(payload, /"pluginId":"p1"/);
  assert.match(payload, /"send":\{"n":1\}/);
  assert.match(payload, /"send":"x"/);
});

test("the composer wires trigger, tokens, and insert bridge", () => {
  const composer = readFileSync(src("components/Composer.tsx"), "utf8");
  assert.match(composer, /useComposerPluginTrigger\(/);
  assert.match(composer, /useComposerPluginTokens\(\)/);
  assert.match(composer, /useComposerTriggerAcceptBridge\(/);
  assert.match(composer, /registerComposerInsert\(/);
  assert.match(composer, /registerComposerInsert\(null\)/);
  assert.match(composer, /⧉ \+\{pluginTokens\.foldedCount\}/);
  // The trigger menu renders the plugin's own component with query+dispatch.
  assert.match(composer, /query: activeTrigger\.query/);
});

test("the toolbar mounts left and right control outlets", () => {
  const toolbar = readFileSync(src("features/chat/composer/ComposerToolbar.tsx"), "utf8");
  const leftAt = toolbar.indexOf('<div className="composer-left">');
  const rightAt = toolbar.indexOf('<div className="composer-right">');
  const leftGroup = toolbar.indexOf('<PluginControlGroup entries={leftControls} side="left" />');
  const rightGroup = toolbar.indexOf('<PluginControlGroup entries={rightControls} side="right" />');
  // 左槽＝左排固定件右边；右槽＝模型选择左边 (ui/composer/requirements.html:89-90).
  assert.ok(
    leftGroup > toolbar.indexOf("ComposerPermissionPicker") && leftGroup < rightAt,
    "left outlet sits after the host fixed controls, before composer-right",
  );
  assert.ok(
    rightGroup > rightAt && rightGroup < toolbar.indexOf("<ComposerModelPicker"),
    "right outlet sits before the model picker",
  );
  assert.match(toolbar, /useComposerControlEntries\("left"\)/);
  assert.match(toolbar, /useComposerControlEntries\("right"\)/);
  // Each control gets the position prop and its own relay.
  assert.match(toolbar, /position: side/);
  assert.match(toolbar, /dispatchFor\(entry\.pluginId\)/);
});

test("the trigger hook normalizes full-width symbols before detection", () => {
  // 全角归一化 wiring: the hook rewrites ＠＃／ to @#/ before running the
  // detector, so a full-width # fires the plugin trigger (data-flow:145).
  const hookSource = readFileSync(
    src("features/chat/composer/use-plugin-composer-slots.ts"),
    "utf8",
  );
  const normalizeAt = hookSource.indexOf("normalizeFullWidthTrigger(value)");
  const detectAt = hookSource.indexOf("detectPluginHashTrigger(normalized, cursor)");
  assert.ok(normalizeAt > -1, "hook must call normalizeFullWidthTrigger");
  assert.ok(detectAt > normalizeAt, "normalization must precede detection");
  assert.match(hookSource, /import \{ normalizeFullWidthTrigger \} from "@pi-desktop\/shared"/);
});

test("the trigger menu and token chips have host chrome styles", () => {
  // Without these the menu paints unpositioned inside the composer flow
  // and chips render as bare text (slot-shell.css).
  const shell = readFileSync(src("plugins/renderer-slots/slot-shell.css"), "utf8");
  assert.match(shell, /\.pi-plugin-trigger-menu \{[\s\S]*?position: absolute/);
  assert.match(shell, /\.pi-plugin-trigger-menu \{[\s\S]*?z-index: 30/);
  assert.match(shell, /\.pi-plugin-token-chips \{/);
  assert.match(shell, /\.pi-plugin-token-chip \{/);
  assert.match(shell, /\.pi-plugin-token-chip-remove \{/);
  assert.match(shell, /\.pi-plugin-token-chip\.is-fold \{/);
});

test("the composer mounts a composerToken outlet keyed by label", () => {
  // The composerToken slot had no host outlet: registrations were dead.
  // The chip renders the claiming plugin's component and falls back to the
  // host chip when no registration covers the label.
  const chip = readFileSync(src("features/chat/composer/ComposerTokenChip.tsx"), "utf8");
  assert.match(chip, /useSlotEntryForKey\("composerToken", token\.label\)/);
  assert.match(chip, /createElement\(/);
  const composer = readFileSync(src("components/Composer.tsx"), "utf8");
  assert.match(composer, /<ComposerTokenChip\b/);
});

test("the composer's plugin effects stay top-level and independent", () => {
  // Regression: an earlier edit nested the insert-bridge effect inside the
  // dock-height effect, so React committed the outer effect and called
  // useEffect from within its setup — crash-on-boot React error #321.
  const composer = readFileSync(src("components/Composer.tsx"), "utf8");
  const bridgeAt = composer.indexOf("registerComposerInsert((text)");
  const dockAt = composer.indexOf("const el = dockRef.current;");
  assert.ok(bridgeAt > -1 && dockAt > bridgeAt, "insert-bridge effect precedes the dock effect");
  const bridgeHead = composer.lastIndexOf("useEffect(() => {", bridgeAt);
  assert.ok(
    bridgeHead > -1 && !composer.slice(bridgeHead + 17, bridgeAt).includes("useEffect(() => {"),
    "insert-bridge effect opens with its own useEffect, not one inherited from another effect",
  );
});
