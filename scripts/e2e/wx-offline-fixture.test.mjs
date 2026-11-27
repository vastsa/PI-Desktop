import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWxBootstrapAbsent, copyStandaloneWxSkill } from "./wx-offline-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pie-wx-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "installed");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "scripts/run.sh"), "offline launcher");
  return { root, source, destination };
}

test("a fresh WX sample keeps relative links that resolve inside its installed copy", async (t) => {
  const { source, destination } = await fixture(t);
  await symlink("scripts/run.sh", join(source, "launcher"));
  await copyStandaloneWxSkill(source, destination);
  assert.equal(await readlink(join(destination, "launcher")), "scripts/run.sh");
  await rm(source, { recursive: true });
  assert.equal(await readFile(join(destination, "launcher"), "utf8"), "offline launcher");
});

test("WX rejects a linked sample root before copying it", async (t) => {
  const { root, source, destination } = await fixture(t);
  const linked = join(root, "linked");
  await symlink(source, linked, "dir");
  await assert.rejects(copyStandaloneWxSkill(linked, destination), /WX sample root must be a directory/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

for (const kind of ["absolute", "escaping relative", "broken"]) {
  test(`WX rejects a link in the sample when it is ${kind}`, async (t) => {
    const { root, source, destination } = await fixture(t);
    const external = join(root, "external.sh");
    await writeFile(external, "existing installation");
    const target = { absolute: join(source, "scripts/run.sh"), "escaping relative": "../external.sh", broken: "missing.sh" }[kind];
    await symlink(target, join(source, "launcher"));
    await assert.rejects(copyStandaloneWxSkill(source, destination), /WX sample link/);
    assert.equal(await readFile(external, "utf8"), "existing installation");
  });
}

test("WX bootstrap check rejects an empty cache directory and a dangling lock", async (t) => {
  const { source } = await fixture(t);
  await assertWxBootstrapAbsent(source);
  await mkdir(join(source, ".deps"));
  await assert.rejects(assertWxBootstrapAbsent(source));
  await rm(join(source, ".deps"), { recursive: true });
  await symlink("missing", join(source, ".deps.lock"));
  await assert.rejects(assertWxBootstrapAbsent(source), /\.deps\.lock/);
});
