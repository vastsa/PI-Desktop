import assert from "node:assert/strict";
import { readComposerSource, readPluginsSource } from "./helpers/source-contracts.mjs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();
const anchoredMenuSource = await readFile(
  new URL("../src/components/settings/AnchoredMenu.tsx", import.meta.url),
  "utf8",
);
const anchoredSurfaceSources = await Promise.all(
  [
    "../src/pages/ProjectsPage.tsx",
    readPluginsSource(),
    "../src/components/settings/AgentCapabilityLayout.tsx",
    "../src/components/extensions/ScopeControl.tsx",
    readComposerSource(),
    "../src/components/ComposerAutocomplete.tsx",
    "../src/components/PlanApprovalBar.tsx",
    "../src/components/HomeProjectSwitcher.tsx",
  ].map((source) =>
    typeof source === "string" && source.startsWith("../")
      ? readFile(new URL(source, import.meta.url), "utf8")
      : source,
  ),
);

const dropdownSurfaces = [
  "settings-font-menu",
  "settings-theme-menu",
  "provider-service-menu",
  "model-default-menu",
  "provider-model-multi-menu",
  "provider-model-menu",
  "notification-popover",
  "sidebar-row-menu",
  "sidebar-popover",
  "projects-menu",
  "plugins-menu",
  "agent-capability-menu",
  "scope-compact-menu",
  "scope-popover",
  "composer-permission-menu",
  "composer-model-menu",
  "plan-approval-menu",
  "composer-autocomplete",
  "context-inspector-popover",
  "home-project-switcher-menu",
];

function findSurfaceRule(className) {
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.find(([, selector, body]) =>
    selector.includes(`.${className}`) && /position:\s*fixed/.test(body),
  )?.[2];
}

test("renderer-owned dropdown surfaces are fixed and out of layout flow", () => {
  for (const className of dropdownSurfaces) {
    const body = findSurfaceRule(className);
    assert.ok(body, `missing fixed rule for .${className}`);
    assert.doesNotMatch(body, /position:\s*absolute/);
  }
});

test("anchored menus portal, measure, and reposition without reflowing parents", () => {
  assert.match(anchoredMenuSource, /createPortal\(/);
  assert.match(anchoredMenuSource, /document\.body/);
  assert.match(anchoredMenuSource, /ResizeObserver/);
  assert.match(anchoredMenuSource, /addEventListener\("scroll", onViewportChange, true\)/);
  assert.match(anchoredMenuSource, /visibility: hidden/);
  assert.match(anchoredMenuSource, /anchorRef\?\.current/);
});

test("custom page and composer menus use the shared anchored surface", () => {
  for (const source of anchoredSurfaceSources) {
    assert.match(source, /<AnchoredMenu/);
  }
});
