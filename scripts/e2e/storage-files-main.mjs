import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { promises as fs, writeFileSync } from "original-fs";
import { join, relative, resolve } from "node:path";
import { migrateFiles, validateTarget } from "../../apps/desktop/electron/main/storage/files.ts";
import { storageLinkTypes } from "../../apps/desktop/electron/main/storage/link-types.ts";

const artifacts = process.env.PI_STORAGE_FILES_ARTIFACTS;
app.setPath("userData", join(artifacts, "electron-profile"));
const cases = [];
void (async () => {
  for (const name of ["valid-asar", "opaque-asar", "dangling-directory-link", "trailing-directory-link", "mixed-links", "copy-error-context"]) {
    const directory = name === "trailing-directory-link" ? join(artifacts, "node-created-junction") : await fs.mkdtemp(join(artifacts, name + "-"));
    const source = { data: join(directory, "data"), browser: join(directory, "browser") };
    await fs.mkdir(source.data, { recursive: true }); await fs.mkdir(source.browser, { recursive: true });
    const file = name.endsWith("asar") ? "app.asar" : "session.jsonl";
    const content = name === "valid-asar" ? await fs.readFile(join(artifacts, "fixture.asar"))
      : Buffer.from("Retain opaque user bytes, not an Electron virtual directory.\n");
    await fs.writeFile(join(source.data, file), content);
    if (name.endsWith("asar")) {
      await fs.mkdir(join(source.data, "app.asar.unpacked"));
      await fs.writeFile(join(source.data, "app.asar.unpacked", "native.node"), "synthetic unpacked bytes");
    }
    const missing = join(directory, "missing-dependency");
    if (name === "dangling-directory-link") await fs.symlink(missing, join(source.data, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const linkNames = ["internal directory", "external directory", "missing 迁移-'directory", "missing file", "existing file", "blocked directory"];
    if (name === "mixed-links") {
      const internal = join(source.data, "z resources");
      const external = join(directory, "external resources");
      await fs.mkdir(internal); await fs.mkdir(external);
      await fs.writeFile(join(internal, "payload.txt"), "retained internal data");
      await fs.writeFile(join(external, "payload.txt"), "retained external data");
      await fs.symlink(internal, join(source.data, linkNames[0]), process.platform === "win32" ? "junction" : "dir");
      await fs.symlink(external, join(source.data, linkNames[1]), process.platform === "win32" ? "junction" : "dir");
      await fs.symlink(join(directory, "missing-迁移-'folder"), join(source.data, linkNames[2]), process.platform === "win32" ? "junction" : "dir");
      await fs.symlink(relative(source.data, join(directory, "missing-'document.txt")), join(source.data, linkNames[3]), "file");
      await fs.symlink(relative(source.data, join(external, "payload.txt")), join(source.data, linkNames[4]), "file");
      await fs.symlink(join(source.data, file, "not a directory"), join(source.data, linkNames[5]), process.platform === "win32" ? "junction" : "dir");
    }
    let progress;
    try {
      const target = await validateTarget(join(directory, "destination"), source, source.browser);
      let collided = false;
      const next = await migrateFiles({ source, target, anchor: source.browser, id: randomUUID(),
        progress: value => {
          progress = value;
          if (name === "copy-error-context" && value.stage === "copying" && !collided) {
            collided = true;
            // A destination changed after preflight must retain the failing path.
            writeFileSync(join(target, "data", file), "destination collision fixture", { flag: "wx" });
          }
        }, relocate: async () => { assert.notEqual(name, "copy-error-context"); } });
      assert.deepEqual(await fs.readFile(join(next.data, file)), content);
      assert.deepEqual(await fs.readFile(join(source.data, file)), content);
      if (name.endsWith("asar")) {
        assert((await fs.lstat(join(next.data, file))).isFile());
        assert.equal(await fs.readFile(join(next.data, "app.asar.unpacked", "native.node"), "utf8"), "synthetic unpacked bytes");
      }
      if (name === "dangling-directory-link") {
        assert((await fs.lstat(join(next.data, "node_modules"))).isSymbolicLink());
        assert.equal(await fs.readlink(join(next.data, "node_modules")), await fs.readlink(join(source.data, "node_modules")));
        await assert.rejects(fs.stat(join(next.data, "node_modules")), { code: "ENOENT" });
      }
      if (name === "trailing-directory-link") {
        const link = join(next.data, "node_modules");
        assert((await fs.lstat(link)).isSymbolicLink());
        assert.equal(resolve(await fs.readlink(link)), resolve(missing));
        await assert.rejects(fs.stat(link), { code: "ENOENT" });
      }
      if (name === "mixed-links") {
        const destinationLinks = linkNames.map(link => join(next.data, link));
        assert.deepEqual(await storageLinkTypes(destinationLinks), await storageLinkTypes(linkNames.map(link => join(source.data, link))));
        assert.equal(await fs.readFile(join(destinationLinks[0], "payload.txt"), "utf8"), "retained internal data");
        assert.equal(await fs.readFile(join(destinationLinks[1], "payload.txt"), "utf8"), "retained external data");
        assert.equal(await fs.readFile(destinationLinks[4], "utf8"), "retained external data");
        for (const index of [2, 3, 5]) {
          assert((await fs.lstat(destinationLinks[index])).isSymbolicLink());
          await assert.rejects(fs.stat(destinationLinks[index]), error => ["ENOENT", "ENOTDIR"].includes(error.code));
        }
        assert.equal(await fs.readlink(destinationLinks[0]), join(next.data, "z resources"));
      }
      assert.notEqual(name, "copy-error-context", "Conflicting destination must fail");
      assert.equal(progress.stage, "complete");
      cases.push({ name, passed: true, progress });
    } catch (error) {
      const expected = name === "copy-error-context" && error.message.includes("Storage copy failed:")
        && error.message.includes(source.data) && error.message.includes(join(directory, "destination", "data"))
        && error.cause?.code === "EEXIST";
      if (expected) assert.deepEqual(await fs.readFile(join(source.data, file)), content);
      cases.push({ name, passed: expected, message: error.message, code: error.code, syscall: error.syscall, progress });
    }
  }
  await fs.writeFile(join(artifacts, "result.json"), JSON.stringify({ electron: process.versions.electron, cases }, null, 2));
  app.exit(cases.every(value => value.passed) ? 0 : 1);
})().catch(error => { console.error(error); app.exit(1); });
