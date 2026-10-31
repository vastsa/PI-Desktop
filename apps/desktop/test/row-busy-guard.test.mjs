import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a row busy guard tracks rows independently", async () => {
  const { createRowBusyGuard } = await import("../src/lib/row-busy-guard.ts");

  const guard = createRowBusyGuard();
  assert.equal(guard.begin("skills:s1"), true);
  assert.equal(guard.isBusy("skills:s1"), true);

  // The same row cannot double-claim — this is the double-click guard.
  assert.equal(guard.begin("skills:s1"), false);

  // Another row claims freely: one busy row never blocks or clears another.
  assert.equal(guard.begin("skills:s2"), true);
  assert.equal(guard.isBusy("skills:s2"), true);

  // Releasing the first row leaves the second one's guard in place — the
  // single-slot regression this guard replaces cleared every row here.
  guard.end("skills:s1");
  assert.equal(guard.isBusy("skills:s1"), false);
  assert.equal(guard.begin("skills:s1"), true);
  assert.equal(guard.isBusy("skills:s2"), true);

  guard.end("skills:s2");
  guard.end("skills:s2"); // releasing twice stays safe
  assert.equal(guard.isBusy("skills:s2"), false);
});

test("capability pages guard rows with useRowBusy instead of one shared slot", async () => {
  const pages = [
    "../src/components/settings/AgentSkillsPage.tsx",
    "../src/components/settings/AgentSubagentsPage.tsx",
    "../src/components/settings/AgentMcpPage.tsx",
  ];
  for (const page of pages) {
    const source = await read(page);
    assert.match(source, /useRowBusy\(\)/, `${page} must use the row busy guard`);
    assert.doesNotMatch(
      source,
      /useState<string \| null>\(null\).*busy/,
      `${page} must not keep a single busy slot`,
    );
  }
});

test("the MCP toggle no longer freezes every row while one is busy", async () => {
  const source = await read("../src/components/settings/AgentMcpPage.tsx");
  const toggle = source.match(/const toggle = async \(server: McpServerRecord[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.ok(toggle.length > 0, "MCP toggle implementation not found");
  assert.doesNotMatch(toggle, /if \(busyId\) return;/);
  assert.match(toggle, /if \(!rowBusy\.begin\(key\)\) return;/);
});
