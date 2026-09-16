/**
 * Chrome control geometry.
 *
 * Two families, one rule each:
 *  - icon-only `.icon-btn` uses state the square explicitly (`.icon-btn-square`),
 *    because `.icon-btn` is shared with label-driven pills and takes its width
 *    from its content — glyph plus padding;
 *  - the preview- and route-band lane actions take the shared chrome-control
 *    geometry (`.ct-icon-btn` group) instead of restating their own size.
 *
 * These are source contracts; the layout E2E measures the rendered rectangles.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();

/**
 * Files that host icon-only `.icon-btn` controls. Every `.icon-btn` line in
 * them is either icon-only (and therefore square) or a label-driven chip. Add a
 * file here when it starts using `.icon-btn` for an icon-only control.
 */
const ICON_BUTTON_FILES = [
  "../src/components/Sidebar.tsx",
  "../src/features/chat/composer/ComposerToolbar.tsx",
  "../src/components/workpanel/FilesTab.tsx",
  "../src/pages/PullRequestsPage.tsx",
  "../src/components/settings/ModelConfigPage.tsx",
];

/** Label-driven controls: their width is their text, not a square target. */
const CHIP_CLASSES = /mode-chip|composer-model-thinking-chip/;

async function readSources() {
  return Promise.all(
    ICON_BUTTON_FILES.map(async (path) => [
      path,
      await readFile(new URL(path, import.meta.url), "utf8"),
    ]),
  );
}

const squareRule = () =>
  styles.match(/\.icon-btn\.icon-btn-square\s*\{[^}]*\}/)?.[0] ?? "";

test("the square variant pins both axes and drops the label padding", () => {
  assert.match(styles, /--ds-control-size:\s*28px/);
  const rule = squareRule();
  assert.ok(rule, ".icon-btn.icon-btn-square rule is missing");
  assert.match(rule, /width:\s*var\(--ds-control-size\);/);
  assert.match(rule, /height:\s*var\(--ds-control-size\);/);
  // A crowded toolbar row must not shrink the control back out of square.
  assert.match(rule, /flex:\s*0 0 var\(--ds-control-size\);/);
  // Under the global `border-box`, keeping the 8px side padding would leave a
  // 12px content box for a 15px glyph.
  assert.match(rule, /padding:\s*0;/);
});

test("composer-right no longer widens its icon-only controls", () => {
  const rule =
    styles.match(/\.composer-right \.icon-btn\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(rule, ".composer-right .icon-btn rule is missing");
  assert.doesNotMatch(rule, /padding/);
});

test("the enhancing state leaves the square geometry for its label", () => {
  // It carries the label while enhancing, so it must outrank
  // `.icon-btn.icon-btn-square` — by classes in the selector, not `!important`.
  const rule =
    styles.match(
      /\.icon-btn\.composer-enhance-btn\.is-loading\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.ok(rule, "the labelled enhancing state rule is missing");
  assert.match(rule, /flex:\s*0 0 auto;/);
  assert.match(rule, /padding-inline:\s*8px;/);
});

test("every icon-only .icon-btn states the square", async () => {
  for (const [path, source] of await readSources()) {
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes("icon-btn")) continue;
      if (CHIP_CLASSES.test(line)) continue;
      assert.match(
        line,
        /icon-btn-square/,
        `${path}:${index + 1} is an icon-only control without .icon-btn-square`,
      );
    }
  }
});

/**
 * The shared chrome-control rule for a state suffix (`""` is the rest state),
 * e.g. `:hover:not(:disabled)`. The selectors are a group, so the rule has to be
 * read from its first member through its closing brace — reading from the last
 * member's ` {` stops working the moment a selector is appended.
 */
function sharedChromeControlRule(suffix = "") {
  const start = styles.indexOf(`\n.conversation-topbar .ct-icon-btn${suffix}`);
  assert.ok(start >= 0, `the shared chrome-control rule "${suffix}" is missing`);
  const open = styles.indexOf("{", start);
  return styles.slice(start, styles.indexOf("}", open) + 1);
}

/** Every selector the shared chrome-control rule covers. */
function sharedChromeControlMembers(suffix = "") {
  const rule = sharedChromeControlRule(suffix);
  return rule
    .slice(rule.indexOf("\n") + 1, rule.indexOf("{"))
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

test("the preview and route-band actions share the chrome control geometry", () => {
  for (const suffix of ["", ":hover:not(:disabled)", ":disabled"]) {
    const members = sharedChromeControlMembers(suffix);
    for (const container of [".main-titlebar", ".window-chrome-row"]) {
      assert.ok(
        members.includes(`${container} .title-nav-btn${suffix}`),
        `${container} actions are missing from the shared chrome-control ${suffix || "rest"} rule`,
      );
    }
  }
  // The topbar's dock toggle, the viewport-fixed panel toggle, and the lane
  // actions are the same control: one geometry, stated once.
  const shared = sharedChromeControlRule().replace(/^[^{]*\{/, "");
  assert.match(shared, /height:\s*var\(--ds-work-panel-toggle-size\)/);
  assert.match(shared, /width:\s*var\(--ds-work-panel-toggle-size\)/);
  // `flex: 0 0` keeps the control square when a crowded band squeezes it.
  assert.match(shared, /flex:\s*0 0 var\(--ds-work-panel-toggle-size\)/);
  assert.match(shared, /border-radius:\s*var\(--radius-md\)/);

  // The lane must not state its own size or seat again — that is what made it
  // render 22px wide next to 28px siblings.
  const lane = styles.match(/\n\.title-nav-btn \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(lane, ".title-nav-btn rule is missing");
  for (const declaration of ["height", "width", "border-radius", "background"]) {
    assert.doesNotMatch(
      lane,
      new RegExp(`(^|\\s)${declaration}:`),
      `the lane restates ${declaration}, which the shared group owns`,
    );
  }
});

/** Every `selector { … }` rule in the effective stylesheet, comments stripped. */
function allRules() {
  return (
    styles.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+\{[^{}]*\}/g) ?? []
  );
}

/** Every rule whose selector list names `selector` exactly. */
function rulesSelecting(selector) {
  return allRules().filter((rule) =>
    rule
      .slice(0, rule.indexOf("{"))
      .split(",")
      .some((candidate) => candidate.trim() === selector),
  );
}

/** The declaration body of one rule text. */
function ruleBody(rule) {
  return rule.slice(rule.indexOf("{") + 1);
}

test("the work-panel header controls take the shared seat, not one of their own", () => {
  // `+` and maximize sit in the panel header beside the viewport-fixed collapse
  // toggle, so they are members of the same family: 28px square, transparent at
  // rest, semantic hover wash, dimmed only when disabled. A `--ds-tile` seat of
  // their own turned the header into three filled squares.
  const members = sharedChromeControlMembers();
  for (const selector of [".work-panel-new-tab", ".work-panel-maximize"]) {
    assert.ok(
      members.includes(selector),
      `${selector} is not a member of the shared chrome-control group`,
    );
  }
  assert.match(sharedChromeControlRule(), /background:\s*transparent;/);
  assert.match(
    sharedChromeControlRule(),
    /transition:[^;]*var\(--motion-duration-fast\)/,
  );

  // Hover and disabled are the group's states too, so neither control can drift
  // back to a filled rest seat or lose its hover feedback on its own.
  assert.match(
    sharedChromeControlRule(":hover:not(:disabled)"),
    /background:\s*var\(--ds-bg-hover\);/,
  );
  assert.match(
    sharedChromeControlRule(":hover:not(:disabled)"),
    /color:\s*var\(--ds-text-primary\);/,
  );
  assert.match(sharedChromeControlRule(":disabled"), /opacity:\s*0\.4;/);

  // One geometry, stated once: every rule that names either control must be a
  // shared-family rule, and none of them may paint a tile or a raised seat.
  for (const selector of [".work-panel-new-tab", ".work-panel-maximize"]) {
    const own = rulesSelecting(selector);
    assert.ok(own.length > 0, `${selector} takes no rule at all`);
    for (const rule of own) {
      assert.match(
        rule,
        /\.conversation-topbar \.ct-icon-btn/,
        `${selector} has a rule outside the shared chrome-control group`,
      );
      assert.doesNotMatch(
        ruleBody(rule),
        /background:\s*var\(--ds-tile/,
        `${selector} paints a filled seat instead of the transparent seat`,
      );
      assert.doesNotMatch(
        ruleBody(rule),
        /box-shadow:/,
        `${selector} paints a raised seat instead of the transparent seat`,
      );
    }
  }
});

test("the pressed work-panel toggle keeps the transparent seat", () => {
  // The open state is the glyph swap plus the engaged ink. The raised pill this
  // used to paint floated over the panel header as a filled circular seat.
  const pressed =
    styles.match(
      /\.app-work-panel-toggle\[aria-pressed="true"\]\s*\{([^}]*)\}/,
    )?.[1] ?? "";
  assert.ok(pressed, "the pressed toggle rule is missing");
  assert.match(pressed, /color:\s*var\(--ds-text-primary\);/);
  assert.doesNotMatch(pressed, /background:/);
  assert.doesNotMatch(pressed, /box-shadow:/);
  assert.doesNotMatch(styles, /\.app-work-panel-toggle[^{}]*\{[^}]*--ds-raised-shadow/);
});

test("the preview action lane is derived from the control it reserves room for", () => {
  assert.match(
    styles,
    /--ds-preview-action-lane-width:\s*calc\(\s*2 \* var\(--ds-work-panel-toggle-size\)\s*\+\s*4px\s*\+\s*8px\s*\)/,
  );
});
