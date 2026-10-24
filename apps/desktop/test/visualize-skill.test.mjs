import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parseSkillFrontmatter } = await import("@pi-desktop/plugin-sdk");
const {
  assertBuiltinSkillEnabled,
  builtinSkillCatalog,
  builtinSkills,
  effectiveDisabledBuiltinSkills,
  loadBuiltinSkillBody,
} = await import("../electron/main/builtin-skills.ts");

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const VISUALIZE = "pi-desktop/visualize";

test("the visualize skill is active in local sessions and loads its contract", () => {
  assert.ok(builtinSkillCatalog().some((skill) => skill.id === VISUALIZE));
  const local = builtinSkills({ workspacePath: "/repo" });
  assert.equal(local.find((skill) => skill.id === VISUALIZE)?.name, "visualize");
  assert.ok(builtinSkills({}).some((skill) => skill.id === VISUALIZE));
  const body = loadBuiltinSkillBody(VISUALIZE).body;
  assert.match(body, /::visualize\{"path":/);
  assert.match(body, /fragment/i);
  assert.match(body, /no network/i);
});

test("the skill only names tokens, classes, and libraries the bundled kit provides", () => {
  const body = loadBuiltinSkillBody(VISUALIZE).body;
  const css = readFileSync(join(desktopRoot, "resources/gen-ui/visualize.css"), "utf8");
  const kit = readFileSync(join(desktopRoot, "resources/gen-ui/visualize-kit.html"), "utf8");
  const manifest = JSON.parse(readFileSync(join(desktopRoot, "resources/gen-ui/vendor/manifest.json"), "utf8"));
  // Theme tokens the skill tells the model to use are defined by the stylesheet.
  const tokens = new Set(body.match(/`--[a-z0-9-]+`/g)?.map((token) => token.slice(1, -1)));
  assert.ok(tokens.size > 20);
  for (const token of tokens) {
    assert.match(css, new RegExp(`${token}:`), token);
  }
  for (let i = 1; i <= 6; i += 1) assert.match(css, new RegExp(`--viz-series-${i}:`));
  // Utility classes the skill names exist in the stylesheet.
  const classes = new Set(body.match(/`\.[a-z][a-z0-9-]*/g)?.map((name) => name.slice(2)));
  assert.ok(classes.size > 20);
  for (const name of classes) assert.match(css, new RegExp(`\\.${name}\\b`), `.${name}`);
  // Tabs and tooltips are wired by the kit runtime.
  assert.match(kit, /pi-desktop-visualization-tabs/);
  assert.match(kit, /closest\("\[data-tooltip\]"\)/);
  // Every library URL in the skill is a bundled, pinned one.
  const bundled = new Set(manifest.resources.map((resource) => resource.url));
  const urls = body.match(/https:\/\/[^\s"'`<>]+/g) ?? [];
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(bundled.has(url), url);
  // Host APIs from the upstream kit that PI-Desktop does not provide.
  assert.doesNotMatch(body, /window\.zcode|widgetState|sendFollowUpMessage|openExternal|Tweak|lucide|viz-carousel|render\.py/);
});

test("remote-host sessions do not get the visualize skill", () => {
  const remote = builtinSkills({ workspacePath: "/remote/project", remote: true });
  assert.ok(!remote.some((skill) => skill.id === VISUALIZE));
  assert.ok(remote.some((skill) => skill.id === "pi-desktop/imagegen"));
});

test("users can disable the visualize skill like other built-ins", async () => {
  const skills = builtinSkills({ disabledIds: [VISUALIZE] });
  assert.ok(!skills.some((skill) => skill.id === VISUALIZE));
  await assert.rejects(
    assertBuiltinSkillEnabled(VISUALIZE, async () => [VISUALIZE]),
    /disabled in Settings/,
  );
  await assertBuiltinSkillEnabled(VISUALIZE, async () => []);
});

test("the inline-visualization switch withholds the skill unless it is on", () => {
  // The feature is opt-in: absent, false, or an unreadable setting all mean off.
  assert.deepEqual(effectiveDisabledBuiltinSkills([], false), [VISUALIZE]);
  assert.deepEqual(effectiveDisabledBuiltinSkills([], true), []);
  // A stored toggle stays visible in the list, and either source wins.
  assert.deepEqual(
    effectiveDisabledBuiltinSkills(["pi-desktop/imagegen"], true),
    ["pi-desktop/imagegen"],
  );
  assert.deepEqual(effectiveDisabledBuiltinSkills([VISUALIZE], true), [VISUALIZE]);
  assert.deepEqual(effectiveDisabledBuiltinSkills([VISUALIZE], false), [VISUALIZE]);
  // Withholding the skill is what keeps it out of the catalog.
  const off = builtinSkills({ disabledIds: effectiveDisabledBuiltinSkills([], false) });
  assert.ok(!off.some((skill) => skill.id === VISUALIZE));
  assert.ok(off.some((skill) => skill.id === "pi-desktop/imagegen"));
});

test("the visualize skill file has well-formed front matter and stays compact", () => {
  const raw = readFileSync(join(desktopRoot, "resources/skills/visualize.md"), "utf8");
  const parsed = parseSkillFrontmatter(raw);
  assert.equal(parsed.name, "visualize");
  assert.ok(parsed.description && parsed.description.length > 20);
  assert.ok(Buffer.byteLength(raw) < 12 * 1024);
});
