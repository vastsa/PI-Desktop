/**
 * Surface-colour guard for the renderer stylesheets (issue #341, extends #339).
 *
 * Two rules:
 *
 *  1. THEME OVERRIDE RULE — inside a `:root[data-theme="…"]` rule every colour
 *     declaration in `COLOR_PROPERTIES` (plus `box-shadow`) must resolve through
 *     a custom property. A literal there both raises specificity above the base
 *     token rule and skips the variable, so the surface is pinned out of every
 *     contributed theme's reach (D419). Custom-property definitions are allowed
 *     when the rule *is* a theme root (`:root`, `:root[data-theme="…"]`): the
 *     token blocks are exactly where literal values belong. A custom property
 *     holding a literal colour on any other selector is a violation, because it
 *     shadows the root token for that subtree.
 *     Custom-property definitions are allowed when the rule *is* a theme root
 *     (`:root`, `:root[data-theme="…"]`): the token blocks are exactly where
 *     literal values belong. A custom property holding a literal colour on any
 *     other selector is a violation, because it shadows the root token for that
 *     subtree.
 *
 *  2. CHROME FAMILY RULE — the base rules of the chrome families migrated in
 *     #339/#341 (settings rail, settings search, settings nav item, switch
 *     thumb, agent-capability search, plugin search, composer shell, and the
 *     prose / code-card / Mermaid / scrim / tool-row / send-button /
 *     placeholder families tokenized in this batch) must not paint a literal
 *     colour either. This rule covers that fixed family list, not every
 *     selector in the renderer: it catches a regression in a migrated surface,
 *     not a brand-new literal on a selector nobody has reviewed yet.
 *
 * Exemptions are enumerated here with reasons instead of being invisible gaps:
 *
 *  - `SHIKI_PALETTE` — the `one-dark-pro` / `one-light` syntax plate and its
 *    ink are authored by the Shiki theme the renderer selects
 *    (`apps/desktop/src/lib/shiki.ts`: `THEMES = { light: "one-light",
 *    dark: "one-dark-pro" }`) and are emitted as inline colours on the
 *    highlighted markup. A CSS token could only move the plate and leave the
 *    token colours behind, so the pair has to move together (through the Shiki
 *    theme), not through `--ds-*`.
 *  - `BOX_SHADOW_ALPHA` — a shadow only offsets darkness, so a black- or
 *    white-alpha shadow value is allowed. A background/scrim that is a black
 *    mix still paints a surface and is checked.
 *  - `ALLOWED_LITERALS` — base-rule fills the guard deliberately allows, each
 *    with the decision it answers to.
 *
 * Known boundary: this guard is static CSS text analysis. It cannot see a
 * cascade conflict between two token rules (#339's root cause) or a plugin's
 * own stylesheet; `pnpm test:e2e:theme-surfaces` covers the rendered cascade.
 */

/** Selectors whose base rules must not paint a literal colour (rule 2). */
const CHROME_FAMILY =
  /\.(?:settings-nav|settings-search|settings-nav-item|settings-toggle-thumb|agent-capability-search-wrap|plugins-search|composer-shell|prose-chat|thinking-prose|code-block|code-block-head|code-block-lang|mermaid-block|mermaid-block-body|mermaid-block-head|mermaid-block-title|mermaid-block-error|mermaid-source|overlay|search-overlay|plugins-modal-backdrop|tool-row-content|send-btn|empty-hero|composer-placeholder|composer-input|mode-chip|composer-toolbar)(?![\w-])/;

/** A selector that is a theme root: `:root` or `:root[data-theme="…"]`. */
const THEME_ROOT = /^:root(?:\[data-theme=["'][^"']*["']\])?$/;

/** Colour literals: hex, colour functions, and the `white` / `black` keywords. */
const LITERAL = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black)\b/i;

/** Shadow colours that only offset darkness, so they carry no palette. */
const BOX_SHADOW_ALPHA =
  /#(?:0{6}|f{6})(?!f{2})[\da-f]{2}\b|\b(?:rgba|rgb)\(\s*0\s*[, ]\s*0\s*[, ]\s*0\s*[,/]\s*[\d.]+%?\s*\)|\b(?:rgba|rgb)\(\s*255\s*[, ]\s*255\s*[, ]\s*255\s*[,/]\s*[\d.]+%?\s*\)/gi;

/** one-dark-pro / one-light plate and ink (see the file header). */
const SHIKI_PALETTE = /#(?:282c34|abb2bf|383a42|fafafa|d7dae0)\b/gi;

const KEYWORDS = /\b(?:transparent|currentcolor|inherit|initial|unset|revert|none)\b/gi;

const COLOR_PROPERTIES =
  /^(?:color|background|background-color|background-image|text-decoration-color|-webkit-text-fill-color|border|border-(?:top|right|bottom|left)|border-color|border-(?:top|right|bottom|left)-color|outline|outline-color|fill|stroke|text-shadow|filter|accent-color|caret-color)$/;

/**
 * Literals the guard deliberately allows, each with the reason it answers to.
 * Keyed by the selector text the declaration appears in.
 */
export const ALLOWED_LITERALS = [
  {
    selector: /\.search-overlay/,
    property: "background",
    reason:
      "The ⌘K spotlight has never had a light override and keeps the dark 45% black veil in both palettes. §8.4/D148 give the light scrim ~28% #1a1c1f 'so white dialogs do not sit under a heavy veil', and .search-dialog is --ds-bg-elevated-opaque white, so tokenizing this value either changes built-in light paint or records a value the design system does not own. A maintainer call, recorded here instead of guessed (issue #341).",
  },
];

function replaceAll(value, patterns) {
  let out = value;
  for (const pattern of patterns) out = out.replace(pattern, " ");
  return out;
}

/** Drop everything that is not a bare colour literal, then test what remains. */
function residualLiterals(value, { shadow }) {
  let out = value;
  let previous;
  do {
    previous = out;
    out = out.replace(/var\([^()]*\)/g, " ");
  } while (out !== previous);
  out = replaceAll(out, [SHIKI_PALETTE, KEYWORDS]);
  if (shadow) out = out.replace(BOX_SHADOW_ALPHA, " ");
  // `color-mix(...)` is only a container: the colours it mixes have already
  // been kept or stripped above.
  return out;
}

function allowed(selector, property) {
  return ALLOWED_LITERALS.some(
    (entry) => entry.selector.test(selector) && entry.property === property,
  );
}
/**
 * Report literal surface colours in a stylesheet.
 * @param {string} css
 * @returns {Array<{line: number, property: string, value: string, reason: string}>}
 */
export function findLiteralSurfaceColors(css) {
  // Retain newlines so diagnostics keep their source line numbers.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const violations = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    const isThemeOverride = /data-theme/.test(selector);
    const isThemeRoot = isThemeOverride && selector.split(",").some((part) => THEME_ROOT.test(part.trim()));
    const inChromeFamily = CHROME_FAMILY.test(selector);
    if (!isThemeOverride && !inChromeFamily) continue;
    for (const declaration of rule[2].matchAll(/([-\w]+)\s*:\s*([^;{}]+)/g)) {
      const [, property, raw] = declaration;
      const value = raw.trim();
      const isCustomProperty = property.startsWith("--");
      if (isCustomProperty && isThemeRoot) continue; // the token blocks own literals
      const isShadow = property === "box-shadow" || property === "text-shadow" || property === "filter";
      const checkable = COLOR_PROPERTIES.test(property) || isShadow || isCustomProperty;
      if (!checkable) continue;
      const residual = residualLiterals(value, { shadow: isShadow });
      if (!LITERAL.test(residual)) continue;
      if (allowed(selector, property)) continue;
      const offset = rule.index + rule[1].length + 1 + declaration.index;
      violations.push({
        line: source.slice(0, offset).split("\n").length,
        property,
        value: value.replace(/\s+/g, " "),
        reason: isCustomProperty
          ? "a component-local custom property holding a literal colour shadows the root token"
          : "use a surface token",
      });
    }
  }
  return violations;
}
