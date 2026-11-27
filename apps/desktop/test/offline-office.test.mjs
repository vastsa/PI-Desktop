import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import bundleOfflineOffice from "../../../scripts/bundle-offline-office.mjs";
import { verifyPdfSkillRecipes } from "../../../scripts/e2e/pdf-skill-recipes.mjs";

const pdfDistribution = {
  name: "pypdf", version: "7.1.1", url: "https://example.test/pypdf.whl",
  sha256: "a".repeat(64), license: "BSD-3-Clause",
};
const site = "python/lib/python3.12/site-packages";
const timezoneArchive = `${site}/dateutil/zoneinfo/dateutil-zoneinfo.tar.gz`;
const archiveTimezones = (runtime, ...names) =>
  execFileSync("tar", ["-czf", join(runtime, timezoneArchive), "-C", join(runtime, "zone-fixture"), ...names]);
const nativePackages = Object.entries({
  "libreoffice-core": "7.1.8.1-3.el8_10.alma.1",
  "libreoffice-calc": "7.1.8.1-3.el8_10.alma.1",
  "libreoffice-impress": "7.1.8.1-3.el8_10.alma.1",
  "libreoffice-writer": "7.1.8.1-3.el8_10.alma.1",
  "poppler": "20.11.0-14.el8_10",
  "poppler-utils": "20.11.0-14.el8_10",
}).map(([name, version]) => ({
  name, version,
  source: { url: "https://example.test/" + (name.startsWith("libreoffice-") ? "libreoffice" : name) + ".src.rpm" },
  notices: ["LICENSE"],
}));

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
        et_xmlfile: "et_xmlfile", flatbuffers: "flatbuffers", idna: "idna", magika: "magika", markdownify: "markdownify", markitdown: "markitdown",
        numpy: "numpy", onnxruntime: "onnxruntime", openpyxl: "openpyxl", packaging: "packaging", pandas: "pandas", pillow: "PIL",
        protobuf: "google/protobuf", pypdf: "pypdf", python_dateutil: "dateutil", python_dotenv: "dotenv", python_pptx: "pptx",
        requests: "requests", six: "six.py", soupsieve: "soupsieve",
        typing_extensions: "typing_extensions.py", urllib3: "urllib3", xlsxwriter: "xlsxwriter",
      };
      for (const [name, path] of Object.entries(modules)) {
        await put(`${site}/${path}${path.endsWith(".py") ? "" : "/__init__.py"}`);
        const version = name === "pypdf" ? pdfDistribution.version : "1.0.0";
        const notice = ["et_xmlfile", "openpyxl"].includes(name) ? "LICENCE.rst" : "LICENSE.txt";
        await put(`${site}/${name}-${version}.dist-info/${notice}`, name === "pypdf" ? "PDF distribution license.\n" : "");
        pythonVersions.push([name, version]);
      }
      await put(`${site}/google/_upb/_message.abi3.so`);
      await put("metadata/python-dependencies.json", JSON.stringify({ packages: pythonVersions.map(([name, version]) => name === "pypdf" ? pdfDistribution : { name, version }) }));
      await put("metadata/native-office/sources.json", JSON.stringify({ packages: nativePackages }));
      for (const { name } of nativePackages) {
        await put("metadata/native-office/licenses/" + name + "/LICENSE", "Renderer license notice.\n");
      }
      await put("libreoffice/program/oosplash", "#!/bin/bash\nprintf '%s\\n' \"$HOME\" \"\${!#}\" \"$@\"\n", 0o755);
      await put("libreoffice/presets/basic/script.xlc");
      await put("libreoffice/presets/basic/Standard/script.xlb");
      for (const file of ["program/libwriterfilterlo.so", "share/registry/writer.xcd",
        "program/libsclo.so", "program/libforuilo.so", "share/registry/calc.xcd"]) await put("libreoffice/" + file);
      await put("poppler/bin/pdftoppm", "#!/bin/sh\nprintf '%s\\n' \"$1\"\n", 0o755);
      await put("zone-fixture/UTC");
      await put("zone-fixture/METADATA", "{}");
      await mkdir(dirname(join(runtime, timezoneArchive)), { recursive: true });
      archiveTimezones(runtime, "UTC", "METADATA");
    }
    for (const file of ["node/bin/node", "python/bin/python3.12"]) await put(file, "#!/bin/sh\n", 0o755);
    const runtimeProfiles = await mkdtemp(join(root, "renderer-profiles-"));
    await run({ put, bundle, resources, runtime, runtimeProfiles });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the Kylin package installs only the runtime and a disabled extension without skills", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntime(async ({ put, bundle, resources, runtimeProfiles }) => {
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
    await put("poppler/bin/pdfinfo", "#!/bin/sh\n", 0o755);
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
      `${site}/markitdown/__init__.py`, `${site}/PIL/__init__.py`, `${site}/typing_extensions.py`,
      `${site}/pypdf/__init__.py`, `${site}/pypdf-7.1.1.dist-info/LICENSE.txt`,
      "libreoffice/program/libwriterfilterlo.so", "libreoffice/program/libsclo.so"]) {
      assert.ok(files.includes(name), `${name} was not packaged`);
    }
    assert.ok(files.includes(`${site}/lxml/__init__.py`));
    for (const name of ["dateutil", "et_xmlfile", "openpyxl", "pandas"]) {
      assert.ok(files.includes(`${site}/${name}/__init__.py`), `${name} was not packaged`);
    }
    assert.ok(files.includes("libreoffice/program/libsclo.so"));
    assert.ok(files.includes(timezoneArchive));
    assert.ok(files.includes("libreoffice/presets/basic/script.xlc"));
    assert.ok(files.includes("libreoffice/presets/basic/Standard/script.xlb"));
    assert.ok(!files.includes("poppler/bin/pdfinfo"));
    const launch = (name, args) => execFileSync(join(resources, "office-runtime/bin", name), args, {
      encoding: "utf8", env: { ...process.env, PI_OFFICE_RUNTIME_PROFILES: runtimeProfiles },
    }).trimEnd().split("\n");
    const [profile, lastArg] = launch("soffice", ["-env:UserInstallation=file:///fixture", "原始 演示.pptx"]);
    assert.equal(dirname(profile), runtimeProfiles);
    assert.equal(lastArg, "原始 演示.pptx");
    assert.deepEqual(launch("pdftoppm", ["原始 演示.pdf"]), ["原始 演示.pdf"]);
    assert.ok(!files.some((name) => name !== timezoneArchive && /SKILL\.md|wx-runtime|\.whl$|\.docx$|\.tar\.gz$|\.zip$|\.d\.ts$|\.odb$|gdbtrace|isoschematron|unrelated-command/.test(name)), files.join("\n"));
  });
});

test("the dateutil data archive cannot hide a Skill", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle, runtime }) => {
    await put("zone-fixture/SKILL.md");
    archiveTimezones(runtime, "UTC", "METADATA", "SKILL.md");
    await assert.rejects(bundle(), /Unexpected files in the Office Runtime dateutil time zone archive/);
  });
});

test("soffice can reuse the Bash-owned home across separate calls", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ bundle, resources, runtimeProfiles }) => {
    await bundle();
    const soffice = join(resources, "office-runtime/bin/soffice");
    const env = { ...process.env, HOME: runtimeProfiles, PI_OFFICE_RUNTIME_PROFILES: runtimeProfiles };
    for (const args of [["--terminate_after_init"], ["另存 工作簿.xlsx"]]) {
      const [home, lastArg, ...launched] = execFileSync(soffice, args, { encoding: "utf8", env }).trimEnd().split("\n");
      assert.equal(home, runtimeProfiles);
      assert.equal(lastArg, args[0]);
      assert.ok(launched.includes(`-env:UserInstallation=file://${runtimeProfiles}/.config/libreoffice/4`));
    }
  });
});

test("ordinary Python isolates the Excel Skill's recalculation without redirecting other scripts", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle, resources, runtime, runtimeProfiles }) => {
    await put("python/bin/python3.12", "#!/bin/sh\nprintf '%s\\n' \"$HOME\"\n", 0o755);
    await put("user Excel Skill/SKILL.md", "---\nname: xlsx\n---\n");
    await put("user Excel Skill/scripts/recalc.py");
    await put("user Excel Skill/scripts/office/soffice.py");
    await put("other/scripts/recalc.py");
    await bundle();
    const packaged = join(resources, "office-runtime");
    const home = join(runtime, "real home");
    const run = (command, cwd, script) => execFileSync("/bin/bash", ["-c", `exec ${command} "$1"`, "bash", script], {
      cwd, encoding: "utf8", env: { ...process.env, HOME: home, PI_OFFICE_RUNTIME_PROFILES: runtimeProfiles,
        PATH: `${packaged}/bin:${packaged}/python/bin:${process.env.PATH}` },
    }).trimEnd();
    const skill = join(runtime, "user Excel Skill");
    const first = run("python", skill, "scripts/recalc.py");
    const second = run("python3", runtime, join(skill, "scripts/recalc.py"));
    assert.equal(dirname(first), runtimeProfiles);
    assert.equal(dirname(second), runtimeProfiles);
    assert.notEqual(first, second);
    assert.equal(run("python", join(runtime, "other"), "scripts/recalc.py"), home);
  });
});

test("the Office Python timeout keeps subprocesses in the Bash runner's group", { skip: process.platform !== "linux" }, async () => {
  await withRuntime(async ({ put, bundle, resources, runtimeProfiles }) => {
    await put("python/bin/python3.12", "#!/bin/sh\nexec timeout 5 sh -c 'ps -o pgid= -p \"$$\"'\n", 0o755);
    await bundle();
    const command = spawn(join(resources, "office-runtime/bin/office-python"), [], {
      detached: true,
      env: { ...process.env, PI_OFFICE_RUNTIME_PROFILES: runtimeProfiles },
    });
    let output = "";
    command.stdout.on("data", (data) => { output += data; });
    const [code] = await once(command, "close");
    assert.equal(code, 0);
    assert.equal(Number(output.trim()), command.pid);
  });
});

test("the Kylin package rejects Calc from a different LibreOffice build", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle }) => {
    const packages = nativePackages.map((pkg) =>
      pkg.name === "libreoffice-calc" ? { ...pkg, version: "different" } : pkg);
    await put("metadata/native-office/sources.json", JSON.stringify({ packages }));
    await assert.rejects(bundle(), /Calc must match the LibreOffice core build/);
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
    await put("metadata/native-office/sources.json", JSON.stringify({ packages: nativePackages.map(
      (pkg) => pkg.name === "poppler-utils" ? { ...pkg, notices: [] } : pkg,
    ) }));
    await assert.rejects(bundle(), /source or license notice is missing: poppler-utils/);
  });
});

test("the Kylin package requires provenance for both renderers", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle }) => {
    await put("metadata/native-office/sources.json", JSON.stringify({ packages: nativePackages.filter(
      (pkg) => pkg.name.startsWith("libreoffice"),
    ) }));
    await assert.rejects(bundle(), /Missing native Office Runtime package: poppler/);
  });
});

test("the Kylin package requires a native dependency version", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle }) => {
    await put("metadata/native-office/sources.json", JSON.stringify({ packages: nativePackages.map(
      (pkg) => pkg.name === "poppler-utils" ? { ...pkg, version: undefined } : pkg,
    ) }));
    await assert.rejects(bundle(), /version is missing: poppler-utils/);
  });
});

test("the Kylin package rejects a runtime without the Calc export dependencies", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntime(async ({ bundle, runtime }) => {
    await rm(join(runtime, "libreoffice/program/libforuilo.so"));
    await assert.rejects(bundle(), /libforuilo\.so/);
  });
});

test("the Kylin package rejects pypdf without a wheel source and digest", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle, runtime }) => {
    const path = "metadata/python-dependencies.json";
    const manifest = JSON.parse(await readFile(join(runtime, path), "utf8"));
    const pdf = manifest.packages.find(({ name }) => name === "pypdf");
    for (const field of ["url", "sha256"]) {
      const value = pdf[field];
      delete pdf[field];
      await put(path, JSON.stringify(manifest));
      await assert.rejects(bundle(), /pypdf.*wheel provenance/);
      pdf[field] = value;
      await rm(join(runtime, "../app"), { recursive: true, force: true });
    }
  });
});

test("the Kylin package rejects a blank pypdf license", { skip: process.platform === "win32" }, async () => {
  await withRuntime(async ({ put, bundle }) => {
    await put(`${site}/pypdf-7.1.1.dist-info/LICENSE.txt`, " \n");
    await assert.rejects(bundle(), /license is missing or blank: pypdf/);
  });
});

const pdfRecipes = `
\`\`\`python
import pypdf
pdf = pypdf.PdfReader("document.pdf")
content = "".join(page.extract_text() for page in pdf.pages)
\`\`\`

\`\`\`python
import pypdf
writer = pypdf.PdfWriter()
for file in ["second.pdf", "first.pdf"]:
    for page in pypdf.PdfReader(file).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as handle:
    writer.write(handle)
\`\`\`
`;

test("PDF acceptance requires both recipes in the loaded Skill", () => {
  verifyPdfSkillRecipes(pdfRecipes);
  assert.throws(() => verifyPdfSkillRecipes(pdfRecipes.replace("page.extract_text()", "str(page)")), /text extraction recipe/);
  assert.throws(() => verifyPdfSkillRecipes(pdfRecipes.replace("writer.add_page(page)", "pass")), /ordered merge recipe/);
});
