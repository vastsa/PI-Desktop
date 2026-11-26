import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import bundleOfflineOffice from "../../../scripts/bundle-offline-office.mjs";

const site = "python/lib/python3.12/site-packages";

async function withRuntime(run, { wordOnly = false } = {}) {
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
    if (!wordOnly) {
      packages["node_modules/pptxgenjs"] = { version: "4.0.1" };
      for (const name of ["image-size", "queue", "inherits", "jszip", "lie", "pako", "setimmediate", "immediate",
        "core-util-is", "process-nextick-args", "util-deprecate", "readable-stream", "isarray", "safe-buffer", "string_decoder"]) {
        packages[`node_modules/${name}`] = { version: "1.0.0" };
      }
    }
    for (const file of ["node/LICENSE", "python/lib/python3.12/LICENSE.txt", "metadata/runtime-source.json",
      "python/lib/libpython3.12.so.1.0", "python/lib/python3.12/zipfile/__init__.py"]) await put(file);
    await put("metadata/package-lock.json", JSON.stringify({ packages }));
    for (const [name, pkg] of Object.entries(packages)) {
      await put(`node/lib/${name}/package.json`, JSON.stringify(pkg));
      await put(`node/lib/${name}/LICENSE`);
    }
    const pythonVersions = [["defusedxml", "0.7.1"], ["lxml", "6.1.3"]];
    for (const [name, version] of pythonVersions) {
      await put(`${site}/${name}/__init__.py`);
      await put(`${site}/${name}-${version}.dist-info/METADATA`);
      await put(`${site}/${name}-${version}.dist-info/LICENSE`);
    }
    if (!wordOnly) {
      const modules = {
        beautifulsoup4: "bs4", certifi: "certifi", charset_normalizer: "charset_normalizer", click: "click",
        flatbuffers: "flatbuffers", idna: "idna", magika: "magika", markdownify: "markdownify", markitdown: "markitdown",
        numpy: "numpy", onnxruntime: "onnxruntime", packaging: "packaging", pillow: "PIL", protobuf: "google/protobuf",
        python_dotenv: "dotenv", python_pptx: "pptx", requests: "requests", six: "six.py", soupsieve: "soupsieve",
        typing_extensions: "typing_extensions.py", urllib3: "urllib3", xlsxwriter: "xlsxwriter",
      };
      for (const [name, path] of Object.entries(modules)) {
        await put(`${site}/${path}${path.endsWith(".py") ? "" : "/__init__.py"}`);
        await put(`${site}/${name}-1.0.0.dist-info/LICENSE.txt`);
        pythonVersions.push([name, "1.0.0"]);
      }
      await put(`${site}/google/_upb/_message.abi3.so`);
      await put("metadata/python-dependencies.json", JSON.stringify({ packages: pythonVersions.map(([name, version]) => ({ name, version })) }));
      await put("metadata/native-office/sources.json", JSON.stringify({ packages: [{
        name: "renderer", source: { url: "https://example.test/renderer.src" }, notices: ["LICENSE"],
      }] }));
      await put("metadata/native-office/licenses/renderer/LICENSE", "Renderer license notice.\n");
      for (const file of ["libreoffice/program/oosplash", "poppler/bin/pdftoppm"]) await put(file, "#!/bin/sh\n", 0o755);
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
    await put("libreoffice/program/hidden-skill.zip");
    await put("libreoffice/program/gdbtrace");
    await put("libreoffice/presets/database/example.odb");
    await put("bin/soffice", "foreign launcher\n", 0o755);
    await put("bin/unrelated-command", "#!/bin/sh\n", 0o755);
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
    for (const name of ["node/lib/node_modules/pptxgenjs/package.json", "bin/soffice", "bin/pdftoppm",
      `${site}/markitdown/__init__.py`, `${site}/PIL/__init__.py`, `${site}/typing_extensions.py`]) {
      assert.ok(files.includes(name), `${name} was not packaged`);
    }
    assert.ok(files.includes(`${site}/lxml/__init__.py`));
    assert.match(await readFile(join(resources, "office-runtime/bin/soffice"), "utf8"), /oosplash/);
    assert.ok(!files.some((name) => /SKILL\.md|wx-runtime|\.whl$|\.docx$|\.tar\.gz$|\.zip$|\.d\.ts$|\.odb$|gdbtrace|isoschematron|unrelated-command/.test(name)), files.join("\n"));
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

test("the Kylin package rejects a staged runtime without the PowerPoint dependencies", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntime(async ({ bundle }) => {
    await assert.rejects(bundle(), /Expected pptxgenjs/);
  }, { wordOnly: true });
});

test("the Kylin package rejects a renderer without a source or license notice", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntime(async ({ put, bundle }) => {
    await put("metadata/native-office/sources.json", JSON.stringify({ packages: [{ name: "renderer", notices: [] }] }));
    await assert.rejects(bundle(), /source or license notice is missing: renderer/);
  });
});
