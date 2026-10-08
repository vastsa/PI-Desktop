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
  pluginProviderServiceOptions,
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

test("plugin provider categories show only unconfigured API-key rows and search introductions", () => {
  const provider = (id, ownerPluginId, hasSecret) => ({
    id,
    name: id.endsWith("hcnsec") ? "幻城网安公益 API" : "ChatAnywhere Free API",
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    enabled: true,
    baseUrl: id.endsWith("hcnsec")
      ? "https://api.ifivem.com/v1"
      : "https://api.chatanywhere.tech/v1",
    authKind: "api_key",
    hasSecret,
    models: [{ id: "deepseek-chat" }],
    supportsReasoning: false,
    supportedThinkingLevels: [],
    ownerPluginId,
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  });
  const providers = [
    provider("plugin:community.ai-sites:hcnsec", "community.ai-sites", false),
    provider("plugin:community.ai-sites:chatanywhere", "community.ai-sites", true),
    { ...provider("plugin:community.ai-sites:disabled", "community.ai-sites", false), enabled: false },
    provider("plugin:other:wrong-owner", "other", false),
    { ...provider("plugin:community.ai-sites:oauth", "community.ai-sites", false), authKind: "oauth" },
    { ...provider("plugin:community.ai-sites:no-endpoint", "community.ai-sites", false), baseUrl: undefined },
  ];
  const declarations = [
    {
      pluginId: "community.ai-sites",
      providerId: "plugin:community.ai-sites:hcnsec",
      pluginName: "PI Community AI Sites",
      category: "公益站",
      description: "签到获得额度的公益 API 服务。",
    },
    {
      pluginId: "community.ai-sites",
      providerId: "plugin:community.ai-sites:chatanywhere",
      pluginName: "PI Community AI Sites",
      category: "公益站",
      description: "签到获得额度的公益 API 服务。",
    },
    {
      pluginId: "community.ai-sites",
      providerId: "plugin:community.ai-sites:disabled",
      pluginName: "PI Community AI Sites",
      category: "公益站",
      description: "已停用的站点。",
    },
    {
      pluginId: "community.ai-sites",
      providerId: "plugin:other:wrong-owner",
      pluginName: "PI Community AI Sites",
      category: "公益站",
      description: "其他站点。",
    },
    {
      pluginId: "community.ai-sites",
      providerId: "plugin:community.ai-sites:oauth",
      pluginName: "PI Community AI Sites",
      category: "公益站",
      description: "OAuth 站点。",
    },
    {
      pluginId: "community.ai-sites",
      providerId: "plugin:community.ai-sites:no-endpoint",
      pluginName: "PI Community AI Sites",
      category: "公益站",
      description: "缺少地址。",
    },
  ];

  const options = pluginProviderServiceOptions(declarations, providers);
  assert.equal(options.length, 1);
  assert.equal(options[0].category, "公益站");
  assert.equal(options[0].endpoint, "api.ifivem.com/v1 · PI Community AI Sites");
  assert.equal(options[0].description, "签到获得额度的公益 API 服务。");
  assert.deepEqual(filterServiceOptions(options, "deepseek-chat").map((option) => option.id), [
    "plugin:community.ai-sites:hcnsec",
  ]);
  assert.deepEqual(filterServiceOptions(options, "公益站").map((option) => option.id), [
    "plugin:community.ai-sites:hcnsec",
  ]);
  assert.deepEqual(filterServiceOptions(options, "签到获得额度").map((option) => option.id), [
    "plugin:community.ai-sites:hcnsec",
  ]);
});
