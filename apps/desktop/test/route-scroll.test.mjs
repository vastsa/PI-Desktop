import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const pagePaths = [
  "../src/pages/PluginsPage.tsx",
  "../src/pages/PullRequestsPage.tsx",
  "../src/pages/ScheduledPage.tsx",
];

const [stylesSource, ...pageSources] = await Promise.all([
  loadStyles(),
  ...pagePaths.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
]);

test("destination pages use a route scroller instead of the chat transcript scroller", () => {
  for (const [index, source] of pageSources.entries()) {
    assert.match(source, /className="route-scroll"/, pagePaths[index]);
    assert.doesNotMatch(source, /thread-scroll/, pagePaths[index]);
  }

  const routeRule = stylesSource.match(/\.route-scroll\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(routeRule, /overflow:\s*auto;/);
  assert.match(routeRule, /scrollbar-gutter:\s*stable;/);
  assert.doesNotMatch(routeRule, /mask-image/);

  const threadRule = stylesSource.match(/\.thread-scroll\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(threadRule, /-webkit-mask-image:/);
});
