import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, path), "utf8");
const app = read("../src/App.tsx");
const rendererApi = read("../src/capture/renderer-api.ts");
const captureRig = read("../src/capture/capture-rig.ts");
const main = read("../src/main.tsx");
const windowControls = read("../src/components/WindowControls.tsx");
const pulls = read("../src/pages/PullRequestsPage.tsx");
const messages = read("../src/styles/messages.css");

test("screenshot fixtures stay out of the production App bundle", () => {
  // App only mounts the tiny automation surface; the fixtures are a separate
  // module reached through a dynamic import.
  assert.match(app, /useEffect\(\(\) => installRendererApi\(\), \[\]\);/);
  assert.doesNotMatch(app, /__PI_CAPTURE__|seedTranscript|ensureVisualFixtures|\(api as any\)/);
  assert.match(rendererApi, /import\("\.\/capture-rig"\)/);
  assert.match(rendererApi, /^import type \{[^}]*\} from "\.\/capture-rig";/m);
  assert.doesNotMatch(rendererApi, /^import \{[^}]*\} from "\.\/capture-rig";/m);
  // The e2e runner and capture suite reach these without any flag set.
  for (const name of [
    "setPage",
    "selectSession",
    "setSettingsTab",
    "showToast",
    "clearProject",
    "setThemeAttr",
    "refreshProviders",
  ]) {
    assert.match(rendererApi, new RegExp(`^    ${name}: `, "m"), name);
  }
  // Fixture stubs refuse to load the rig unless the capture flag is set, and
  // every fixture in the rig re-checks it before touching state.
  assert.match(rendererApi, /if \(!window\.__PI_CAPTURE__\) return undefined;/);
  const guards = captureRig.match(/if \(!window\.__PI_CAPTURE__\) return/g) ?? [];
  const fixtures = captureRig.match(/^    (?:seed\w+|ensureVisualFixtures|openWorkPanel\w*|collapseWorkPanel): /gm) ?? [];
  assert.ok(fixtures.length >= 13, `expected the fixture methods, saw ${fixtures.length}`);
  assert.ok(guards.length >= fixtures.length, "every fixture checks __PI_CAPTURE__");
  // Restoring the monkey-patched api.* calls is part of tearing the rig down.
  assert.match(captureRig, /dispose: \(\) => \{[\s\S]*api\.listPluginServices = originalListPluginServices;/);
});

test("the crash fallback never interprets the error as markup", () => {
  assert.doesNotMatch(main, /innerHTML/);
  assert.match(main, /detail\.textContent = String\(error\);/);
  assert.match(main, /heading\.textContent = crashCatalog\.app\.uiCrashed;/);
});

test("window controls draw through the icon wrappers", () => {
  assert.doesNotMatch(windowControls, /from "lucide-react"/);
  assert.match(windowControls, /import \{ IconClose, IconCopy, IconMinus, IconSquare \} from "\.\/icons";/);
});

test("pull request links open through the shared external-open path", () => {
  assert.doesNotMatch(pulls, /window\.open\(/);
  assert.match(pulls, /api\.browserOpenExternal\(pr\.url\)/);
});

test("attachment thumbnails are tone tiles, not stroked boxes (D297)", () => {
  const block = messages.slice(
    messages.indexOf(".message-attachment-image {"),
    messages.indexOf(".message-attachment-image img {"),
  );
  assert.doesNotMatch(block, /border(?:-color)?:/);
  assert.match(block, /background: var\(--ds-tile\);/);
  assert.match(block, /:hover \{[\s\S]*?background: var\(--ds-raised\);/);
});

test("dead components are gone", () => {
  assert.ok(!existsSync(join(here, "../src/components/Topbar.tsx")));
  assert.ok(!existsSync(join(here, "../src/components/HomeQuickActions.tsx")));
});
