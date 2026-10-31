import assert from "node:assert/strict";
import test from "node:test";
import { loadStylesSync } from "./helpers/styles.mjs";

/**
 * Idle status indicators must not keep submitting frames.
 *
 * Any continuously animating indicator keeps the window surface dirty, and a
 * continuously dirty window is recomposited every frame by WindowServer — a
 * 7px dot was enough to drive GPU to ~70% on an otherwise idle desktop. See
 * issue #1064 and `04-ux/07-ui-design-system.md` (sidebar status marks).
 *
 * The macOS window is opaque (ADR 0332): it no longer stacks a vibrancy
 * material behind a transparent surface, which removes the extra composition
 * cost claimed here historically. The rule still holds — unbounded idle
 * animations are a GPU regression on every platform.
 */

const styles = loadStylesSync();

function declarationBlock(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule block for ${selector}`);
  const end = styles.indexOf("}", start);
  assert.ok(end > start, `unterminated rule block for ${selector}`);
  return styles.slice(start, end + 1);
}

function containedRule(scope, selector) {
  const start = scope.indexOf(`${selector} {`);
  if (start < 0) return null;
  const end = scope.indexOf("}", start);
  return scope.slice(start, end + 1);
}

/** Every top-level `@media (prefers-reduced-motion: reduce)` block, by brace. */
function reducedMotionBlocks() {
  const marker = "@media (prefers-reduced-motion: reduce) {";
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = styles.indexOf(marker, from);
    if (start < 0) return blocks;
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      else if (styles[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(styles.slice(start, index + 1));
    from = index + 1;
  }
}

// Running marks were bounded by #1064; the rest stay mounted while nothing is
// running (a session waiting on permission, plan mode left on, a backend
// warning banner), so they kept animating on an idle window.
const IDLE_INDICATORS = [
  ".thread-item-status.running::before",
  ".sidebar-session-hover-card-session-link-status::before",
  ".thread-item-status.permission::before",
  '.composer-mode-chip[data-planning="true"] svg',
  ".backend-banner.warn .backend-dot",
];

test("idle status indicators stop submitting frames", () => {
  for (const selector of IDLE_INDICATORS) {
    const block = declarationBlock(selector);
    assert.doesNotMatch(
      block,
      /infinite/,
      `${selector} must not animate forever while the window is idle`,
    );
    assert.match(
      block,
      /animation:[^;]*\b[12];/,
      `${selector} must keep a finite cycle count`,
    );
  }
});

test("idle status indicators honour reduced motion", () => {
  const blocks = reducedMotionBlocks();
  for (const selector of IDLE_INDICATORS) {
    const rule = blocks
      .map((block) => containedRule(block, selector))
      .find((candidate) => candidate !== null);
    assert.ok(rule, `${selector} needs a prefers-reduced-motion fallback`);
    assert.match(
      rule,
      /animation: none/,
      `${selector} must disable its animation under reduced motion`,
    );
  }
});
