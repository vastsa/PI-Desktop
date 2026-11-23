import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("sidebar project names keep space beside long conversation titles", async () => {
  const [styles, sidebar] = await Promise.all([
    readFile(new URL("../src/styles/sidebar-threads.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8"),
  ]);
  const titleWithProject = styles.match(/\.thread-item-title:has\(\+ \.thread-item-project\)\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(titleWithProject, /flex:\s*1;/);
  assert.match(titleWithProject, /min-width:\s*4ch;/);
  assert.match(sidebar, /className="thread-item-project" title=\{owningProject\}/);
});
