import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  ciWorkflowSource,
  releaseWorkflowSource,
  desktopPackageSource,
  linuxPackageWorkflowSource,
  agentRuntimePackageSource,
  i18nPackageSource,
  pluginSdkPackageSource,
  sharedPackageSource,
  releaseMacScriptSource,
  releaseAsarScriptSource,
] = await Promise.all([
  read("../../../.github/workflows/ci.yml"),
  read("../../../.github/workflows/release.yml"),
  read("../package.json"),
  read("../../../.github/workflows/linux-package.yml"),
  read("../../../packages/agent-runtime/package.json"),
  read("../../../packages/i18n/package.json"),
  read("../../../packages/plugin-sdk/package.json"),
  read("../../../packages/shared/package.json"),
  read("../../../scripts/release-macos.sh"),
  read("../../../scripts/export-linux-asar.mjs"),
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

test("manual Linux package validation covers the RPM desktop identity", () => {
  assert.match(linuxPackageWorkflowSource, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.match(linuxPackageWorkflowSource, /runs-on: ubuntu-22\.04/);
  assert.match(
    linuxPackageWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop run dist:linux -- --x64/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /name: Install RPM inspection tools[\s\S]*apt-get install[\s\S]*cpio rpm/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /find apps\/desktop\/release[\s\S]*-name '\*\.rpm'/,
  );
  assert.match(linuxPackageWorkflowSource, /rpm -qpl "\$rpm_package"/);
  assert.match(linuxPackageWorkflowSource, /build-id/);
  assert.match(
    linuxPackageWorkflowSource,
    /usr\/share\/applications\/pi-desktop\.desktop/,
  );
  assert.match(linuxPackageWorkflowSource, /Icon=pi-desktop/);
  assert.match(linuxPackageWorkflowSource, /StartupWMClass=pi-desktop/);
  assert.match(
    linuxPackageWorkflowSource,
    /uses: actions\/upload-artifact@v4[\s\S]*path: apps\/desktop\/release\/\*\.rpm/,
  );
});

test("release workflow publishes the Linux ASAR beside installers", () => {
  assert.match(
    releaseWorkflowSource,
    /if: matrix\.platform == 'linux'[\s\S]*?node scripts\/export-linux-asar\.mjs/,
  );
  assert.match(releaseWorkflowSource, /apps\/desktop\/release\/\*\.asar/);
  assert.match(
    releaseAsarScriptSource,
    /linux-unpacked\/resources\/app\.asar/,
  );
  assert.match(
    releaseAsarScriptSource,
    /PI-Desktop-\$\{releaseVersion\}-linux-x64\.asar/,
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
    /name: Package installers \(\$\{\{ matrix\.dist \}\}\)[\s\S]*?if: matrix\.platform != 'macos'[\s\S]*?run: pnpm --filter @pi-desktop\/desktop run \$\{\{ matrix\.dist \}\} -- --\$\{\{ matrix\.arch \}\}/,
  );
  assert.equal(
    JSON.parse(desktopPackageSource).build.dmg.artifactName,
    "PI-Desktop-${version}-${arch}.${ext}",
    "DMG names include the target architecture",
  );
  assert.equal(
    JSON.parse(desktopPackageSource).build.zip.artifactName,
    "PI-Desktop-${version}-${arch}-mac.${ext}",
    "ZIP names include the target architecture",
  );
  assert.match(
    releaseWorkflowSource,
    /Package unsigned macOS installer[\s\S]*?pnpm --filter @pi-desktop\/desktop run dist:mac -- --\$\{\{ matrix\.arch \}\}/,
    "unsigned macOS builds use the shared artifact naming config",
  );
  assert.doesNotMatch(
    releaseWorkflowSource,
    /dmg\.artifactName|zip\.artifactName/,
    "release workflow does not duplicate target naming overrides",
  );
  assert.match(
    releaseWorkflowSource,
    /latest-mac-\$\{\{ matrix\.arch \}\}\.yml/,
  );
  assert.match(
    releaseWorkflowSource,
    /name: Verify macOS artifact names[\s\S]*?Expected exactly one[\s\S]*?Unexpected unlabelled or wrong-architecture macOS artifact/,
    "macOS publication rejects ambiguous artifact names",
  );
  assert.match(
    releaseWorkflowSource,
    /Remove stale GitHub Release assets[\s\S]*?dist\/\$asset[\s\S]*?gh release delete-asset/,
    "reruns remove obsolete release assets",
  );
  assert.match(releaseWorkflowSource, /Merge macOS updater metadata[\s\S]*?ruby/);
});

test("macOS release signing is opt-in and disabled by default", () => {
  assert.match(
    releaseWorkflowSource,
    /workflow_dispatch:\s+inputs:\s+sign_macos:[\s\S]*?default:\s*false[\s\S]*?type:\s*boolean/,
  );

  const unsignedBlock = releaseWorkflowSource.match(
    /- name: Package unsigned macOS installer[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(unsignedBlock, "default unsigned macOS package step is missing");
  assert.match(unsignedBlock, /inputs\.sign_macos != true/);
  assert.match(unsignedBlock, /CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/);
  assert.doesNotMatch(unsignedBlock, /CSC_LINK:|CSC_KEY_PASSWORD:|APPLE_/);
  assert.doesNotMatch(unsignedBlock, /forceCodeSigning|notarize/);

  const signedBlock = releaseWorkflowSource.match(
    /- name: Package signed and notarized macOS installer[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(signedBlock, "explicit signed macOS package step is missing");
  assert.match(signedBlock, /inputs\.sign_macos == true/);
  for (const secret of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(signedBlock, new RegExp(`${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`));
  }
  assert.match(signedBlock, /-c\.mac\.forceCodeSigning=true/);
  assert.match(signedBlock, /-c\.mac\.notarize=true/);
  assert.match(
    releaseWorkflowSource,
    /Staple macOS installer ticket[\s\S]*?if: matrix\.platform == 'macos' && inputs\.sign_macos == true[\s\S]*?Verify signed and notarized macOS installer/,
  );
});

test("the signed local macOS lane selects the native runner architecture", () => {
  assert.match(releaseMacScriptSource, /DEFAULT_MAC_ARCH/);
  assert.match(releaseMacScriptSource, /MAC_ARCH="\$\{MAC_ARCH:-\$DEFAULT_MAC_ARCH\}"/);
  assert.match(releaseMacScriptSource, /must match the host/);
  assert.match(releaseMacScriptSource, /electron-builder --mac "--\$\{MAC_ARCH\}"/);
  assert.doesNotMatch(
    releaseMacScriptSource,
    /dmg\.artifactName|zip\.artifactName/,
    "the signed local macOS lane uses the shared artifact naming config",
  );
});
