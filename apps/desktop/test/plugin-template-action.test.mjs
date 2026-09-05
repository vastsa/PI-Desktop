import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStylesSync } from "./helpers/styles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const mainSrc = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");
const apiSrc = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
const pageSrc = readFileSync(join(desktopRoot, "src/pages/PluginsPage.tsx"), "utf8");
const stylesSrc = loadStylesSync();
const protocolSrc = readFileSync(
  join(repoRoot, "packages/shared/src/protocol.ts"),
  "utf8",
);
const templatesSrc = readFileSync(
  join(repoRoot, "packages/plugin-devkit/src/templates.ts"),
  "utf8",
);
const enSrc = readFileSync(
  join(repoRoot, "packages/i18n/src/locales/en/index.ts"),
  "utf8",
);
const zhSrc = readFileSync(
  join(repoRoot, "packages/i18n/src/locales/zh-CN/index.ts"),
  "utf8",
);
const trSrc = readFileSync(
  join(repoRoot, "packages/i18n/src/locales/tr/index.ts"),
  "utf8",
);

/** Template ids in declaration order, read from a `[...] as const` literal. */
function templateIds(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} missing`);
  const literal = source.slice(start, source.indexOf("] as const", start));
  return [...literal.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
}

test("the template channel travels the same path as loadDev", () => {
  assert.match(
    protocolSrc,
    /pluginCreateFromTemplate: "pi-desktop\/plugin\/createFromTemplate"/,
  );
  // IPC_WHITELIST is derived from the table, so the preload gate needs no edit.
  assert.match(protocolSrc, /IPC_WHITELIST = new Set<string>\(\[\s*\.\.\.Object\.values\(IPC\.invoke\)/);
  assert.match(
    apiSrc,
    /createPluginFromTemplate:[\s\S]*IPC\.invoke\.pluginCreateFromTemplate, \{ template \}/,
  );
});

test("main validates the template and loads what it scaffolds", () => {
  const handler = mainSrc.slice(
    mainSrc.indexOf("IPC.invoke.pluginCreateFromTemplate"),
    mainSrc.indexOf("IPC.invoke.pluginInstallFromPath"),
  );
  // The renderer picks a label; only the devkit decides what a template is.
  assert.match(handler, /isTemplateName\(template\)/);
  assert.match(handler, /properties: \["openDirectory", "createDirectory"\]/);
  assert.match(handler, /return \{ canceled: true \}/);
  // Scaffold, then register as a dev plugin so the first edit is a hot reload.
  assert.ok(
    handler.indexOf("scaffold({ dir, template })") <
      handler.indexOf('host.call<{ plugin: any }>("plugins.loadDev"'),
  );
  assert.match(
    handler,
    /plugins\.loadFromPath\(dir, loaded\.plugin\?\.permissions \?\? \[\], \{\s*development: true,\s*\}\)/,
  );
  assert.match(handler, /plugins\.drainToasts\(\)/);
});

test("the renderer template list mirrors the devkit catalogue", () => {
  const devkit = templateIds(templatesSrc, "export const TEMPLATE_NAMES = [");
  const page = templateIds(pageSrc, "const TEMPLATE_IDS = [");
  assert.deepEqual(page, devkit);
  // Every id needs a label and a description in both locales.
  for (const id of devkit) {
    for (const [locale, source] of [
      ["en", enSrc],
      ["zh-CN", zhSrc],
      ["tr", trSrc],
    ]) {
      assert.ok(
        source.includes(`"${id}":`),
        `${locale} must name and describe the ${id} template`,
      );
    }
  }
});

test("the template action is reachable from the menu and the empty state", () => {
  assert.match(pageSrc, /\{ key: "installPackage", run: installPackage \}/);
  assert.match(pageSrc, /key: "newFromTemplate"/);
  assert.match(pageSrc, /onClick=\{\(\) => setTemplatePick\(TEMPLATE_IDS\[0\]\)\}/);
  for (const key of [
    "newFromTemplate",
    "newFromTemplateTitle",
    "newFromTemplateBody",
    "newFromTemplateHint",
    "newFromTemplateCreate",
    "newFromTemplateCreating",
    "newFromTemplateDone",
    "newFromTemplateOpened",
  ]) {
    assert.ok(enSrc.includes(`${key}:`), `en must define plugins.${key}`);
    assert.ok(zhSrc.includes(`${key}:`), `zh-CN must define plugins.${key}`);
    assert.ok(trSrc.includes(`${key}:`), `tr must define plugins.${key}`);
  }
});

test("the scaffolded folder is opened as the project", () => {
  const create = pageSrc.slice(
    pageSrc.indexOf("const createFromTemplate ="),
    pageSrc.indexOf("const checkUpdates ="),
  );
  // Loading the plugin is not enough: development needs the folder open, which
  // is what activateProject does (workspace.set plus a switch to chat).
  assert.match(create, /await activateProject\(created\.dir\)/);
  assert.match(pageSrc, /const activateProject = useAppStore\(\(s\) => s\.activateProject\)/);
  // The success toast tells the truth about whether the folder actually opened.
  assert.ok(
    create.indexOf("activateProject(created.dir)") <
      create.indexOf("plugins.newFromTemplateOpened"),
  );
  assert.match(create, /plugins\.newFromTemplateOpened[\s\S]*plugins\.newFromTemplateDone/);
  // A folder that refuses to open must not erase the created-and-loaded result.
  assert.match(create, /openError = e/);
});

test("a canceled folder picker is not reported as a success", () => {
  const create = pageSrc.slice(
    pageSrc.indexOf("const createFromTemplate ="),
    pageSrc.indexOf("const checkUpdates ="),
  );
  assert.ok(
    create.indexOf("if (created.canceled) return;") <
      create.indexOf("plugins.newFromTemplateDone"),
  );
  // Failures land in a toast, never as an unhandled rejection.
  assert.match(create, /variant: "error"/);
  assert.match(create, /setCreating\(false\)/);
});

test("the template picker styles use design tokens", () => {
  assert.match(stylesSrc, /\.plugins-template\.active\s*\{[\s\S]*?color-mix\(in oklab/);
  assert.match(stylesSrc, /\.plugins-template-name\s*\{[\s\S]*?--ds-text-primary/);
  assert.match(stylesSrc, /\.plugins-template-body\s*\{[\s\S]*?--ds-text-muted/);
});
