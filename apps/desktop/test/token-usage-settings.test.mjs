import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(
  new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
  "utf8",
);
const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);

test("token usage page uses catalog keys and token-scale classes", () => {
  assert.match(page, /t\("settings.usageTotal"\)/);
  assert.match(page, /t\("settings.usageEmpty"\)/);
  assert.match(page, /t\("settings.usageCell"/);
  assert.doesNotMatch(page, /settings\.usageSubtitle/);
  assert.doesNotMatch(page, /text-\[[^\]]+\]/);
  assert.match(page, /text-text-muted/);
  assert.match(page, /text-text-primary/);
  assert.match(search, /id: "usage"/);
  assert.match(search, /settings\.usageTotal/);
});
