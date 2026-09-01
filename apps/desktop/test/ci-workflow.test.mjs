import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  ciWorkflowSource,
  releaseWorkflowSource,
  agentRuntimePackageSource,
  i18nPackageSource,
  pluginSdkPackageSource,
  sharedPackageSource,
  releaseMacScriptSource,
] = await Promise.all([
  read("../../../.github/workflows/ci.yml"),
  read("../../../.github/workflows/release.yml"),
  read("../../../packages/agent-runtime/package.json"),
  read("../../../packages/i18n/package.json"),
  read("../../../packages/plugin-sdk/package.json"),
  read("../../../packages/shared/package.json"),
  read("../../../scripts/release-macos.sh"),
]);

test("CI skips documentation-only pushes and pull requests", () => {
  assert.equal(
    (ciWorkflowSource.match(/- 'docs\/\*\*'/g) ?? []).length,
    2,
    "docs path is ignored by push and pull_request triggers",
  );
  assert.equal(
    (ciWorkflowSource.match(/- '\*\*\/\*\.md'/g) ?? []).length,
    2,
    "Markdown files are ignored by push and pull_request triggers",
  );
  assert.match(ciWorkflowSource, /^  workflow_dispatch:/m);
});

test("CI does not typecheck workspace dependencies twice", () => {
  for (const source of [
    agentRuntimePackageSource,
    i18nPackageSource,
    pluginSdkPackageSource,
    sharedPackageSource,
  ]) {
    assert.match(JSON.parse(source).scripts.build, /^tsc\b/);
  }

  assert.match(
    ciWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop typecheck/,
  );
  assert.doesNotMatch(ciWorkflowSource, /run: pnpm typecheck/);
});

test("release runners validate tags without a separate job barrier", () => {
  assert.doesNotMatch(releaseWorkflowSource, /^  validate:/m);
  assert.doesNotMatch(releaseWorkflowSource, /^    needs: validate$/m);
  assert.match(
    releaseWorkflowSource,
    /TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/,
  );
  assert.match(
    releaseWorkflowSource,
    /Tag v\$TAG_VERSION does not match apps\/desktop\/package\.json version \$APP_VERSION/,
  );
});

test("release preparation overlaps independent work and avoids duplicate builds", () => {
  assert.match(
    releaseWorkflowSource,
    /cargo build --release --locked -p host-core &/,
  );
  assert.match(releaseWorkflowSource, /wait "\$host_build_pid"/);
  assert.match(
    releaseWorkflowSource,
    /pnpm --filter '@pi-desktop\/desktop\^\.\.\.' --fail-if-no-match build/,
  );
  assert.doesNotMatch(releaseWorkflowSource, /run: pnpm build:js/);
});

test("release artifacts bypass redundant Actions compression", () => {
  assert.match(
    releaseWorkflowSource,
    /uses: actions\/upload-artifact@v4[\s\S]*?compression-level: 0/,
  );
});

test("release matrix packages both native macOS architectures", () => {
  assert.match(
    releaseWorkflowSource,
    /name: macOS arm64[\s\S]*?os: macos-15[\s\S]*?arch: arm64[\s\S]*?runner_arch: arm64/,
  );
  assert.match(
    releaseWorkflowSource,
    /name: macOS Intel x64[\s\S]*?os: macos-15-intel[\s\S]*?arch: x64[\s\S]*?runner_arch: x86_64/,
  );
  assert.match(
    releaseWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop run \$\{\{ matrix\.dist \}\} -- --\$\{\{ matrix\.arch \}\}/,
  );
  assert.match(
    releaseWorkflowSource,
    /latest-mac-\$\{\{ matrix\.arch \}\}\.yml/,
  );
  assert.match(releaseWorkflowSource, /Merge macOS updater metadata[\s\S]*?ruby/);
});

test("the signed local macOS lane selects the native runner architecture", () => {
  assert.match(releaseMacScriptSource, /DEFAULT_MAC_ARCH/);
  assert.match(releaseMacScriptSource, /MAC_ARCH="\$\{MAC_ARCH:-\$DEFAULT_MAC_ARCH\}"/);
  assert.match(releaseMacScriptSource, /must match the host/);
  assert.match(releaseMacScriptSource, /electron-builder --mac "--\$\{MAC_ARCH\}"/);
});
