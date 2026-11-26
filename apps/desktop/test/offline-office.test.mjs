import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import bundleOfflineOffice from "../../../scripts/bundle-offline-office.mjs";

const site = "python/lib/python3.12/site-packages";

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "pie-office-package-test-"));
  const runtime = join(root, "staged runtime");
  const resources = join(root, "app/resources");
  const put = async (name, contents = "", mode) => {
    const file = join(runtime, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, { mode });
  };
  const bundle = () => bundleOfflineOffice({
    electronPlatformName: "linux", arch: 3, appOutDir: join(root, "app"), targets: [{ name: "deb" }],
  }, runtime);
  try {
    const packages = { "node_modules/docx": { version: "9.16.0" },
      "node_modules/fflate": { version: "0.8.3" }, "node_modules/nanoid": { version: "6.0.1" } };
    for (const file of ["node/LICENSE", "python/lib/python3.12/LICENSE.txt", "metadata/runtime-source.json",
      "python/lib/libpython3.12.so.1.0", "python/lib/python3.12/zipfile/__init__.py"]) await put(file);
    await put("metadata/package-lock.json", JSON.stringify({ packages }));
    for (const [name, pkg] of Object.entries(packages)) {
      await put(`node/lib/${name}/package.json`, JSON.stringify(pkg));
      await put(`node/lib/${name}/LICENSE`);
    }
    for (const [name, version] of [["defusedxml", "0.7.1"], ["lxml", "6.1.3"]]) {
      await put(`${site}/${name}/__init__.py`);
      await put(`${site}/${name}-${version}.dist-info/METADATA`);
      await put(`${site}/${name}-${version}.dist-info/LICENSE`);
    }
    for (const file of ["node/bin/node", "python/bin/python3.12"]) await put(file, "#!/bin/sh\n", 0o755);
    await run({ put, bundle, resources, runtime });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the Kylin package installs only the runtime and a disabled extension without skills", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntime(async ({ put, bundle, resources }) => {
    await put("wx-runtime/wheels.tar.xz");
    await put("word/SKILL.md");
    await put("node/lib/node_modules/unlocked/SKILL.md");
    await put("node/lib/node_modules/docx/dist/index.d.ts");
    await put("node/lib/node_modules/docx/dist/nested.tar.gz");
    await put("python/lib/python3.12/ensurepip/archive.whl");
    await put(`${site}/docx/templates/default.docx`);
    await put(`${site}/lxml/isoschematron/resources/tool.xsl`);
    await bundle();
    assert.deepEqual((await readdir(resources)).sort(), ["office-runtime", "plugins"]);
    const plugins = join(resources, "plugins");
    assert.deepEqual(await readdir(plugins), ["pie.office-runtime"]);
    const manifest = JSON.parse(await readFile(join(plugins, "pie.office-runtime/manifest.json")));
    assert.equal(manifest.enabledByDefault, false);
    assert.equal(manifest.i18n.en.name, "Office Runtime");
    assert.equal(manifest.i18n["zh-CN"].name, "办公运行时");
    assert.equal(manifest.contributes, undefined);
    assert.deepEqual(manifest.permissions ?? [], []);
    const files = await readdir(join(resources, "office-runtime"), { recursive: true });
    assert.ok(files.includes("node/lib/node_modules/docx/package.json"));
    assert.ok(files.includes(`${site}/lxml/__init__.py`));
    assert.ok(!files.some((name) => /SKILL\.md|wx-runtime|\.whl$|\.docx$|\.tar\.gz$|\.d\.ts$|isoschematron/.test(name)), files.join("\n"));
  });
});

test("the Kylin package rejects packaged links escaping the runtime", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ bundle, runtime }) => {
    await symlink("../../../../outside", join(runtime, "node/lib/node_modules/docx/bad-link"));
    await assert.rejects(bundle(), /Office Runtime link/);
  });
});

test("the Kylin package cannot read through a staged directory link outside the runtime", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntime(async ({ bundle, runtime }) => {
    const node = join(runtime, "node");
    await rename(node, join(runtime, "../outside"));
    await symlink("../outside", node);
    await assert.rejects(bundle(), /Office Runtime link points outside/);
  });
});
