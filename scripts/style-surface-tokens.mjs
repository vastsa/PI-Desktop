/** Scoped guard for the ordinary chrome fills migrated in issue #341.
 * Prose, scrims, shadows, and other component families remain outside this batch.
 * Runtime CSS checks cover cascade and focus behavior; this guard catches literals.
 */
const SURFACE = /\.(?:settings-nav|settings-search|settings-nav-item|settings-toggle-thumb|agent-capability-search-wrap|plugins-search|composer-shell)(?![\w-])/;
const LITERAL = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black)\b/i;

export function findLiteralSurfaceColors(css) {
  // Retain newlines so diagnostics keep their source line numbers.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const violations = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!SURFACE.test(rule[1])) continue;
    for (const declaration of rule[2].matchAll(/\b(background(?:-color)?)\s*:\s*([^;{}]+)/g)) {
      if (!LITERAL.test(declaration[2])) continue;
      const offset = rule.index + rule[1].length + 1 + declaration.index;
      violations.push({ line: source.slice(0, offset).split("\n").length, property: declaration[1], value: declaration[2].trim() });
    }
  }
  return violations;
}
