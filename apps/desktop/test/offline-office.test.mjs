import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyOfflineOfficeRuntime } from "../../../scripts/bundle-offline-office.mjs";

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
