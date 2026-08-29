import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const viteConfigSource = await readFile(
  new URL("../electron.vite.config.ts", import.meta.url),
  "utf8",
);

test("packaging installs only the updater runtime dependency", () => {
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "electron-updater",
  ]);

  for (const dependency of [
    "@pi-desktop/agent-runtime",
    "@pi-desktop/i18n",
    "@pi-desktop/plugin-sdk",
    "@pi-desktop/shared",
    "mermaid",
    "pinyin-pro",
    "react",
    "shiki",
  ]) {
    assert.ok(
      packageJson.devDependencies[dependency],
      `${dependency} must be available for bundling without shipping its package tree`,
    );
  }
});

test("renderer output keeps its size controls", async () => {
  // electron-vite's renderer preset hard-defaults minify to false, unlike plain
  // Vite, so leaving it implicit ships unminified chunks.
  assert.match(viteConfigSource, /minify:\s*"esbuild"/);

  // The bundled Chromium supports woff2 universally; woff/truetype src entries
  // would be emitted as assets and never served.
  assert.match(viteConfigSource, /dropLegacyFontFallbacks/);
  assert.match(viteConfigSource, /plugins:\s*\[[^\]]*dropLegacyFontFallbacks\(\)/);

  // build/*.png are electron-builder installer icons (1024px+). The renderer
  // must import the downscaled marks instead.
  const brandLogoSource = await readFile(
    new URL("../src/components/BrandLogo.tsx", import.meta.url),
    "utf8",
  );
  assert.match(brandLogoSource, /"\.\.\/assets\/brand\/logo-light\.png"/);
  assert.match(brandLogoSource, /"\.\.\/assets\/brand\/logo-dark\.png"/);
  assert.doesNotMatch(brandLogoSource, /\.\.\/\.\.\/build\//);
});

test("legacy font fallback stripping only removes redundant fallback sources", () => {
  // Mirror of the pi-drop-legacy-font-fallbacks regex in electron.vite.config.ts.
  const pattern = new RegExp(
    viteConfigSource.match(/code\.replace\(\s*(\/[^\n]+\/g)/)[1].slice(1, -2),
    "g",
  );
  const strip = (css) => css.replace(pattern, "");

  // A KaTeX-shaped face keeps only its woff2 source.
  assert.equal(
    strip('src:url(a.woff2) format("woff2"),url(a.woff) format("woff"),url(a.ttf) format("truetype");'),
    'src:url(a.woff2) format("woff2");',
  );

  // The bundled faces use woff2-variations and must survive untouched.
  const variations = 'src: url("../f.woff2") format("woff2-variations");';
  assert.equal(strip(variations), variations);

  // A face whose only source is a legacy format would otherwise lose every
  // source; the leading comma in the pattern is what protects it.
  for (const soleSource of [
    'src: url(only.woff) format("woff");',
    'src: url(only.ttf) format("truetype");',
  ]) {
    assert.equal(strip(soleSource), soleSource);
  }

  // Stripping must never leave a dangling comma or an empty declaration.
  for (const css of [
    'src:url(a.woff2) format("woff2"),url(a.woff) format("woff");',
    'src:url(a.woff2) format("woff2"),url("data:font/woff;base64,AA)BB") format("woff");',
  ]) {
    const out = strip(css);
    assert.doesNotMatch(out, /,\s*;/);
    assert.doesNotMatch(out, /src:\s*;/);
  }
});

test("main bundles JavaScript dependencies and externalizes only runtime modules", () => {
  assert.doesNotMatch(viteConfigSource, /externalizeDepsPlugin\s*\(/);
  assert.match(viteConfigSource, /external:\s*\["electron-updater"\]/);
  assert.doesNotMatch(viteConfigSource, /node-pty/);
  assert.doesNotMatch(JSON.stringify(packageJson.dependencies), /node-pty/);
});

test("packaging keeps only shipped locales and excludes non-runtime artifacts", () => {
  assert.deepEqual(packageJson.build.electronLanguages, [
    "en-US",
    "zh-CN",
    // electron-builder uses underscore locale directories in macOS bundles.
    "zh_CN",
  ]);
  assert.ok(packageJson.build.files.includes("!**/*.map"));
  assert.ok(
    packageJson.build.files.includes(
      "!**/node_modules/*/{test,tests,__tests__,powered-test,example,examples}/**",
    ),
  );
  assert.ok(
    packageJson.build.files.includes(
      "!**/node_modules/**/*.{test,spec}.{js,cjs,mjs}",
    ),
  );
  assert.ok(
    packageJson.build.files.includes(
      "!**/node_modules/node-addon-api/tools/**",
    ),
  );
  assert.ok(
    packageJson.build.files.includes(
      "!**/node_modules/node-addon-api/*.{c,gyp,gypi,h,js,json}",
    ),
  );
  assert.ok(
    packageJson.build.files.includes(
      "!**/node_modules/node-addon-api/README.md",
    ),
  );
  assert.ok(
    !packageJson.build.files.includes("!**/node_modules/node-addon-api/**"),
    "node-addon-api license must not be removed with its build-only files",
  );
  assert.ok(
    packageJson.build.files.every(
      (pattern) => !/LICENSE|NOTICE|\*\.md/.test(pattern),
    ),
    "third-party license and notice files must remain packageable",
  );
  assert.deepEqual(packageJson.build.extraResources, [
    {
      from: "build/icon.png",
      to: "tray-icon.png",
    },
    {
      from: "../../packages/agent-runtime/dist-bundle",
      to: "agent-runtime",
    },
    // Built-in skills stay outside the asar so they read as plain files.
    {
      from: "resources/skills",
      to: "skills",
    },
    // Bundled first-party plugins, for the same reason: host-core reads their
    // manifests from disk and the views are loaded as file:// pages (ADR 0105).
    {
      from: "resources/plugins",
      to: "plugins",
    },
    {
      from: "resources/models.dev",
      to: "models.dev",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(packageJson.build), /node-pty/);
});

test("packaging does not include removed PTY native payload configuration", () => {
  assert.deepEqual(packageJson.build.asar, { smartUnpack: false });
  assert.equal(packageJson.build.asarUnpack, undefined);
  assert.doesNotMatch(JSON.stringify(packageJson.build.files), /node-pty/);
  assert.doesNotMatch(JSON.stringify(packageJson.build.extraResources), /node-pty/);
});
