/**
 * Behavior of platform service search: the platform preset is listed once, and a query matches the localized label, canonical
 * name, id, vendor key, aliases, base URL or host — never an IPC round trip.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AI_PLATFORM_BASE_URL, AI_PLATFORM_NAME, AI_PLATFORM_VENDOR_KEY, NAMED_ENDPOINT_PRESETS } from "@pi-desktop/shared";
import {
  CUSTOM_SERVICE,
  customServiceOption,
  filterServiceOptions,
  hostOf,
  namedServiceOptions,
} from "../src/components/settings/service-catalog.ts";

// Stands in for i18next with two localized labels, so a label-only match is
// distinguishable from a match on the canonical English name.
const labels = {
  "settings.presetAiPlatform": "AI聚合平台",
  "settings.presetCustomEndpoint": "自定义端点",
};
const translate = (key) => labels[key] ?? key;
const options = namedServiceOptions(translate);
const ids = (query) => filterServiceOptions(options, query).map((option) => option.id);

test("only the platform preset is offered once, while upstream presets remain preserved", () => {
  assert.deepEqual(options.map((option) => option.id), [AI_PLATFORM_VENDOR_KEY]);
  assert.equal(options[0].host, "ai.yykkj.com");
  assert.equal(options[0].label, "AI聚合平台");
  assert.ok(NAMED_ENDPOINT_PRESETS.some((preset) => preset.id === "openai"));
  assert.deepEqual(ids("openai"), []);
});

test("an empty or blank query keeps every option", () => {
  assert.deepEqual(ids(""), options.map((option) => option.id));
  assert.deepEqual(ids("   "), options.map((option) => option.id));
});

test("a query matches the localized platform label and canonical name case-insensitively", () => {
  assert.deepEqual(ids("AI聚合"), [AI_PLATFORM_VENDOR_KEY]);
  assert.deepEqual(ids(AI_PLATFORM_NAME.toUpperCase()), [AI_PLATFORM_VENDOR_KEY]);
  assert.deepEqual(ids("  Aggregation  "), [AI_PLATFORM_VENDOR_KEY]);
  assert.deepEqual(ids("月之暗面"), []);
});

test("a query matches the platform vendor key, endpoint URL and host", () => {
  for (const query of [AI_PLATFORM_VENDOR_KEY, AI_PLATFORM_BASE_URL, "AI.YYKKJ.COM"]) {
    assert.deepEqual(ids(query), [AI_PLATFORM_VENDOR_KEY]);
  }
  assert.deepEqual(ids("opencode-go"), []);
  assert.deepEqual(ids("api.moonshot.cn"), []);
});

test("the retained custom-endpoint helper stays searchable without joining the offered options", () => {
  const custom = customServiceOption(translate);
  assert.equal(custom.id, CUSTOM_SERVICE);
  assert.equal(custom.host, "");
  assert.deepEqual(filterServiceOptions([custom], "自定义"), [custom]);
  assert.deepEqual(filterServiceOptions([custom], "custom endpoint"), [custom]);
  assert.deepEqual(ids("自定义"), []);
  assert.deepEqual(ids("custom endpoint"), []);
});

test("an unmatched query yields no options", () => {
  assert.deepEqual(ids("no-such-service-anywhere"), []);
});

test("hostOf keeps unparseable input as-is", () => {
  assert.equal(hostOf("https://api.openai.com/v1"), "api.openai.com");
  assert.equal(hostOf("not a url"), "not a url");
});
