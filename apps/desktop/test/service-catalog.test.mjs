/**
 * Behavior of the service search the add dialog offers (D311): every named
 * preset is listed once, and a query matches the localized label, canonical
 * name, id, vendor key, aliases, base URL or host — never an IPC round trip.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NAMED_ENDPOINT_PRESETS } from "@pi-desktop/shared";
import {
  CUSTOM_SERVICE,
  customServiceOption,
  filterServiceOptions,
  endpointLabel,
  namedServiceOptions,
} from "../src/components/settings/service-catalog.ts";

// Stands in for i18next with localized labels, so a label-only match is
// distinguishable from a match on the canonical English name.
const labels = {
  "settings.presetMoonshotCn": "月之暗面",
  "settings.presetStepfunPlan": "阶跃星辰 Plan（订阅）",
  "settings.presetCustomEndpoint": "自定义端点",
};
const translate = (key) => labels[key] ?? key;
const options = [customServiceOption(translate), ...namedServiceOptions(translate)];
const ids = (query) => filterServiceOptions(options, query).map((option) => option.id);

test("every named preset is offered once, in the shared table's order", () => {
  assert.deepEqual(
    namedServiceOptions(translate).map((option) => option.id),
    NAMED_ENDPOINT_PRESETS.map((preset) => preset.id),
  );
  const openai = namedServiceOptions(translate).find((option) => option.id === "openai");
  assert.equal(openai?.endpoint, "api.openai.com/v1");
});

test("StepFun Plan is offered once and searchable by its label, vendor and endpoint", () => {
  const rows = namedServiceOptions(translate).filter((option) => option.id === "stepfun-plan");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, labels["settings.presetStepfunPlan"]);
  assert.equal(rows[0].endpoint, "api.stepfun.com/step_plan/v1");
  for (const query of ["阶跃星辰", "StepFun Plan", "stepfun-step-plan", "api.stepfun.com/step_plan/v1"]) {
    assert.ok(ids(query).includes("stepfun-plan"), query);
  }
});

test("an empty or blank query keeps every option", () => {
  assert.deepEqual(ids(""), options.map((option) => option.id));
  assert.deepEqual(ids("   "), options.map((option) => option.id));
});

test("a query matches the localized label, canonical name and aliases", () => {
  assert.deepEqual(ids("月之暗面"), ["moonshotai-cn"]);
  assert.ok(ids("Moonshot").includes("moonshotai-cn"));
  assert.ok(ids("gemini").includes("google"));
  assert.ok(ids("dashscope").includes("alibaba-cn"));
  assert.ok(ids("KIMI").includes("kimi-for-coding"));
});

test("a query matches the vendor key and the endpoint host", () => {
  // `opencode-go` appears only as the vendor key; the id uses an underscore.
  assert.deepEqual(ids("opencode-go"), ["opencode_go"]);
  assert.deepEqual(ids("api.moonshot.cn"), ["moonshotai-cn"]);
  assert.deepEqual(ids("open.bigmodel.cn"), ["zhipuai", "zhipuai-coding-plan"]);
});

test("the custom endpoint is searchable by its label and by 'custom'", () => {
  const custom = customServiceOption(translate);
  assert.equal(custom.id, CUSTOM_SERVICE);
  assert.equal(custom.endpoint, "");
  assert.deepEqual(ids("自定义"), [CUSTOM_SERVICE]);
  assert.deepEqual(ids("custom endpoint"), [CUSTOM_SERVICE]);
});

test("an unmatched query yields no options", () => {
  assert.deepEqual(ids("no-such-service-anywhere"), []);
});

test("endpointLabel keeps unparseable input as-is", () => {
  assert.equal(endpointLabel("https://api.openai.com/v1"), "api.openai.com/v1");
  assert.equal(endpointLabel("not a url"), "not a url");
});


test("endpoint labels retain routes and ports without showing credentials or query fields", () => {
  assert.equal(endpointLabel("https://user:password@api.example:8443/plan/v1?key=private#fragment"),
    "api.example:8443/plan/v1");
  assert.equal(endpointLabel("https://api.example/"), "api.example");
});
