import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const LOCALES = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

const [capsule, shared, css, componentSpec, ...catalogs] = await Promise.all([
  read("../src/features/chat/transcript/TurnUsageCapsule.tsx"),
  read("../src/features/chat/transcript/shared.tsx"),
  read("../src/styles/messages.css"),
  read("../../../docs/spec/04-ux/08-component-spec.md"),
  ...LOCALES.map((locale) =>
    read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
  ),
]);

test("MessageMeta places the capsule immediately after the model chip", () => {
  const modelChip = shared.indexOf("message-meta-chip model");
  const capsuleUsage = shared.indexOf("<TurnUsageCapsule");
  assert.ok(modelChip > -1, "the model chip is still rendered");
  assert.ok(capsuleUsage > modelChip, "the capsule follows the model chip");
  assert.match(
    shared,
    /message-meta-chip model[\s\S]{0,400}?<TurnUsageCapsule/,
  );
  assert.doesNotMatch(shared, /<TurnUsageCapsule[\s\S]{0,200}?message-meta-chip model/);
});

test("the capsule renders only from turn usage and replaces the legacy chip", () => {
  assert.match(shared, /turnUsageBreakdown\(usage\)\.totalTokens > 0/);
  assert.match(shared, /usage && showTurnUsage/);
  assert.match(shared, /responseOutputEstimated/);
  assert.match(shared, /estimated=\{responseOutputEstimated\}/);
  assert.match(capsule, /estimated\s*\?/);
  assert.match(capsule, /chat\.usageThroughputEstimated/);
  assert.match(shared, /const showThroughput = !usage && throughput !== undefined/);
  assert.match(shared, /showThroughput \? \(/);
  assert.match(shared, /!modelId && !showThroughput && !showTurnUsage/);
});

test("the capsule wires hover, focus, grace close, Escape, and outside press", () => {
  assert.match(capsule, /const CLOSE_DELAY_MS = 120/);
  assert.match(capsule, /onPointerEnter/);
  assert.match(capsule, /onPointerLeave/);
  assert.match(capsule, /onFocus=\{openPopover\}/);
  assert.match(capsule, /onBlur=\{scheduleClose\}/);
  assert.match(capsule, /onClick=\{openPopover\}/);
  assert.match(capsule, /overTriggerRef\.current/);
  assert.match(capsule, /overPanelRef\.current/);
  assert.match(capsule, /document\.activeElement === triggerRef\.current/);
  assert.match(capsule, /event\.key !== "Escape"/);
  assert.match(capsule, /window\.setTimeout\(/);
  assert.match(
    capsule,
    /addEventListener\("pointerdown", handlePointerDown, true\)/,
  );
});

test("the popover portals to body and clamps to the conversation pane", () => {
  assert.match(capsule, /useId\(\)/);
  assert.match(capsule, /portalToBody\(popover\)/);
  assert.match(capsule, /placeContextInspector\(\{/);
  assert.doesNotMatch(capsule, /prefer:/);
  assert.match(capsule, /closest\("\.main-pane"\)/);
  assert.match(capsule, /new ResizeObserver\(updatePosition\)/);
  assert.match(capsule, /addEventListener\("scroll", handleViewportChange, true\)/);
  assert.match(capsule, /addEventListener\("resize", handleViewportChange\)/);
  assert.match(capsule, /triggerRect\.bottom <= 0/);
  assert.match(capsule, /const popover = open \?/);
});

test("the capsule exposes dialog semantics and an accessible turn summary", () => {
  assert.match(capsule, /aria-haspopup="dialog"/);
  assert.match(capsule, /aria-expanded=\{open\}/);
  assert.match(capsule, /aria-controls=\{open \? panelId : undefined\}/);
  assert.match(capsule, /aria-label=\{t\("chat\.usageTurnAria"/);
  assert.match(capsule, /role="dialog"/);
  assert.match(capsule, /aria-label=\{t\("chat\.usageTurnTotal"\)\}/);
  assert.match(capsule, /aria-hidden="true"/);
  assert.match(capsule, /new Intl\.NumberFormat\(i18n\.language\)/);
  assert.match(capsule, /formatCompactTokenCount/);
});

test("the composition omits empty segments and keeps cache write conditional", () => {
  assert.match(capsule, /filter\(\(segment\) => segment\.tokens > 0\)/);
  assert.match(capsule, /className=\{`turn-usage-seg \$\{segment\.key\}`\}/);
  assert.match(capsule, /style=\{\{ flexGrow: segment\.tokens \}\}/);
  assert.match(capsule, /breakdown\.cacheWriteTokens > 0 \?/);
  assert.match(capsule, /className="turn-usage-bar"/);
});

test("the capsule styles use surface tokens and match the meta chip height", () => {
  const capsuleRule = css.match(/\.turn-usage-capsule \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(capsuleRule, /min-height: 20px/);
  assert.match(capsuleRule, /padding: 0 8px/);
  assert.match(capsuleRule, /gap: 6px/);
  assert.match(capsuleRule, /font-size: var\(--text-xs\)/);
  assert.match(capsuleRule, /line-height: var\(--leading-compact\)/);
  assert.match(capsuleRule, /font-variant-numeric: tabular-nums/);
  assert.match(capsuleRule, /white-space: nowrap/);
  assert.match(capsuleRule, /max-width: 100%/);
  assert.match(capsuleRule, /background: var\(--ds-tile\)/);

  const hoverRule =
    css.match(
      /\.turn-usage-capsule:hover,\n\.turn-usage-capsule\[data-open="true"\] \{[\s\S]*?\n\}/,
    )?.[0] ?? "";
  assert.match(hoverRule, /background: var\(--ds-tile-hover\)/);
  assert.match(hoverRule, /inset 0 0 0 1px var\(--ds-border-subtle\)/);

  const barRule = css.match(/\.turn-usage-bar \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(barRule, /width: 36px/);
  assert.match(barRule, /height: 4px/);

  const segmentRule = css.match(/\.turn-usage-seg \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(segmentRule, /flex-basis: 0/);
  for (const key of ["cache", "input", "output", "write"]) {
    assert.match(css, new RegExp(`\\.turn-usage-seg\\.${key} \\{`));
  }
  for (const key of ["cache", "input", "output", "write"]) {
    assert.match(
      css,
      new RegExp(
        `\\.turn-usage-seg\\.${key} \\{\\s*background: color-mix\\(in oklab, var\\(--ds-text-primary\\)`,
      ),
    );
  }

  const popoverRule =
    css.match(/\.turn-usage-popover \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(popoverRule, /position: fixed/);
  assert.match(popoverRule, /z-index: 60/);
  assert.match(popoverRule, /width: min\(268px, calc\(100vw - 32px\)\)/);
  assert.match(popoverRule, /background: var\(--ds-bg-elevated-opaque\)/);
  assert.match(popoverRule, /border: 1px solid var\(--ds-border-default\)/);
  assert.match(popoverRule, /border-radius: var\(--radius-md-plus\)/);
  assert.match(popoverRule, /padding: 12px/);
  assert.match(popoverRule, /box-shadow: var\(--ds-shadow-dialog\)/);
  assert.match(css, /\.turn-usage-popover\.is-open \{/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.turn-usage-capsule,\s*\.turn-usage-popover \{\s*transition: none;/,
  );

  const newBlock = css.slice(
    css.indexOf(".turn-usage-capsule {"),
    css.indexOf(".context-inspector {"),
  );
  assert.doesNotMatch(newBlock, /#[\da-f]{3,8}\b/i);
});

test("every locale adds the turn aria label and total label exactly once", () => {
  for (const [index, locale] of LOCALES.entries()) {
    const source = catalogs[index];
    assert.equal(
      (source.match(/"?usageTurnAria"?\s*:/g) ?? []).length,
      1,
      `${locale} defines usageTurnAria once`,
    );
    assert.equal(
      (source.match(/"?usageTotal"?\s*:/g) ?? []).length,
      1,
      `${locale} defines usageTotal once`,
    );
    assert.match(
      source,
      /"?usageTurnAria"?\s*:\s*"[^"]*\{\{speed\}\}[^"]*\{\{count\}\}[^"]*"/,
      `${locale} keeps speed and count placeholders`,
    );
  }
});

test("the component spec documents the capsule aggregate and its boundary", () => {
  assert.match(componentSpec, /turn usage capsule/i);
  assert.match(componentSpec, /summed\s+across the visual turn's assistant messages/);
  assert.match(componentSpec, /reasoning tokens/);
  assert.match(
    componentSpec,
    /last-request\s+occupancy stays deliberately distinct/,
  );
});
