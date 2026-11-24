import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findGrowthViolations,
  isDeclarativeDataPath,
  isTestSourcePath,
  sizeBudgetFor,
} from "./architecture-growth.mjs";

function check(metrics, baseSizes, exempt = []) {
  return findGrowthViolations({
    metrics,
    baseLocFor: (path) => (path in baseSizes ? baseSizes[path] : null),
    exempt: new Set(exempt),
  });
}

test("an oversized file that grows past its base size is rejected", () => {
  assert.deepEqual(
    check([{ path: "packages/a/src/runtime.ts", loc: 1_205 }], {
      "packages/a/src/runtime.ts": 1_200,
    }),
    [{ path: "packages/a/src/runtime.ts", loc: 1_205, baseLoc: 1_200, budget: 800 }],
  );
  assert.equal(
    check([{ path: "crates/x/src/rpc/mod.rs", loc: 2_001 }], { "crates/x/src/rpc/mod.rs": 2_000 })
      .length,
    1,
  );
});

test("an oversized file may keep its size or shrink", () => {
  assert.deepEqual(
    check(
      [
        { path: "packages/a/src/same.ts", loc: 1_200 },
        { path: "packages/a/src/smaller.tsx", loc: 900 },
        { path: "crates/x/src/smaller.rs", loc: 1_500 },
      ],
      {
        "packages/a/src/same.ts": 1_200,
        "packages/a/src/smaller.tsx": 1_000,
        "crates/x/src/smaller.rs": 1_800,
      },
    ),
    [],
  );
});

test("a file crossing its budget from below is rejected", () => {
  assert.deepEqual(check([{ path: "apps/d/src/Panel.tsx", loc: 801 }], { "apps/d/src/Panel.tsx": 790 }), [
    { path: "apps/d/src/Panel.tsx", loc: 801, baseLoc: 790, budget: 800 },
  ]);
});

test("growth within the budget is allowed", () => {
  assert.deepEqual(
    check(
      [
        { path: "apps/d/src/Panel.tsx", loc: 800 },
        { path: "crates/x/src/lib.rs", loc: 1_000 },
      ],
      { "apps/d/src/Panel.tsx": 100, "crates/x/src/lib.rs": 10 },
    ),
    [],
  );
});

test("new files, tests, declarative data, exemptions, and unbudgeted files are skipped", () => {
  const metrics = [
    { path: "packages/a/src/runtime.test.ts", loc: 9_000 },
    { path: "crates/x/src/db/tests.rs", loc: 3_000 },
    { path: "crates/x/src/rpc/modes_rpc_tests.rs", loc: 3_000 },
    { path: "scripts/e2e/composer-paste.tsx", loc: 2_000 },
    { path: "packages/shared/src/changelog-en.ts", loc: 9_000 },
    { path: "packages/i18n/src/locales/en/index.ts", loc: 9_000 },
    { path: "packages/s/src/types.d.ts", loc: 9_000 },
    { path: "scripts/big.mjs", loc: 9_000 },
    { path: "apps/d/src/Allowed.ts", loc: 9_000 },
  ];
  const baseSizes = Object.fromEntries(metrics.map(({ path }) => [path, 1]));
  metrics.push({ path: "apps/d/src/New.tsx", loc: 5_000 });
  assert.deepEqual(check(metrics, baseSizes, ["apps/d/src/Allowed.ts"]), []);
});

test("path classification", () => {
  assert.equal(isTestSourcePath("apps/desktop/test/foo.mjs"), true);
  assert.equal(isTestSourcePath("packages/a/src/x.spec.tsx"), true);
  assert.equal(isTestSourcePath("packages/a/src/contest.ts"), false);
  assert.equal(isTestSourcePath("crates/host-core/src/tools/mod.rs"), false);
  assert.equal(sizeBudgetFor("a/b.tsx"), 800);
  assert.equal(sizeBudgetFor("a/b.rs"), 1_000);
  assert.equal(sizeBudgetFor("a/b.d.ts"), null);
  assert.equal(sizeBudgetFor("a/b.mjs"), null);
  assert.equal(isDeclarativeDataPath("packages/shared/src/changelog-zh-CN.ts"), true);
  assert.equal(isDeclarativeDataPath("packages/i18n/src/locales/ko/index.ts"), true);
  assert.equal(isDeclarativeDataPath("apps/desktop/electron/main/models-dev-catalog.ts"), false);
});
