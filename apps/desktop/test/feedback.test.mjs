import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  bugTemplate,
  featureTemplate,
  configTemplate,
  protocolSource,
  mainSource,
  apiSource,
  settingsSource,
  settingsSearchSource,
  enSource,
  zhSource,
] = await Promise.all([
  read("../../../.github/ISSUE_TEMPLATE/bug_report.yml"),
  read("../../../.github/ISSUE_TEMPLATE/feature_request.yml"),
  read("../../../.github/ISSUE_TEMPLATE/config.yml"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../electron/main/index.ts"),
  read("../src/lib/api.ts"),
  read("../src/pages/SettingsPage.tsx"),
  read("../src/lib/settings-search.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

function requiredField(source, id) {
  const start = source.indexOf(`id: ${id}`);
  assert.ok(start >= 0, `missing field ${id}`);
  const next = source.indexOf("\n  - type:", start);
  const block = source.slice(start, next === -1 ? undefined : next);
  assert.match(block, /required:\s*true/, `${id} must be required`);
}

test("blank GitHub issues stay disabled", () => {
  assert.match(configTemplate, /blank_issues_enabled:\s*false/);
});

test("bug report form requires triage fields", () => {
  for (const id of [
    "description",
    "reproduce",
    "expected",
    "actual",
    "app-version",
    "os",
  ]) {
    requiredField(bugTemplate, id);
  }
  assert.match(bugTemplate, /id: environment/);
  assert.match(bugTemplate, /id: logs/);
  assert.match(bugTemplate, /labels:\s*\[["']bug["']\]/);
});

test("feature request form requires a problem and a proposal", () => {
  requiredField(featureTemplate, "problem");
  requiredField(featureTemplate, "proposal");
  assert.match(featureTemplate, /labels:\s*\[["']enhancement["']\]/);
});

test("Settings Info exposes a Main-owned GitHub feedback action", () => {
  assert.match(protocolSource, /appOpenFeedback:\s*"pi-desktop\/app\/openFeedback"/);
  assert.match(mainSource, /IPC\.invoke\.appOpenFeedback/);
  assert.match(mainSource, /buildBugReportUrl\(/);
  assert.match(mainSource, /assertFeedbackIssueUrl\(/);
  assert.match(mainSource, /shell\.openExternal\(url\)/);
  assert.match(apiSource, /openFeedback:\s*\(\)\s*=>\s*invoke\(IPC\.invoke\.appOpenFeedback\)/);
  assert.match(settingsSource, /t\("settings\.feedback"\)/);
  assert.match(settingsSource, /api\.openFeedback\(\)/);
  assert.match(settingsSearchSource, /"settings\.feedback"/);
  for (const source of [enSource, zhSource]) {
    assert.match(source, /feedback:/);
    assert.match(source, /feedbackDesc:/);
    assert.match(source, /openFeedback:/);
  }
});
