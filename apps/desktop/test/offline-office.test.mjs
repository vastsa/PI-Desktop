import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import bundleOfflineOffice, { verifyOfflineOfficeRuntime } from "../../../scripts/bundle-offline-office.mjs";

const plugin = new URL("../resources/offline-office/", import.meta.url);

test("Offline Office exposes the PDF skill and requires the packaged runtime", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pie-pdf-test-"));
  try {
    const installed = join(root, "plugins", "pie.offline-office");
    await cp(plugin, installed, { recursive: true });
    const { contributes } = JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"));
    const skill = contributes.skills.find(({ id }) => id === "pdf");
    assert.ok(skill, "PDF skill must be contributed by Offline Office");
    const launcher = join(installed, dirname(skill.path), "pdf.sh");
    const result = spawnSync("/bin/sh", [launcher, "extract", "样例 文件.pdf"], {
      cwd: root, env: { PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /bundled Office Runtime is missing/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stopping a PDF export removes partial files and preserves the source", {
  skip: process.platform === "win32",
}, (t) => {
  const python = process.env.PI_CODE_OFFICE_TEST_PYTHON ?? "python3";
  const check = spawnSync(python, ["-I", "-c", "import sys, pypdf; assert sys.version_info >= (3, 12)"]);
  if (!process.env.PI_CODE_OFFICE_TEST_PYTHON && check.status !== 0) {
    t.skip("Python 3.12 and pypdf are available in the Office Runtime, not this host.");
    return;
  }
  assert.equal(check.status, 0, check.error?.message ?? check.stderr?.toString());
  const script = fileURLToPath(new URL("./offline-office-pdf.test.py", import.meta.url));
  const result = spawnSync(python, ["-I", "-B", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test("Word commands fail clearly without the bundled interpreters", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pie-office-test-"));
  try {
    const plugins = join(root, "plugins");
    await mkdir(plugins);
    const installed = join(plugins, "pie.offline-office");
    await cp(plugin, installed, { recursive: true });
    const launcher = join(installed, "word", "word.sh");
    for (const args of [["create", "文档 样例.docx", "标题"], ["extract", "文档 样例.docx"]]) {
      const result = spawnSync("/bin/sh", [launcher, ...args], { cwd: root, encoding: "utf8", env: { PATH: "" } });
      assert.equal(result.status, 1, result.error?.message ?? result.stderr);
      assert.match(result.stderr, /bundled Office Runtime is missing/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withOfficeFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pie-office-package-test-"));
  try {
    const runtime = join(root, "office-runtime");
    const put = async (relative, contents, mode) => {
      const file = join(runtime, relative);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, { mode });
      return file;
    };
    const docx = { version: "9.16.0", main: "dist/index.cjs", dependencies: { jszip: "^3.10.1" } };
    // Run the real Node launcher against the fixture's package tree.
    const node = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    await put("node/bin/node", "#!/bin/sh\nexec " + node + ' "$@"\n', 0o755);
    await put("python/bin/python3.12", "#!/bin/sh\nexit 1\n", 0o755);
    await put("metadata/runtime-source.json", "{}");
    await put("metadata/package-lock.json", JSON.stringify({ packages: { "node_modules/docx": docx } }));
    await put("node/lib/node_modules/docx/package.json", JSON.stringify(docx));
    const site = "python/lib/python3.12/site-packages";
    for (const module of [
      "lxml", "docx", "pandas", "dateutil", "numpy", "openpyxl", "pptx", "PIL", "xlsxwriter", "pypdf", "reportlab",
    ]) {
      await put(`${site}/${module}/__init__.py`, "");
    }
    await put(`${site}/six.py`, "");
    await put(`${site}/pandas-3.1.1.dist-info/METADATA`, "Name: pandas\nVersion: 3.1.1\n");
    await put(`${site}/python_dateutil-2.9.0.post0.dist-info/METADATA`, "Name: python-dateutil\nVersion: 2.9.0.post0\n");
    await put("libreoffice/program/soffice", "#!/bin/sh\nexit 1\n", 0o755);
    await put("libreoffice/program/soffice.bin", "", 0o755);
    await cp(plugin, join(root, "plugins", "pie.offline-office"), { recursive: true });
    await run({ root, runtime, put });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the Kylin Office package requires WX and registers its bundled Skill", async (t) => {
  await withOfficeFixture(async ({ root, runtime }) => {
    const wx = join(root, "wx input");
    const appOutDir = join(root, "app");
    const bundle = () => bundleOfflineOffice({
      electronPlatformName: "linux", arch: 3, appOutDir, targets: [{ name: "deb" }],
    });
    for (const key of ["PI_CODE_OFFICE_RUNTIME_DIR", "PI_CODE_WX_RUNTIME_DIR"]) {
      const previous = process.env[key];
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    process.env.PI_CODE_OFFICE_RUNTIME_DIR = runtime;
    delete process.env.PI_CODE_WX_RUNTIME_DIR;
    await assert.rejects(bundle, /PI_CODE_WX_RUNTIME_DIR/);
    process.env.PI_CODE_WX_RUNTIME_DIR = wx;
    await mkdir(wx);
    await writeFile(join(wx, "VERSION"), "0.21.2\n");
    await assert.rejects(bundle, /WX.*0\.21\.3/);
    for (const file of ["OFFLINE_PACKAGE", "VERSION", "scripts/offline_install.py", "scripts/main.py",
      "assets/wx_template.docx", "wheelhouse/wheels.tar.xz"]) {
      await mkdir(dirname(join(wx, file)), { recursive: true });
      await writeFile(join(wx, file), {
        OFFLINE_PACKAGE: "version=0.21.3\nplatform=linux-arm64\n", VERSION: "0.21.3\n",
      }[file] ?? "fixture");
    }
    const wheel = "lxml-6.1.1-cp312-cp312-manylinux_2_26_aarch64.whl";
    const manifestPath = join(wx, "wheelhouse", "manifest.json");
    const selection = ["cp312/" + wheel];
    const record = { python_tag: "cp312", wheel, sha256: "a".repeat(64) };
    const writeManifest = (cp312, wheels) => writeFile(manifestPath, JSON.stringify({
      platform: "linux-arm64", environments: { cp312 }, wheels,
    }));
    for (const [cp312, wheels] of [
      [selection[0], [record]],
      [selection, undefined],
      [["cp312/missing.whl"], [record]],
      [[...selection, ...selection], [record]],
      [selection, [{ ...record, sha256: "invalid" }]],
    ]) {
      await writeManifest(cp312, wheels);
      await assert.rejects(bundle, /WX offline wheelhouse/);
    }
    await writeManifest(selection, [record]);
    await bundle();
    const resources = join(appOutDir, "resources");
    const installed = join(resources, "plugins", "pie.offline-office");
    const manifest = JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"));
    const skill = manifest.contributes.skills.find(({ id }) => id === "wx");
    assert.match(await readFile(join(installed, skill.path), "utf8"), /wx\.sh/);
    assert.equal(await readFile(join(resources, "wx-runtime", "wheelhouse", "wheels.tar.xz"), "utf8"), "fixture");
  });
});

test("WX blocks delivery when the converter succeeds but its audit requires review", {
  skip: process.platform === "win32",
}, async () => {
  await withOfficeFixture(async ({ root, put }) => {
    // Substitute only the external converter; the installed launcher still makes the delivery decision.
    await put("python/bin/python3.12", '#!/bin/sh\nexec python3 "$@"\n');
    const wx = join(root, "wx-runtime");
    await mkdir(join(wx, "scripts"), { recursive: true });
    await mkdir(join(wx, "assets"));
    await writeFile(join(wx, "VERSION"), "9.8.7\n");
    await writeFile(join(wx, "assets/wx_template.docx"), "");
    await writeFile(join(wx, "scripts/offline_install.py"), `
from pathlib import Path
import sys
Path(sys.argv[2]).mkdir(parents=True, exist_ok=True)
`);
    await writeFile(join(wx, "scripts/main.py"), `
from pathlib import Path
import argparse
parser = argparse.ArgumentParser()
for arg in ("input", "output", "report", "template"):
    parser.add_argument("--" + arg, type=Path)
args = parser.parse_args()
args.output.write_text("formatted")
args.report.write_bytes(args.input.read_bytes())
`);
    const source = join(root, "source.md");
    const run = async (output, public_summary) => {
      await writeFile(source, JSON.stringify({ public_summary }));
      return spawnSync("/bin/sh", [join(root, "plugins/pie.offline-office/wx/wx.sh"), "convert", source, output], {
        cwd: root, encoding: "utf8", env: { ...process.env, PI_DESKTOP_DATA_DIR: join(root, "data") },
      });
    };
    const clean = {
      schema_version: "1.0", status: "completed",
      audits: { audit: "passed", model_audit: "passed", saved_output_audit: "passed", appendix_preservation_audit: "not_run" },
      unexpected_styles_count: 0, manual_review_required: false, diagnostic_codes: [],
    };
    const warning = { ...clean, status: "completed_with_warnings", diagnostic_codes: ["WXDF-W-SAMPLE"] };
    for (const [directory, summary] of [
      ["manual", { ...warning, manual_review_required: true }],
      ["audit-failed", { ...clean, audits: { ...clean.audits, saved_output_audit: "failed" } }],
      ["style-count", { ...clean, unexpected_styles_count: true }],
      ["missing-summary", undefined],
    ]) {
      const result = await run(directory, summary);
      assert.equal(result.status, 1, result.error?.message ?? result.stderr);
      assert.match(result.stderr, /WX audit: delivery blocked/);
      assert.deepEqual(JSON.parse(await readFile(join(root, directory, "audit.json"), "utf8")).public_summary, summary);
    }
    for (const [directory, summary] of [["clean", clean], ["warning", warning]]) {
      const result = await run(directory, summary);
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(await readFile(join(root, directory, "formatted.docx"), "utf8"), "formatted");
      if (directory === "warning") assert.match(result.stderr, /WXDF-W-SAMPLE/);
    }
    assert.ok((await stat(join(root, "data/offline-office/wx-9.8.7/deps"))).isDirectory());
  });
});

test("the package check requires the pinned pandas and python-dateutil distributions", async () => {
  await withOfficeFixture(async ({ runtime, put }) => {
    for (const [distribution, version] of [["pandas", "3.1.1"], ["python_dateutil", "2.9.0.post0"]]) {
      const file = `python/lib/python3.12/site-packages/${distribution}-${version}.dist-info/METADATA`;
      await put(file, "Version: 1.0.0\n");
      await assert.rejects(verifyOfflineOfficeRuntime(runtime), new RegExp(`Expected ${distribution} ${version}`));
      await put(file, `Version: ${version}\n`);
    }
    await verifyOfflineOfficeRuntime(runtime);
  });
});

test("the packaged Office Runtime rejects absolute, dangling, and escaping links", {
  skip: process.platform === "win32",
}, async () => {
  await withOfficeFixture(async ({ root, runtime, put }) => {
    const linkedRoot = join(root, "linked-runtime");
    await symlink(runtime, linkedRoot);
    await assert.rejects(verifyOfflineOfficeRuntime(linkedRoot), /Office Runtime link/);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "");
    await put("metadata/inside.txt", "");
    await symlink("inside.txt", join(runtime, "metadata/relative-link"));
    await verifyOfflineOfficeRuntime(runtime);
    for (const target of [outside, "../../outside.txt", "missing.txt"]) {
      const link = join(runtime, "metadata/invalid-link");
      await symlink(target, link);
      await assert.rejects(verifyOfflineOfficeRuntime(runtime), /Office Runtime link/);
      await unlink(link);
    }
  });
});

test("the package smoke check rejects a docx manifest without its installed entry point", {
  skip: process.platform === "win32",
}, async () => {
  await withOfficeFixture(async ({ root }) => {
    const bundle = await import("../../../scripts/bundle-offline-office.mjs");
    await assert.rejects(async () => bundle.smokeTestOfflineOffice(root), /Office Word package smoke test failed.*bundled Office Runtime is incomplete/s);
  });
});

test("Word editing preserves layout boundaries, selects the actual DOCX body, and refuses overwrites", (t) => {
  const check = spawnSync("python3", ["-c", "import lxml"]);
  if (check.status !== 0) {
    t.skip("Python 3 with lxml is available in the Office Runtime, not this host.");
    return;
  }
  const script = fileURLToPath(new URL("./offline-office-word.test.py", import.meta.url));
  const result = spawnSync("python3", ["-B", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test("Excel commands read and write tables, keep copy boundaries, and recalculate only on request", {
  skip: process.platform === "win32",
}, (t) => {
  const python = process.env.PI_CODE_OFFICE_TEST_PYTHON ?? "python3";
  const check = spawnSync(python, ["-I", "-c", "import lxml, openpyxl, pandas"]);
  if (!process.env.PI_CODE_OFFICE_TEST_PYTHON && check.status !== 0) {
    t.skip("The isolated Python dependencies are available in the Office Runtime, not this host.");
    return;
  }
  assert.equal(check.status, 0, check.error?.message ?? check.stderr?.toString());
  const script = fileURLToPath(new URL("./offline-office-excel.test.py", import.meta.url));
  const result = spawnSync(python, ["-I", "-B", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
