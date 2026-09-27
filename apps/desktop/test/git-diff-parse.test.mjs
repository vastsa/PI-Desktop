import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PATCH_BYTES,
  parseFilePatch,
  parseStatusZ,
  splitUnifiedDiff,
} from "../electron/main/git-diff.ts";

test("parses porcelain -z status including renames and untracked", () => {
  const raw = [
    " M apps/a.ts",
    "?? notes.md",
    "R  new-name.ts\0old-name.ts",
    "!! ignored.log",
    "A  added.ts",
  ].join("\0") + "\0";
  const entries = parseStatusZ(raw);
  assert.deepEqual(entries, [
    { path: "apps/a.ts", untracked: false },
    { path: "notes.md", untracked: true },
    { path: "new-name.ts", oldPath: "old-name.ts", untracked: false },
    { path: "added.ts", untracked: false },
  ]);
});

test("splits a multi-file unified diff into per-file chunks", () => {
  const raw = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const chunks = splitUnifiedDiff(raw);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /^diff --git a\/a\.ts/);
  assert.match(chunks[1], /^diff --git a\/b\.ts/);
  assert.deepEqual(splitUnifiedDiff("  \n"), []);
});

test("parses a modified file patch with counts and hunks", () => {
  const chunk = [
    "diff --git a/src/x.ts b/src/x.ts",
    "index 111..222 100644",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,3 +1,4 @@ function x()",
    " context",
    "-removed",
    "+added one",
    "+added two",
    "\\ No newline at end of file",
  ].join("\n");
  const file = parseFilePatch(chunk);
  assert.equal(file.path, "src/x.ts");
  assert.equal(file.status, "modified");
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0].header, "@@ -1,3 +1,4 @@ function x()");
  assert.deepEqual(
    file.hunks[0].lines.map((l) => l.type),
    ["context", "del", "add", "add"],
  );
  // The no-newline marker never leaks into rendered lines.
  assert.ok(file.hunks[0].lines.every((l) => !l.text.includes("No newline")));
});

test("detects added, deleted, renamed, and binary patches", () => {
  const added = parseFilePatch(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n"),
  );
  assert.equal(added.status, "added");
  assert.equal(added.additions, 1);

  const deleted = parseFilePatch(
    [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n"),
  );
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.path, "gone.ts");

  const renamed = parseFilePatch(
    [
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 97%",
      "rename from old.ts",
      "rename to renamed.ts",
    ].join("\n"),
  );
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.path, "renamed.ts");
  assert.equal(renamed.oldPath, "old.ts");

  const binary = parseFilePatch(
    [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n"),
  );
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.hunks, []);
});

test("untracked hint overrides derived status and large patches drop hunks", () => {
  const untracked = parseFilePatch(
    [
      "diff --git a/draft.md b/draft.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/draft.md",
      "@@ -0,0 +1 @@",
      "+wip",
    ].join("\n"),
    "untracked",
  );
  assert.equal(untracked.status, "untracked");

  const bigBody = `+${"x".repeat(MAX_PATCH_BYTES)}`;
  const big = parseFilePatch(
    [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -0,0 +1 @@",
      bigBody,
    ].join("\n"),
  );
  assert.equal(big.tooLarge, true);
  assert.deepEqual(big.hunks, []);
  assert.equal(big.additions, 1);
});

test("unquotes escaped git paths", () => {
  const file = parseFilePatch(
    [
      'diff --git "a/\\346\\226\\207\\346\\241\\243.md" "b/\\346\\226\\207\\346\\241\\243.md"',
      "index 111..222 100644",
      '--- "a/\\346\\226\\207\\346\\241\\243.md"',
      '+++ "b/\\346\\226\\207\\346\\241\\243.md"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n"),
  );
  assert.ok(file.path.endsWith(".md"));
  assert.ok(!file.path.startsWith('"'));
});
