import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await build({ stdin: { resolveDir: root, contents: `
export { ComposerPermissionPicker } from './apps/desktop/src/features/chat/composer/ComposerPermissionPicker';
export { composerSessionPolicy } from './apps/desktop/src/features/chat/composer/session-policy';
export { renderToStaticMarkup } from 'react-dom/server';
export { createElement } from 'react';
` }, bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  nodePaths: [path.join(root, "apps/desktop/node_modules")], alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") } });
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { ComposerPermissionPicker, composerSessionPolicy, renderToStaticMarkup, createElement } = module.exports;
const modes = ["agent", "plan", "goal"];
const permissions = ["ask", "accept-edits", "auto"];

for (const mode of modes) {
  test(`${mode}: actual permission picker opens, displays and selects each permission without escalation`, async () => {
    for (const permissionMode of permissions) {
      const policy = composerSessionPolicy({ mode, permissionMode, defaultPermissionMode: "auto", isRunning: true, planningState: "planning" });
      assert.equal(policy.composerPermissionMode, permissionMode);
      let open = false; const selected = []; let closes = 0;
      const props = { t: (key) => key, mode, ...policy, permissionOpen: open, controlsBlocked: false,
        setPermissionOpen: (value) => { open = typeof value === "function" ? value(open) : value; },
        onCloseOtherMenus: () => closes++, onSelect: async (value) => selected.push(value) };
      const markup = renderToStaticMarkup(createElement(ComposerPermissionPicker, props));
      assert.match(markup, /aria-haspopup="menu"/);
      assert.doesNotMatch(markup, / disabled=""/);
      assert.doesNotMatch(markup, /goal.autoWarning/);
      const menu = ComposerPermissionPicker(props);
      const trigger = menu.props.trigger(null);
      trigger.props.onClick();
      assert.equal(open, true); assert.equal(closes, 1); assert.deepEqual(selected, []);
      const opened = ComposerPermissionPicker({ ...props, permissionOpen: open });
      assert.equal(opened.props.open, true);
      const choices = opened.props.children;
      assert.equal(choices.length, 3);
      assert.deepEqual(choices.filter((choice) => choice.props["aria-checked"]).map((choice) => choice.key), [permissionMode]);
      for (const [index, candidate] of permissions.entries()) {
        await choices[index].props.onClick();
        assert.equal(open, false); assert.equal(selected.at(-1), candidate);
      }
      const blocked = renderToStaticMarkup(createElement(ComposerPermissionPicker, { ...props, controlsBlocked: true }));
      assert.match(blocked, / disabled=""/);
    }
  });
  test(`${mode}: inherited permission follows the selected global value and only Plan projects planning`, () => {
    for (const defaultPermissionMode of permissions) {
      for (const permissionMode of ["inherit", undefined]) {
        const policy = composerSessionPolicy({ mode, permissionMode, defaultPermissionMode, isRunning: true, planningState: "planning" });
        assert.equal(policy.composerPermissionMode, defaultPermissionMode);
        assert.equal(policy.planningLive, mode === "plan");
      }
    }
    assert.equal(composerSessionPolicy({ mode, permissionMode: undefined, defaultPermissionMode: undefined, isRunning: false }).composerPermissionMode, "ask");
    assert.equal(composerSessionPolicy({ mode, permissionMode: "ask", defaultPermissionMode: "auto", isRunning: true, planningState: "awaiting_approval" }).planningLive, false);
  });
}

test("Composer wires the tested policy without a second Goal permission override", async () => {
  const source = await readFile(path.join(root, "apps/desktop/src/components/Composer.tsx"), "utf8");
  assert.match(source, /const \{ planningLive, composerPermissionMode \} = composerSessionPolicy\(/);
  assert.match(source, /composerPermissionMode=\{composerPermissionMode\}/);
  assert.doesNotMatch(source, /mode === "goal" \? "auto"/);
});
