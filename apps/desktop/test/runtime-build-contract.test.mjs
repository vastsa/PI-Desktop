import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const desktopPackageUrl = new URL("../package.json", import.meta.url);
const dependencyBuild = "pnpm --filter \"@pi-desktop/desktop^...\" build";
const depsScript = "pnpm run build:deps";

const readScripts = async () => {
  const pkg = JSON.parse(await readFile(desktopPackageUrl, "utf8"));
  return pkg.scripts ?? {};
};

test("build:deps rebuilds every workspace dependency consumed by Electron", async () => {
  const scripts = await readScripts();

  assert.ok(
    (scripts["build:deps"] ?? "").includes(dependencyBuild),
    "build:deps must rebuild every workspace dependency consumed by Electron",
  );
});

test("desktop dev builds all workspace dependencies before Electron starts", async () => {
  const scripts = await readScripts();
  const predev = scripts.predev ?? "";
  const hostBuild = "cargo build --manifest-path ../../Cargo.toml -p host-core";

  assert.ok(predev.includes(depsScript), "predev must rebuild workspace dependencies");
  assert.ok(predev.includes(hostBuild), "predev must continue building host-core");
  assert.ok(
    predev.indexOf(depsScript) < predev.indexOf(hostBuild),
    "workspace dependency builds must complete before the desktop boot sequence continues",
  );
});

test("packaging scripts rebuild workspace dependencies before bundling", async () => {
  const scripts = await readScripts();
  const rendererBuild = "electron-vite build";

  for (const name of ["pack", "dist", "dist:mac", "dist:win", "dist:linux"]) {
    const script = scripts[name] ?? "";

    assert.ok(
      script.includes(depsScript),
      `${name} must rebuild workspace dependencies so packaging never consumes a stale dist/`,
    );
    assert.ok(
      script.indexOf(depsScript) < script.indexOf(rendererBuild),
      `${name} must rebuild workspace dependencies before ${rendererBuild}`,
    );
  }
});

// tsc -p exits 0 without emitting when a tsbuildinfo claims the project is
// up to date, even if dist/ is gone. Keeping the marker inside dist means
// losing the output also loses the marker, so the next build really rebuilds.
test("workspace packages keep their tsbuildinfo inside the output directory", async () => {
  const packages = ["shared", "i18n", "plugin-sdk", "plugin-devkit", "agent-runtime"];

  for (const name of packages) {
    const configUrl = new URL(`../../../packages/${name}/tsconfig.json`, import.meta.url);
    const config = JSON.parse(await readFile(configUrl, "utf8"));
    const { outDir, tsBuildInfoFile, composite } = config.compilerOptions ?? {};

    assert.equal(outDir, "dist", `${name} must emit into dist`);
    assert.ok(composite, `${name} is expected to stay a composite project`);
    assert.equal(
      tsBuildInfoFile,
      "dist/tsconfig.tsbuildinfo",
      `${name} must store tsbuildinfo inside dist so a removed dist forces a real rebuild`,
    );

    const pkgUrl = new URL(`../../../packages/${name}/package.json`, import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
    assert.match(
      pkg.scripts?.clean ?? "",
      /rmSync\('dist'/,
      `${name} clean must remove dist (which now carries the tsbuildinfo)`,
    );
  }
});

test("Electron main defines __dirname from its ESM output location", async () => {
  const config = await readFile(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /"__dirname"\s*:\s*"import\.meta\.dirname"/);
});
