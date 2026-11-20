# Fork Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `vX.Y.Z` tag on `david-yang-pixel/PI-Desktop` publishes an unsigned macOS arm64 desktop build plus `pi-host` bundles for Linux x64 and arm64, and the desktop downloads updates and host bundles from the fork.

**Architecture:** One shared constant names the release repository; the updater, the host-bundle URL builder, and the feedback link all derive from it. The upstream signed macOS lane stays in the workflow untouched and dormant behind a repository variable, so later upstream merges conflict as little as possible. An unsigned build is stamped through the existing `piDistribution` package metadata, and the update policy turns that into manual delivery.

**Tech Stack:** GitHub Actions, electron-builder 26, electron-updater, TypeScript, `node --test` (desktop), vitest (`packages/shared`).

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 1, §4.3, §9). This is plan 1 of 7; the other parts get their own plans.

## Global Constraints

- Work on branch `claude/trusting-darwin-gnyao7`. Push only to that branch.
- Release repository: `david-yang-pixel/PI-Desktop`. The plugin marketplace catalog, the documentation site, and both READMEs keep pointing at upstream `vastsa`.
- Desktop release platforms: macOS arm64 only. Host bundles: Linux x64 and arm64, unchanged.
- The fork has no Apple Developer ID certificate. Do not edit the signed macOS lane, its scripts, or the tests that pin them (`macos-release-lane.test.mjs`, `macos-release-verification.test.mjs`, `macos-signing-diagnostics.test.mjs`).
- No SQLite schema change, no RACP or host protocol change, no new dependency.
- Do not run `pnpm install`. Dependencies are already installed in this checkout.
- Stage files by explicit path. Never `git add .` or `git add -A`.
- Commit messages: Conventional Commits, English, subject + blank line + body that explains why, wrapped near 72 columns. No `Co-Authored-By` or `Signed-off-by`.
- Code, comments, and docs are English.
- Do not create a tag or a GitHub Release. Cutting the first fork release is the owner's action after this plan.

## Review Focus

1. A profile that already stores the update preference `automatic` (from an upstream build) opens an unsigned fork build: the app must still use manual delivery and never try an in-app install. Pinned in Task 2.
2. Package metadata carries an unexpected `piDistribution` value (wrong case, a number, missing): the updater must not throw and must behave as it did before this change. Pinned in Task 2.
3. A tag is pushed while the repository variable `MACOS_SIGN_RELEASE` is unset: the unsigned lane runs, and the publish job succeeds with a single macOS feed instead of aborting on "Expected both macOS updater feeds". Pinned in Task 3.
4. A feedback issue URL that still names the upstream repository is offered to the allowlist check: it must be rejected, so a stale link cannot open the wrong tracker. Pinned in Task 1.
5. A paired host on an unpublished target (for example macOS) asks for a bundle: it must still be refused before any download, now against the fork's URLs. Pinned in Task 1.

---

### Task 1: Point release coordinates at the fork

**Files:**
- Modify: `packages/shared/src/github-feedback.ts:1`
- Modify: `packages/shared/src/github-feedback.test.ts`
- Modify: `apps/desktop/electron/main/updater.ts:75`
- Modify: `apps/desktop/package.json` (`homepage`, `build.publish[0].owner`)
- Modify: `apps/desktop/resources/app-update.yml`
- Test: `apps/desktop/test/auto-update.test.mjs:142-146`, `:260`
- Test: `apps/desktop/test/remote-host-pi-host-release.test.mjs:29`
- Test: `apps/desktop/test/remote-host-bootstrap-script.test.mjs:22`
- Test: `apps/desktop/test/remote-host-ssh-bootstrap.test.mjs:19`, `:202`

**Interfaces:**
- Consumes: nothing.
- Produces: `GITHUB_REPO === "david-yang-pixel/PI-Desktop"` exported from `@pi-desktop/shared`; `RELEASES_URL` in `updater.ts` derived from it.

- [ ] **Step 1: Update the failing expectations first**

In `packages/shared/src/github-feedback.test.ts`, add inside the existing `describe`:

```ts
it("targets the fork's issue tracker and rejects the upstream one", () => {
  expect(GITHUB_REPO).toBe("david-yang-pixel/PI-Desktop");
  expect(buildBugReportUrl(sample)).toMatch(
    /^https:\/\/github\.com\/david-yang-pixel\/PI-Desktop\/issues\/new\?/,
  );
  expect(() =>
    assertFeedbackIssueUrl(
      "https://github.com/vastsa/PI-Desktop/issues/new?template=bug_report.yml",
    ),
  ).toThrow(/path/);
});
```

Import `GITHUB_REPO` in that test file if it is not imported yet. In the existing "rejects URLs that leave the allowlisted GitHub issue form" case, change the `feature_request.yml` URL's repository to `david-yang-pixel/PI-Desktop` so it still reaches the template check.

In the four desktop test files listed above, replace `vastsa/PI-Desktop` with `david-yang-pixel/PI-Desktop` in the release-download URL constants and in `auto-update.test.mjs:260` (`owner` becomes `"david-yang-pixel"`). Replace the `auto-update.test.mjs:142-146` source assertion with:

```js
assert.match(
  updaterSource,
  /RELEASES_URL = `https:\/\/github\.com\/\$\{GITHUB_REPO\}\/releases\/latest`/,
  "releases fallback URL follows the shared release repository",
);
```

Leave every other `vastsa` occurrence in tests alone (markdown link fixtures, marketplace fixtures, comments, the CNB mirror gate).

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @pi-desktop/shared exec vitest run src/github-feedback.test.ts`
Expected: FAIL, `expected 'vastsa/PI-Desktop' to be 'david-yang-pixel/PI-Desktop'`.

Run: `cd apps/desktop && node --test test/auto-update.test.mjs test/remote-host-pi-host-release.test.mjs test/remote-host-bootstrap-script.test.mjs test/remote-host-ssh-bootstrap.test.mjs`
Expected: FAIL in each file on the repository name.

- [ ] **Step 3: Change the coordinates**

- `github-feedback.ts`: `export const GITHUB_REPO = "david-yang-pixel/PI-Desktop";`
- `updater.ts`: import `GITHUB_REPO` from `@pi-desktop/shared` and set ``export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;``
- `apps/desktop/package.json`: `homepage` becomes `https://github.com/david-yang-pixel/PI-Desktop`; `build.publish[0].owner` becomes `david-yang-pixel`. Leave `author` and `appId` unchanged.
- `apps/desktop/resources/app-update.yml`: `owner: david-yang-pixel`.

- [ ] **Step 4: Rebuild shared and run the tests**

Run: `pnpm --filter @pi-desktop/shared build && pnpm --filter @pi-desktop/shared exec vitest run src/github-feedback.test.ts`
Expected: PASS.

Run: `cd apps/desktop && node --test test/auto-update.test.mjs test/remote-host-pi-host-release.test.mjs test/remote-host-bootstrap-script.test.mjs test/remote-host-ssh-bootstrap.test.mjs test/safe-open-external.test.mjs`
Expected: PASS. `remote-host-pi-host-release.test.mjs` still refuses `darwin` targets (Review Focus 5).

Run: `pnpm --filter @pi-desktop/desktop typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/github-feedback.ts packages/shared/src/github-feedback.test.ts \
  apps/desktop/electron/main/updater.ts apps/desktop/package.json \
  apps/desktop/resources/app-update.yml apps/desktop/test/auto-update.test.mjs \
  apps/desktop/test/remote-host-pi-host-release.test.mjs \
  apps/desktop/test/remote-host-bootstrap-script.test.mjs \
  apps/desktop/test/remote-host-ssh-bootstrap.test.mjs
git commit
```

Subject: `build(release): point release coordinates at the fork`

---

### Task 2: Unsigned builds use manual update delivery

**Files:**
- Modify: `apps/desktop/electron/main/update-policy.ts`
- Modify: `apps/desktop/electron/main/updater.ts:51-56`, `:113`, `:123`, `:160-175`, `:209-213`
- Test: `apps/desktop/test/update-preference.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, all in `update-policy.ts`:
  - `export type PackagedDistribution = "installed" | "zip" | "portable" | "unsigned";`
  - `export type WindowsDistribution = PackagedDistribution;` (kept so existing imports compile)
  - `export function parsePackagedDistribution(value: unknown): PackagedDistribution | undefined`
  - `supportsAutomaticUpdates(platform, isPackaged, env?, distribution?: PackagedDistribution): boolean`

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/test/update-preference.test.mjs` (destructure `parsePackagedDistribution` and `supportsAutomaticUpdates` from `policy`):

```js
test("an unsigned build never offers in-app delivery", () => {
  assert.equal(supportsAutomaticUpdates("darwin", true, {}, "unsigned"), false);
  assert.equal(resolveDefaultUpdatePreference("darwin", true, {}, "unsigned"), "manual");
  assert.equal(resolveUpdateMode("darwin", true, {}, "unsigned"), "manual");
  // A stored "automatic" preference from another build must not win.
  assert.equal(resolveUpdateMode("darwin", true, {}, "unsigned", "automatic"), "manual");
  // Signed and unmarked builds behave as before.
  assert.equal(supportsAutomaticUpdates("darwin", true, {}, "installed"), true);
  assert.equal(supportsAutomaticUpdates("darwin", true, {}), true);
  assert.equal(resolveUpdateMode("darwin", true, {}, "installed"), "in-app");
  assert.equal(resolveUpdateMode("darwin", false, {}, "unsigned"), "disabled");
});

test("packaged distribution metadata accepts only the known markers", () => {
  for (const value of ["installed", "zip", "portable", "unsigned"]) {
    assert.equal(parsePackagedDistribution(value), value);
  }
  for (const value of ["Unsigned", "", 1, null, undefined, {}, ["unsigned"]]) {
    assert.equal(parsePackagedDistribution(value), undefined);
  }
});
```

- [ ] **Step 2: Run and see them fail**

Run: `cd apps/desktop && node --test test/update-preference.test.mjs`
Expected: FAIL, `supportsAutomaticUpdates is not a function` or `parsePackagedDistribution is not a function`.

- [ ] **Step 3: Implement the policy**

In `update-policy.ts`: add the two types and `parsePackagedDistribution`. Give `supportsAutomaticUpdates` the fourth parameter and return `false` when it is `"unsigned"`, before the platform checks. Pass `distribution` through at the two internal call sites (`resolveDefaultUpdatePreference`, `resolveUpdateMode`).

In `updater.ts`: `readPackagedDistribution` returns `parsePackagedDistribution(distribution)` instead of its inline three-value check; its return type and the two `distribution` fields become `PackagedDistribution`. Pass `distribution` as the fourth argument where `this.automaticSupported` is computed. Keep the `export type { WindowsDistribution }` re-export and add `PackagedDistribution` beside it.

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop && node --test test/update-preference.test.mjs test/auto-update.test.mjs`
Expected: PASS.

Run: `pnpm --filter @pi-desktop/desktop typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/update-policy.ts apps/desktop/electron/main/updater.ts \
  apps/desktop/test/update-preference.test.mjs
git commit
```

Subject: `fix(updater): deliver unsigned builds manually`

---

### Task 3: Release workflow builds the fork's lanes

**Files:**
- Modify: `.github/workflows/release.yml` (header comment, `build.env`, `build.strategy.matrix`, the "Package unsigned macOS installer" step, the publish job's "Merge macOS updater metadata" step and its release comment)
- Test: `apps/desktop/test/ci-workflow.test.mjs`
- Test: `apps/desktop/test/auto-update.test.mjs` (only if an assertion there names a removed lane)

**Interfaces:**
- Consumes: the `"unsigned"` marker from Task 2.
- Produces: repository variable contract `vars.MACOS_SIGN_RELEASE` (`'true'` enables the dormant signed lane; anything else, including unset, builds unsigned).

- [ ] **Step 1: Rewrite the workflow assertions**

In `apps/desktop/test/ci-workflow.test.mjs`:

Replace the exact-string check in "macOS release signing is required on tag pushes" and rename the test to "macOS signing runs only when the repository opts in":

```js
assert.ok(
  releaseWorkflowSource.includes(
    "MACOS_SIGN_RELEASE: ${{ vars.MACOS_SIGN_RELEASE == 'true' && (github.event_name != 'workflow_dispatch' || inputs.sign_macos == true) }}",
  ),
);
```

In the same test, after the existing `unsignedBlock` assertions, add:

```js
assert.match(
  unsignedBlock,
  /dist:mac -- --\$\{\{ matrix\.arch \}\} -c\.extraMetadata\.piDistribution=unsigned/,
  "unsigned packages are stamped so the updater delivers them manually",
);
```

Keep every other assertion in that test; the signed lane is unchanged.

Replace "release matrix packages both native macOS architectures" with "the fork release matrix packages macOS arm64 only": keep the macOS arm64 match, the artifact-name checks, the unsigned-step check, the "Verify macOS artifact names" check, and the `latest-mac-${{ matrix.arch }}.yml` check; delete the macOS Intel match and the "Package installers" match; add:

```js
const matrixNames = [...releaseWorkflowSource.matchAll(/^          - name: (.+)$/gm)].map(
  (match) => match[1],
);
assert.deepEqual(matrixNames, ["macOS arm64"]);
assert.match(
  releaseWorkflowSource,
  /expected_paths = \["latest-mac-arm64\.yml"\]/,
  "publish accepts the single macOS feed the fork builds",
);
assert.match(releaseWorkflowSource, /rm latest-mac-arm64\.yml\n/);
assert.doesNotMatch(releaseWorkflowSource, /latest-mac-x64\.yml/);
```

Delete the test "the release matrix ships native Linux x64 and arm64 lanes". Run the file and delete or narrow any remaining assertion that fails only because it names a removed desktop lane (Windows, Linux, macOS Intel) in `release.yml`. Do not touch assertions about `ci.yml`, `linux-package.yml`, the `pi-host-bundle` job, or `apps/desktop/package.json`.

- [ ] **Step 2: Run and see them fail**

Run: `cd apps/desktop && node --test test/ci-workflow.test.mjs`
Expected: FAIL on the `MACOS_SIGN_RELEASE` string and on `matrixNames`.

- [ ] **Step 3: Edit the workflow**

- `build.env.MACOS_SIGN_RELEASE`: the expression asserted in Step 1. Update the comment above it: tag pushes sign only when the repository variable is `true`.
- `build.strategy.matrix.include`: keep only the `macOS arm64` row.
- "Package unsigned macOS installer": the command becomes
  `pnpm --filter @pi-desktop/desktop run dist:mac -- --${{ matrix.arch }} -c.extraMetadata.piDistribution=unsigned`
  and its comment says it is the fork's release lane, no longer debug-only.
- Publish job, "Merge macOS updater metadata": `expected_paths = ["latest-mac-arm64.yml"]`, the abort message reads `Expected the macOS arm64 updater feed`, and the cleanup line is `rm latest-mac-arm64.yml`.
- Header comment and the "Create GitHub Release" comment: describe what the fork publishes (unsigned macOS arm64 DMG and ZIP, the `latest-mac.yml` feed, and the two `pi-host` bundles).
- Leave the Windows and Linux steps in the build job as they are; they are skipped by their `if` conditions. Leave the signed-lane steps and the `verify` job untouched.
- `pi-host-bundle` job: change only the comment above its matrix. It currently says to keep the list in lockstep with the desktop build matrix; it now says the list follows `PUBLISHED_TARGETS` alone, because the fork ships host bundles for platforms it ships no desktop for.

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop && node --test test/ci-workflow.test.mjs test/auto-update.test.mjs test/macos-release-lane.test.mjs test/macos-release-verification.test.mjs test/macos-signing-diagnostics.test.mjs`
Expected: PASS. The three signing test files pass unmodified.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml apps/desktop/test/ci-workflow.test.mjs
git commit
```

Add `apps/desktop/test/auto-update.test.mjs` to the `git add` only if Step 1 changed it. Subject: `ci(release): build unsigned macOS arm64 and host bundles on the fork`

---

### Task 4: Keep upstream-only automation off the fork

**Files:**
- Modify: `.github/workflows/pi-triage.yml` (job-level `if`)
- Modify: `.github/workflows/pi.yml:24-27` (job-level `if`)
- Test: `apps/desktop/test/ci-workflow.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks use.

Both workflows call a model through `secrets.API_KEY`, which the fork does not have, so every new issue would produce a failed run. `mirror-to-cnb.yml` is already gated on `github.repository == 'vastsa/PI-Desktop'` and stays unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/test/ci-workflow.test.mjs` (read the two workflow files the same way the file reads `mirror-to-cnb.yml`):

```js
test("issue automation that needs upstream secrets runs only upstream", () => {
  for (const source of [piWorkflowSource, piTriageWorkflowSource]) {
    assert.match(source, /github\.repository == 'vastsa\/PI-Desktop'/);
    assert.match(source, /api_key: \$\{\{ secrets\.API_KEY \}\}/);
  }
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd apps/desktop && node --test --test-name-pattern "issue automation" test/ci-workflow.test.mjs`
Expected: FAIL on the repository match.

- [ ] **Step 3: Gate both jobs**

- `pi-triage.yml`: add `if: github.repository == 'vastsa/PI-Desktop'` to its job. If the job already has an `if`, combine with `&&`.
- `pi.yml`: prefix the existing multi-line condition with `github.repository == 'vastsa/PI-Desktop' &&` and wrap the existing three alternatives in one pair of parentheses.

- [ ] **Step 4: Run the test**

Run: `cd apps/desktop && node --test test/ci-workflow.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pi.yml .github/workflows/pi-triage.yml apps/desktop/test/ci-workflow.test.mjs
git commit
```

Subject: `ci: run upstream issue automation only upstream`

---

### Task 5: Record the decision and update the delivery docs

**Files:**
- Create: `docs/adr/fork-release-coordinates.md`
- Modify: `docs/adr/README.md` (one index row, appended at the end of the table)
- Modify: `docs/spec/08-meta/decisions-log.md` (row D686 after D685 at line 468; dated narrative section at the end of the file)
- Modify: `docs/spec/06-delivery/06-release-runbook.md` (§1 Build lanes, §4.3 GitHub tag and manual workflow, §4.5 secrets, §7 Known limitations)
- Modify: `docs/spec/06-delivery/e2e/release-and-platform.md` (one scenario)

**Interfaces:**
- Consumes: the behavior of Tasks 1 to 4.
- Produces: decision id D686.

- [ ] **Step 1: Write the decision record**

`docs/adr/fork-release-coordinates.md`, H1 `# ADR: Fork release coordinates and unsigned macOS builds`, with `- Status: Accepted`, `- Date: 2026-11-20`, and the sections `## Context`, `## Decision`, `## Consequences`, `## Alternatives`. Content to state:

- Context: the fork must ship its own desktop and `pi-host` builds because later work adds a host capability upstream bundles lack; the fork has no Apple Developer ID certificate.
- Decision: `GITHUB_REPO` is `david-yang-pixel/PI-Desktop` and drives the update feed, host bundle URLs, and feedback links; the marketplace, docs site, and READMEs stay upstream; tags build unsigned macOS arm64 only unless `vars.MACOS_SIGN_RELEASE` is `true`; unsigned packages carry `piDistribution: "unsigned"` and always use manual update delivery; upstream issue automation is gated to upstream.
- Consequences: no in-app update on macOS; first launch needs a manual allow; the upstream signed lane and its pinned team identity remain in the tree unused; the release matrix differs from upstream and will conflict on merges of that block.
- Alternatives: parameterizing the Apple team identity (rejected: no certificate exists, and it would rewrite three scripts and three test files for no user); a second repository constant for feedback only (rejected: issues about fork builds belong on the fork).

Index row for `docs/adr/README.md`:
`| fork-release-coordinates | [Fork release coordinates and unsigned macOS builds](fork-release-coordinates.md) | Accepted |`

- [ ] **Step 2: Decisions log, runbook, and E2E scenario**

- Decisions log row D686, topic "Fork release coordinates and unsigned macOS". Decision cell, in bold: "The fork publishes unsigned macOS arm64 desktop builds and Linux pi-host bundles from its own repository, and unsigned packages always use manual update delivery." followed by the log's usual reference to the record, whose id is `fork-release-coordinates`. Rationale cell: "The fork needs its own host bundles and has no Developer ID certificate." Add a `## 2026-11-20 — Fork release coordinates and unsigned macOS (D686)` narrative of three to five sentences at the end of the file.
- Runbook: §1 states the fork's lanes; §4.3 states that a tag builds unsigned unless the repository variable `MACOS_SIGN_RELEASE` is `true`; §4.5 notes the signing secrets are unused on the fork; §7 adds "unsigned macOS builds: manual update only, first launch requires removing the quarantine attribute or allowing the app in System Settings".
- `release-and-platform.md`: add scenario `E2E-RELEASE-unsigned-macos-build-uses-manual-update` in the document's existing scenario format: given a packaged macOS build whose metadata says `piDistribution: "unsigned"` and a profile whose stored preference is automatic, the update mode is manual and the banner opens the fork's releases page. Automated by `apps/desktop/test/update-preference.test.mjs`.

- [ ] **Step 3: Verify the docs**

Run: `pnpm docs:check`
Expected: last line `Verified <n> documentation pages.` with no failure lines.

Run: `pnpm check:agent-policy && git diff --check`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/fork-release-coordinates.md docs/adr/README.md \
  docs/spec/08-meta/decisions-log.md docs/spec/06-delivery/06-release-runbook.md \
  docs/spec/06-delivery/e2e/release-and-platform.md
git commit
```

Subject: `docs(release): record fork release coordinates and unsigned macOS`

---

### Task 6: Full local gate, then a dry run on the fork

**Files:** none, unless the dry run finds a defect.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence for the delivery report.

- [ ] **Step 1: Run the local gate**

Run, from the repository root:

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm -r --if-present test
```

Expected: each exits 0. Record the pass and fail counts. A failure in a test this plan did not touch is reported with its output, not skipped or edited.

- [ ] **Step 2: Review the whole diff**

Run: `git diff origin/main...HEAD --stat` and read `git diff origin/main...HEAD`.
Expected: only the files named in Tasks 1 to 5; no secrets, no lockfile change, no unrelated formatting.

- [ ] **Step 3: Push**

Run: `git push -u origin claude/trusting-darwin-gnyao7`
Expected: the branch updates on the fork.

- [ ] **Step 4: Dry run the workflow (needs the owner's go-ahead)**

Stop and ask the owner before this step: it spends the fork's Actions minutes. With approval, run the `Release` workflow by `workflow_dispatch` on the branch. No tag is involved, so the publish job is skipped.

Expected:
- `verify`, `Build macOS arm64`, and both `Bundle pi-host` jobs succeed.
- The "Package unsigned macOS installer" step runs and the signed steps are skipped.
- The "Verify the unsigned distribution marker" step passes: the packaged `app.asar` carries `piDistribution: "unsigned"` and the bundle seal verifies.
- Artifact `dist-mac-arm64` contains one `.dmg`, one `-mac.zip`, their blockmaps, and `latest-mac-arm64.yml`.
- The two `pi-host-linux-*` artifacts each contain a `.tar.gz` and a `.sha256`.

- [ ] **Step 5: Check the app is launchable (owner, on their Mac)**

The final review found that electron-builder skips signing when no identity is configured, so the unsigned lane now passes `-c.mac.identity=-` and the workflow's "Verify the unsigned distribution marker" step checks the marker, `codesign --verify --deep --strict`, and `Signature=adhoc` on the runner. That step passing in Step 4 replaces the manual `codesign` check this step first described.

The owner downloads `dist-mac-arm64`, installs the DMG, opens the app once (after `xattr -dr com.apple.quarantine /Applications/PI-Desktop.app` or allowing it in System Settings), and confirms that "Check for updates" in the sidebar offers the releases page and never starts an in-app download.

- [ ] **Step 6: Report**

State what changed, the files, each command run with its result, the dry-run URL, anything not run and why, and the remaining owner action: cut the first fork release with `node scripts/release.mjs <version> --tag` and push the tag.
