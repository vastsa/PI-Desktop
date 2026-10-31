import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { isWithinRoot } from "../../../packages/agent-runtime/src/project-instructions.ts";
import { resolveWithinRoot } from "../../../packages/host-runtime/src/workspace-files.ts";

// Windows drive and UNC roots already end in a separator. Containment must
// use path.win32 here so the regression runs on Linux, where the process
// path module would not keep that trailing separator.
const REL = ".workflow/knowhow/x.md";

test("windows drive roots contain a relative plugin path", () => {
  for (const root of ["C:/", "C:\\", "E:/", "E:\\"]) {
    const resolved = win32.resolve(root);
    assert.equal(resolveWithinRoot(root, REL, win32), win32.resolve(resolved, REL), root);
    assert.equal(
      resolveWithinRoot(root, ".workflow/knowledge-inbox/.gitignore", win32),
      win32.join(resolved, ".workflow", "knowledge-inbox", ".gitignore"),
      root,
    );
  }
});

test("a windows UNC share root contains a relative plugin path", () => {
  const root = "\\\\server\\share";
  assert.equal(
    resolveWithinRoot(root, REL, win32),
    win32.resolve(win32.resolve(root), REL),
  );
});

test("windows roots still reject a path that leaves them", () => {
  assert.equal(resolveWithinRoot("C:\\code", "../code-evil/x", win32), null);
  assert.equal(resolveWithinRoot("E:\\code", "E:\\code-evil\\x", win32), null);
  assert.equal(resolveWithinRoot("C:/Users/su", "C:/Windows/x", win32), null);
  assert.equal(resolveWithinRoot("C:/project", "../project-evil/x", win32), null);
  assert.equal(resolveWithinRoot("", REL, win32), null);
});

test("windows directories that are not roots stay contained", () => {
  assert.equal(
    resolveWithinRoot("C:/Users/su", REL, win32),
    "C:\\Users\\su\\.workflow\\knowhow\\x.md",
  );
  assert.equal(resolveWithinRoot("E:\\code", REL, win32), "E:\\code\\.workflow\\knowhow\\x.md");
  assert.equal(resolveWithinRoot("C:/Users/su", "", win32), "C:\\Users\\su");
  // `..` cannot climb above a drive, so it stays on that drive.
  assert.equal(resolveWithinRoot("C:/", "..", win32), "C:\\");
  assert.equal(resolveWithinRoot("C:/", "", win32), "C:\\");
});

test("a posix filesystem root contains a relative path", () => {
  assert.equal(resolveWithinRoot("/", REL), `/${REL}`);
  assert.equal(resolveWithinRoot("/", REL, posix), `/${REL}`);
  assert.equal(resolveWithinRoot("/srv/app", "../app-evil/x", posix), null);
});

test("project instruction containment accepts a windows drive root", () => {
  const root = win32.resolve("C:/");
  assert.equal(isWithinRoot(root, win32.join(root, ".workflow", "knowhow", "x.md"), win32), true);
  assert.equal(isWithinRoot(root, root, win32), true);
  const project = win32.resolve("C:/Users/su");
  assert.equal(isWithinRoot(project, win32.join(project, "AGENTS.md"), win32), true);
  assert.equal(
    isWithinRoot(project, win32.join(win32.resolve("C:/Users/su-evil"), "AGENTS.md"), win32),
    false,
  );
  assert.equal(isWithinRoot(posix.resolve("/"), posix.join(posix.resolve("/"), "AGENTS.md"), posix), true);
});
