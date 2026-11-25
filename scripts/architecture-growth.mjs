// Pure size-ratchet rules used by scripts/check-architecture.mjs.
//
// A production TypeScript or Rust source file above its size budget may stay
// at its current size or shrink, but must not grow past the size it had at the
// comparison base. Newly added files are governed by the new-file and Rust
// allowlist rules in check-architecture.mjs instead.

export const sizeBudgets = Object.freeze({
  typescript: 800,
  rust: 1_000,
});

const testSegments = new Set(["test", "tests", "__tests__", "e2e", "fixtures"]);

export function isTestSourcePath(filePath) {
  const segments = filePath.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((segment) => testSegments.has(segment))) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  return name === "tests.rs" || name.endsWith("_tests.rs") || name.endsWith("_test.rs");
}

// Declarative data grows with product copy and release notes; it is exempt
// from source-size budgets per AGENTS.md section 7.
export function isDeclarativeDataPath(filePath) {
  return (
    filePath.startsWith("packages/i18n/src/locales/") ||
    /^packages\/shared\/src\/changelog-[A-Za-z-]+\.ts$/.test(filePath)
  );
}

export function sizeBudgetFor(filePath) {
  if (filePath.endsWith(".d.ts")) return null;
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return sizeBudgets.typescript;
  if (filePath.endsWith(".rs")) return sizeBudgets.rust;
  return null;
}

/**
 * @param {object} input
 * @param {Array<{ path: string, loc: number }>} input.metrics current source sizes
 * @param {(path: string) => number | null} input.baseLocFor size at the base, or null when absent
 * @param {ReadonlySet<string>} [input.exempt] extra paths exempt from the ratchet
 * @returns {Array<{ path: string, loc: number, baseLoc: number, budget: number }>}
 */
export function findGrowthViolations({ metrics, baseLocFor, exempt = new Set() }) {
  const violations = [];
  for (const { path, loc } of metrics) {
    const budget = sizeBudgetFor(path);
    if (budget === null || loc <= budget) continue;
    if (exempt.has(path) || isTestSourcePath(path) || isDeclarativeDataPath(path)) continue;
    const baseLoc = baseLocFor(path);
    if (baseLoc === null) continue;
    if (loc > Math.max(baseLoc, budget)) violations.push({ path, loc, baseLoc, budget });
  }
  return violations;
}
