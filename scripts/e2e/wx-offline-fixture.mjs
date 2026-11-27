import assert from "node:assert/strict";
import { cp, lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const wxBootstrapEntries = [".deps", ".deps.lock"];

export async function copyStandaloneWxSkill(sample, skillPath) {
  const source = resolve(sample);
  assert.ok((await lstat(source)).isDirectory(), "WX sample root must be a directory, not a link.");
  await cp(source, skillPath, { recursive: true, verbatimSymlinks: true });

  // Check the installed paths because relative links can resolve differently after copying.
  const root = await realpath(skillPath);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(entry.parentPath, entry.name);
    const name = relative(root, link);
    assert.ok(!isAbsolute(await readlink(link)), `WX sample link must be relative: ${name}`);
    const resolved = await realpath(link).catch((cause) => {
      throw new Error(`WX sample link cannot be resolved: ${name}`, { cause });
    });
    const target = relative(root, resolved);
    assert.ok(target !== ".." && !target.startsWith(`..${sep}`) && !isAbsolute(target),
      `WX sample link points outside the installed Skill: ${name}`);
  }
}

export async function assertWxBootstrapAbsent(skillPath) {
  for (const name of wxBootstrapEntries) {
    await assert.rejects(lstat(join(skillPath, name)), { code: "ENOENT" }, `Unexpected WX bootstrap entry: ${name}`);
  }
}
