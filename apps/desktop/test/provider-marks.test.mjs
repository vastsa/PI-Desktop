/**
 * Provider brand-mark contract.
 *
 * The marks are vendored SVG under `src/assets/models` and compiled into React
 * components by `scripts/build-provider-marks.mjs`, so `src/lib/provider-marks.tsx`
 * is generated. This suite reads both and keeps them in step:
 *
 * - a vendored file the table cannot reach would be silently dead weight;
 * - a generated entry with no asset behind it would drop to the generic mark;
 * - a vendored file that carried a script, a remote reference, or a second fill
 *   colour would turn decorative artwork into executable content, or into a
 *   colored logo that breaks the monochrome row;
 * - regenerating from the assets must reproduce the committed file, so the
 *   checked-in output cannot drift from its source of truth.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const assetsDir = fileURLToPath(new URL("../src/assets/models/", import.meta.url));
const marksPath = fileURLToPath(new URL("../src/lib/provider-marks.tsx", import.meta.url));
const iconSource = await readFile(
  new URL("../src/features/chat/composer/ModelProviderIcon.tsx", import.meta.url),
  "utf8",
);
const marksSource = await readFile(marksPath, "utf8");

const components = new Map(
  [...marksSource.matchAll(/^function (Mark\w+)\(/gm)].map((m) => [m[1], true]),
);
const tableEntries = [...marksSource.matchAll(/^\s{2}"([a-z0-9-]+)": (Mark\w+),$/gm)]
  .map((match) => ({ key: match[1], component: match[2] }));
const assetFiles = (await readdir(assetsDir))
  .filter((name) => name.endsWith(".svg"))
  .map((name) => name.slice(0, -".svg".length));

test("every vendor the app knows how to reach has a bundled mark", () => {
  // The set the Composer will actually meet: the providers whose metadata the
  // resolver can place, so an unnamed gateway is the usual fallback.
  for (const key of [
    "openai", "anthropic", "google", "xai", "meta", "mistral", "deepseek",
    "alibaba-cn", "zhipuai", "moonshotai-cn", "minimax-cn", "volcengine",
    "openrouter", "groq", "togetherai", "xiaomi",
  ]) {
    assert.ok(tableEntries.some((entry) => entry.key === key), `${key} is missing`);
  }
});

test("sibling catalog keys of one vendor share a single artwork", () => {
  const of = (key) => tableEntries.find((entry) => entry.key === key)?.component;
  for (const [a, b] of [
    ["moonshotai-cn", "moonshotai"],
    ["minimax-cn", "minimax"],
    ["openai", "openai-codex"],
    ["google", "google-vertex"],
    ["alibaba-cn", "dashscope"],
    ["togetherai", "together"],
    ["volcengine", "doubao"],
    ["deepseek", "deepseek-ai"],
    // Xiaomi publishes the same mimo models under one key per billing region,
    // so the vendor resolver can land on any of them.
    ["xiaomi", "xiaomi-token-plan-cn"],
    ["xiaomi", "xiaomi-token-plan-sgp"],
    ["xiaomi", "xiaomi-token-plan-ams"],
  ]) {
    assert.equal(of(a), of(b), `${a} and ${b} use different artwork`);
  }
});
test("every table entry names a generated component, and every component is used", () => {
  for (const { key, component } of tableEntries) {
    assert.ok(components.has(component), `${key} references ${component}, which is not defined`);
  }
  const used = new Set(tableEntries.map((entry) => entry.component));
  for (const component of components.keys()) {
    assert.ok(used.has(component), `${component} is defined but unreachable`);
  }
});

test("sibling catalog keys of one vendor share a single artwork", () => {
  // models.dev lists the China and international rows of a vendor separately,
  // and the vendor resolver can land on either. Sharing the artwork is what
  // keeps a vendor's mark the vendor's, whichever spelling was published.
  const of = (key) => tableEntries.find((entry) => entry.key === key)?.component;
  for (const [a, b] of [
    ["moonshotai-cn", "moonshotai"],
    ["minimax-cn", "minimax"],
    ["openai", "openai-codex"],
    ["google", "google-vertex"],
    ["alibaba-cn", "dashscope"],
    ["togetherai", "together"],
    ["volcengine", "doubao"],
    ["deepseek", "deepseek-ai"],
  ]) {
    assert.equal(of(a), of(b), `${a} and ${b} use different artwork`);
  }
});

test("every vendored mark is a monochrome path the theme can colour", async () => {
  for (const name of await readdir(assetsDir)) {
    if (!name.endsWith(".svg")) continue;
    const body = await readFile(`${assetsDir}${name}`, "utf8");
    assert.match(body, /viewBox="[^"]+"/, `${name} is not scalable`);
    assert.doesNotMatch(body, /<script|javascript:|on[a-z]+=/i, `${name} carries executable content`);
    const withoutNamespaces = body.replace(/\sxmlns(:\w+)?="[^"]*"/g, "");
    assert.doesNotMatch(withoutNamespaces, /https?:\/\//i, `${name} references a remote resource`);
    assert.doesNotMatch(withoutNamespaces, /\burl\(|xlink:href|<image\b/i, `${name} embeds another document`);
    // A second fill colour would render as a colored logo, which is exactly the
    // inconsistency the marks exist to remove.
    for (const fill of [...body.matchAll(/fill="([^"]*)"/g)].map((m) => m[1])) {
      assert.ok(
        fill === "currentColor" || fill === "none",
        `${name} paints with ${fill}, so it would not follow the theme`,
      );
    }
  }
});

test("regenerating from the assets reproduces the committed file", async () => {
  // The generated file is committed so a build never has to run the generator
  // first. That makes drift possible, so pin it here: if someone edits a mark
  // and forgets to regenerate, this fails instead of shipping the old artwork.
  const before = await readFile(marksPath, "utf8");
  execFileSync(process.execPath, ["scripts/build-provider-marks.mjs"], { cwd: repoRoot });
  const after = await readFile(marksPath, "utf8");
  if (before !== after) await writeFile(marksPath, before);
  assert.equal(after, before, "provider-marks.tsx is stale; run node scripts/build-provider-marks.mjs");
});

test("the row falls back to the shared generic mark for an unknown vendor", () => {
  assert.match(iconSource, /providerMark\(catalogProviderKey\)/);
  assert.match(iconSource, /IconBot size=\{14\} className="provider-mark provider-mark-generic"/);
  // Decorative only: the model id beside it remains the row's accessible name.
  assert.match(iconSource, /aria-hidden="true"/);
});
