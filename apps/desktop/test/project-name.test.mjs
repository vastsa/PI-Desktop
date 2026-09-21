import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  clampProjectName,
  defaultProjectName,
  folderNameFromPath,
  resolveProjectName,
} = await import("../src/lib/project-name.ts");

test("folderNameFromPath reads the last segment in either slash direction", () => {
  assert.equal(folderNameFromPath("/Users/dev/work/api-server"), "api-server");
  assert.equal(folderNameFromPath("/Users/dev/work/api-server/"), "api-server");
  assert.equal(folderNameFromPath("C:\\work\\api-server"), "api-server");
  assert.equal(folderNameFromPath("api-server"), "api-server");
});

test("defaultProjectName names a local pick after its first folder", () => {
  assert.equal(
    defaultProjectName({
      source: "local",
      folders: ["/Users/dev/work/api-server", "/Users/dev/work/web"],
    }),
    "api-server",
  );
  assert.equal(defaultProjectName({ source: "local", folders: [] }), "");
});

test("defaultProjectName names a git source after its repository", () => {
  assert.equal(
    defaultProjectName({ source: "git", folders: [], repositoryName: "PI-Desktop" }),
    "PI-Desktop",
  );
  assert.equal(
    defaultProjectName({ source: "git", folders: ["/Users/dev/work/api-server"] }),
    "",
  );
});

test("derived names stay inside the name field budget", () => {
  const long = "a".repeat(120);
  assert.equal(clampProjectName(long).length, 80);
  assert.equal(
    defaultProjectName({ source: "local", folders: [`/Users/dev/work/${long}`] }).length,
    80,
  );
  assert.equal(clampProjectName("  spaced  "), "spaced");
  // The name field counts UTF-16 units, so a derived name has to fit that
  // budget too and never end on half a surrogate pair.
  const emoji = clampProjectName("😀".repeat(100));
  assert.equal(emoji.length, 80);
  assert.equal(Array.from(emoji).length, 40);
  assert.equal(clampProjectName(`${"a".repeat(79)}😀`), "a".repeat(79));
});

test("resolveProjectName keeps a typed name and falls back when the field is empty", () => {
  assert.equal(resolveProjectName("My project", "api-server"), "My project");
  assert.equal(resolveProjectName("  api-server  ", "ignored"), "api-server");
  assert.equal(resolveProjectName("", "api-server"), "api-server");
  assert.equal(resolveProjectName("   ", "api-server"), "api-server");
  assert.equal(resolveProjectName("", ""), "");
});
