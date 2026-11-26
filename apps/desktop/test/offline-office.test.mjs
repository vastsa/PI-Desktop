import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import bundleOfflineOffice, { verifyOfflineOfficeRuntime } from "../../../scripts/bundle-offline-office.mjs";

const plugin = new URL("../resources/offline-office/", import.meta.url);

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
    for (const module of ["lxml", "docx", "pandas", "dateutil", "numpy", "openpyxl", "pptx", "PIL", "xlsxwriter"]) {
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
      "assets/wx_template.docx", "wheelhouse/manifest.json", "wheelhouse/wheels.tar.xz"]) {
      await mkdir(dirname(join(wx, file)), { recursive: true });
      await writeFile(join(wx, file), {
        OFFLINE_PACKAGE: "version=0.21.3\nplatform=linux-arm64\n", VERSION: "0.21.3\n",
        "wheelhouse/manifest.json": JSON.stringify({ platform: "linux-arm64", environments: { cp312: ["fixture"] } }),
      }[file] ?? "fixture");
    }
    await bundle();
    const resources = join(appOutDir, "resources");
    const installed = join(resources, "plugins", "pie.offline-office");
    const manifest = JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"));
    const skill = manifest.contributes.skills.find(({ id }) => id === "wx");
    assert.match(await readFile(join(installed, skill.path), "utf8"), /wx\.sh/);
    assert.equal(await readFile(join(resources, "wx-runtime", "wheelhouse", "wheels.tar.xz"), "utf8"), "fixture");
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
