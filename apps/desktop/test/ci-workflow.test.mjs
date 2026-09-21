import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  ciWorkflowSource,
  releaseWorkflowSource,
  desktopPackageSource,
  linuxPackageWorkflowSource,
  mirrorToCnbWorkflowSource,
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
  read("../../../.github/workflows/mirror-to-cnb.yml"),
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
  // The full JS build belongs to the verify gate; the build matrix only
  // builds the desktop app's workspace dependencies.
  const buildJob = releaseWorkflowSource.match(/^  build:\n[\s\S]*?(?=^  publish:)/m)?.[0];
  assert.ok(buildJob, "release build job is missing");
  assert.doesNotMatch(buildJob, /run: pnpm build:js/);
});

test("release builds are gated on the CI checks and least-privilege permissions", () => {
  assert.match(releaseWorkflowSource, /^permissions:\n  contents: read$/m);
  assert.match(releaseWorkflowSource, /^  verify:/m);
  assert.match(releaseWorkflowSource, /^  build:\n[\s\S]*?^    needs: verify$/m);
  const verifyJob = releaseWorkflowSource.match(/^  verify:\n[\s\S]*?(?=^  build:)/m)?.[0];
  assert.ok(verifyJob, "release verify job is missing");
  for (const step of [
    /run: pnpm build:js/,
    /run: pnpm --filter @pi-desktop\/desktop typecheck/,
    /run: pnpm lint/,
    /run: pnpm -r --if-present test/,
    /run: cargo test -p host-core --locked/,
  ]) {
    assert.match(verifyJob, step);
  }
  const publishJob = releaseWorkflowSource.match(/^  publish:\n[\s\S]*$/m)?.[0];
  assert.ok(publishJob, "release publish job is missing");
  assert.match(publishJob, /^    permissions:\n      contents: write$/m);
});

test("release artifacts bypass redundant Actions compression", () => {
  assert.match(
    releaseWorkflowSource,
    /uses: actions\/upload-artifact@v7[\s\S]*?compression-level: 0/,
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
    /uses: actions\/upload-artifact@v7[\s\S]*path: apps\/desktop\/release\/\*\.rpm/,
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
    JSON.parse(desktopPackageSource).build.mac.artifactName,
    "PI-Desktop-${version}-${arch}-mac.${ext}",
    "macOS ZIP names include the target architecture",
  );
  assert.equal(
    JSON.parse(desktopPackageSource).build.dmg.artifactName,
    "PI-Desktop-${version}-${arch}.${ext}",
    "macOS DMG names include the target architecture",
  );
  assert.match(
    releaseWorkflowSource,
    /Package unsigned macOS installer[\s\S]*?pnpm --filter @pi-desktop\/desktop run dist:mac -- --\$\{\{ matrix\.arch \}\}/,
    "unsigned macOS builds use the shared artifact naming config",
  );
  assert.doesNotMatch(
    releaseWorkflowSource,
    /-c\.(?:dmg|zip)\.artifactName/,
    "release workflow does not pass unsupported target overrides",
  );
  assert.match(
    releaseWorkflowSource,
    /name: Verify macOS artifact names[\s\S]*?Expected exactly one[\s\S]*?Unexpected unlabelled or wrong-architecture macOS artifact/,
    "macOS publication rejects ambiguous artifact names",
  );
  assert.match(
    releaseWorkflowSource,
    /latest-mac-\$\{\{ matrix\.arch \}\}\.yml/,
  );
  assert.match(releaseWorkflowSource, /Merge macOS updater metadata[\s\S]*?ruby/);
});

test("macOS release signing is required on tag pushes", () => {
  assert.match(
    releaseWorkflowSource,
    /workflow_dispatch:\s+inputs:\s+sign_macos:[\s\S]*?default:\s*true[\s\S]*?type:\s*boolean/,
  );
  assert.ok(
    releaseWorkflowSource.includes(
      "MACOS_SIGN_RELEASE: ${{ github.event_name != 'workflow_dispatch' || inputs.sign_macos == true }}",
    ),
  );

  const unsignedBlock = releaseWorkflowSource.match(
    /- name: Package unsigned macOS installer[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(unsignedBlock, "unsigned macOS debug package step is missing");
  assert.match(unsignedBlock, /env\.MACOS_SIGN_RELEASE != 'true'/);
  assert.match(unsignedBlock, /CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/);
  assert.doesNotMatch(unsignedBlock, /CSC_LINK:|CSC_KEY_PASSWORD:|APPLE_/);
  assert.doesNotMatch(unsignedBlock, /forceCodeSigning|notarize/);

  assert.match(
    releaseWorkflowSource,
    /Require macOS signing and notarization secrets[\s\S]*?Missing GitHub Actions secrets for macOS signing/,
  );
  assert.match(releaseWorkflowSource, /APPLE_TEAM_ID must be DUV63RKYTW/);

  const signedBlock = releaseWorkflowSource.match(
    /- name: Package signed and notarized macOS installer[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(signedBlock, "signed macOS package step is missing");
  assert.match(signedBlock, /env\.MACOS_SIGN_RELEASE == 'true'/);
  for (const secret of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(signedBlock, new RegExp(`${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`));
  }
  // electron-builder throws InvalidConfigurationError when an identity name
  // keeps the "Developer ID Application:" prefix, so CSC_NAME carries the bare
  // common name and the CLI must not pass -c.mac.identity.
  assert.match(signedBlock, /CSC_NAME: "XingYu Liu \(DUV63RKYTW\)"/);
  assert.doesNotMatch(signedBlock, /-c\.mac\.identity=/);
  assert.doesNotMatch(signedBlock, /CSC_NAME: "Developer ID Application:/);
  assert.match(signedBlock, /-c\.mac\.notarize=true/);
  // The single "signing PI-Desktop.app" line electron-builder prints does not
  // tell walking, per-file codesign, silent retries, and the Apple
  // notarization wait apart; the signing trace and the watchdog carry the rest.
  assert.match(
    signedBlock,
    /DEBUG: "electron-osx-sign\*,electron-notarize\*"/,
  );
  // builder-util's `executing` debug line prints every spawned command with a
  // stem list that does not cover `security set-key-partition-list -k <p12
  // password>`, so electron-builder's namespace is deliberately excluded.
  assert.doesNotMatch(signedBlock, /DEBUG: ".*electron-builder.*"/);
  assert.match(signedBlock, /PI_SIGNING_TIMEOUT_SECONDS: "1800"/);
  assert.match(signedBlock, /PI_SIGNING_STALL_SECONDS: "300"/);
  assert.match(
    signedBlock,
    /node scripts\/macos-signing-watchdog\.mjs \\\n\s+--label "dist:mac-\$\{\{ matrix\.arch \}\}" \\\n\s+-- pnpm --filter @pi-desktop\/desktop run dist:mac/,
    "the signed macOS packaging phase runs under the signing watchdog",
  );
  // electron-builder notarizes only the .app; the DMG needs its own
  // submission before the ticket can be stapled (error 65 otherwise).
  const dmgBlock = releaseWorkflowSource.match(
    /- name: Notarize and staple the macOS DMG[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(dmgBlock, "DMG notarization step is missing");
  assert.match(dmgBlock, /env\.MACOS_SIGN_RELEASE == 'true'/);
  for (const secret of [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(
      dmgBlock,
      new RegExp(`${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`),
    );
  }
  assert.match(
    dmgBlock,
    /node scripts\/macos-signing-watchdog\.mjs[\s\S]*?-- scripts\/notarize-and-staple-macos-release-dmg\.sh apps\/desktop\/release/,
    "the DMG notarization wait runs under the signing watchdog",
  );
  assert.match(dmgBlock, /PI_SIGNING_TIMEOUT_SECONDS: "1200"/);
  assert.match(
    releaseWorkflowSource,
    /- name: Analyze the packaged macOS app bundle[\s\S]*?if: matrix\.platform == 'macos'[\s\S]*?continue-on-error: true[\s\S]*?run: node scripts\/macos-bundle-inventory\.mjs apps\/desktop\/release/,
    "the packaged macOS bundle is measured, without failing a release",
  );
  assert.match(
    releaseWorkflowSource,
    /Notarize and staple the macOS DMG[\s\S]*?if: matrix\.platform == 'macos' && env\.MACOS_SIGN_RELEASE == 'true'[\s\S]*?Verify signed and notarized macOS installer/,
  );
  assert.doesNotMatch(releaseWorkflowSource, /scripts\/staple-macos-release-dmg\.sh/);
});

test("the signed local macOS lane selects the native runner architecture", () => {
  assert.match(releaseMacScriptSource, /DEFAULT_MAC_ARCH/);
  assert.match(releaseMacScriptSource, /MAC_ARCH="\$\{MAC_ARCH:-\$DEFAULT_MAC_ARCH\}"/);
  assert.match(releaseMacScriptSource, /must match the host/);
  assert.match(releaseMacScriptSource, /electron-builder --mac "--\$\{MAC_ARCH\}"/);
  assert.match(releaseMacScriptSource, /XingYu Liu \(DUV63RKYTW\)/);
  assert.match(
    releaseMacScriptSource,
    /MAC_SIGNING_IDENTITY="\$\{MAC_SIGNING_IDENTITY#Developer ID Application: \}"/,
    "the local lane strips the prefix electron-builder rejects",
  );
  assert.doesNotMatch(
    releaseMacScriptSource,
    /-c\.(?:dmg|zip)\.artifactName/,
    "the signed local macOS lane uses the shared artifact naming config",
  );
  // The local lane documents itself as Developer ID + mandatory
  // notarization, so it must pass both flags and must not publish.
  assert.match(releaseMacScriptSource, /-c\.mac\.notarize=true/);
  assert.match(releaseMacScriptSource, /-c\.mac\.forceCodeSigning=true/);
  assert.match(releaseMacScriptSource, /--publish never/);
  assert.doesNotMatch(
    releaseMacScriptSource,
    /DEBUG="\$\{DEBUG:-[^}]*electron-builder/,
    "the local lane must not enable builder-util's executing debug line",
  );
  assert.match(
    releaseMacScriptSource,
    /node scripts\/macos-signing-watchdog\.mjs --label "release-macos-\$\{MAC_ARCH\}" --/,
    "the local signed macOS lane runs under the signing watchdog",
  );
  assert.match(
    releaseMacScriptSource,
    /node scripts\/macos-bundle-inventory\.mjs apps\/desktop\/release/,
  );
  // The DMG is submitted, stapled, and validated once, and the release is
  // verified exactly once.
  assert.match(
    releaseMacScriptSource,
    /scripts\/notarize-and-staple-macos-release-dmg\.sh apps\/desktop\/release/,
  );
  assert.equal(
    (releaseMacScriptSource.match(/scripts\/verify-macos-release\.sh/g) ?? []).length,
    1,
    "the local signed macOS lane verifies the release exactly once",
  );
  assert.doesNotMatch(releaseMacScriptSource, /scripts\/staple-macos-release-dmg\.sh/);
});

/**
 * The regression that broke the local signed lane: a rewrite replaced the
 * electron-builder flags with two commands but kept the line continuation, so
 * one command became a positional argument while the other still pointed at a
 * deleted script. Every script path either lane references must exist.
 */
test("both macOS lanes only reference scripts that exist", async () => {
  const referenced = new Set();
  for (const source of [releaseMacScriptSource, releaseWorkflowSource]) {
    for (const match of source.matchAll(/(?<![\w./-])scripts\/[A-Za-z0-9._-]+\.(?:sh|mjs)/g)) {
      referenced.add(match[0]);
    }
  }
  assert.ok(referenced.size >= 6, "the macOS lanes reference their scripts");
  const missing = [];
  for (const relPath of referenced) {
    try {
      await access(new URL(`../../../${relPath}`, import.meta.url));
    } catch {
      missing.push(relPath);
    }
  }
  assert.deepEqual(missing, []);
});

test("macOS signing instrumentation stays out of the Windows and Linux lanes", () => {
  const instrumentation =
    /macos-signing-watchdog|macos-signing-diagnostics|macos-bundle-inventory/;
  const stepBlock = (name) =>
    releaseWorkflowSource.match(new RegExp(`- name: ${name}[^]*?(?=\\n      - name:)`))?.[0] ??
    "";
  assert.doesNotMatch(stepBlock("Package installers"), instrumentation);
  assert.doesNotMatch(stepBlock("Verify Linux host-core glibc floor"), instrumentation);
  assert.doesNotMatch(stepBlock("Export Linux ASAR release asset"), instrumentation);
  // The unsigned macOS debug lane reports its bundle size but must not gain a
  // signing identity, notarization, or publishing behaviour.
  const unsignedBlock = stepBlock("Package unsigned macOS installer");
  assert.ok(unsignedBlock, "unsigned macOS debug package step is missing");
  assert.doesNotMatch(unsignedBlock, instrumentation);
});

test("GitHub releases trigger the CNB mirror pipeline with a JSON payload", () => {
  assert.match(
    mirrorToCnbWorkflowSource,
    /release:\s+types:\s+\[published, edited\]/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /workflow_dispatch:\s+inputs:\s+tag:/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /if: github\.repository == 'vastsa\/PI-Desktop'/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /CNB_MIRROR_TOKEN: \$\{\{\s*secrets\.CNB_MIRROR_TOKEN\s*\}\}/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /Missing repository secret CNB_MIRROR_TOKEN/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /https:\/\/api\.cnb\.cool\/aixk\/Pi-Desktop\/-\/build\/start/,
  );
  assert.match(mirrorToCnbWorkflowSource, /event: "api_trigger_mirror"/);
  assert.match(mirrorToCnbWorkflowSource, /env: \{ MIRROR_TAGS: \$tag \}/);
  assert.match(mirrorToCnbWorkflowSource, /jq -n --arg tag "\$MIRROR_TAG"/);
  assert.match(mirrorToCnbWorkflowSource, /curl --fail-with-body/);
  assert.doesNotMatch(
    mirrorToCnbWorkflowSource,
    /-d ".*github\.event\.release\.tag_name/,
    "JSON payload must not interpolate the release tag through YAML string escaping",
  );
});
