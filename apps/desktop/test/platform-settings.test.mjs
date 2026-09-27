import assert from "node:assert/strict";
import test from "node:test";
import { AI_PLATFORM_BASE_URL, AI_PLATFORM_VENDOR_KEY } from "@pi-desktop/shared";
import { catalogs } from "@pi-desktop/i18n";
import {
  filterServiceOptions, isPlatformApiStyle, isPlatformProvider, namedServiceOptions,
} from "../src/components/settings/service-catalog.ts";

const provider = {
  vendorKey: AI_PLATFORM_VENDOR_KEY, baseUrl: AI_PLATFORM_BASE_URL,
  authKind: "api_key_and_base_url", apiStyle: "chat_completions",
};

test("only the platform preset is offered and searchable in every shipped language", () => {
  for (const catalog of Object.values(catalogs)) {
    const options = namedServiceOptions((key) => catalog.settings[key.split(".")[1]]);
    assert.deepEqual(options.map(({ id }) => id), [AI_PLATFORM_VENDOR_KEY]);
    assert.equal(options[0].label, catalog.settings.presetAiPlatform);
    assert.deepEqual(filterServiceOptions(options, "AI.YYKKJ.COM"), options);
    assert.deepEqual(filterServiceOptions(options, "custom"), []);
    assert.deepEqual(filterServiceOptions(options, "codex"), []);
  }
});

test("platform settings exclude other origins, subscription credentials, and plugin rows", () => {
  assert.equal(isPlatformProvider(provider), true);
  assert.equal(isPlatformProvider({ ...provider, apiStyle: undefined }), true);
  for (const patch of [
    { vendorKey: "openai" }, { baseUrl: "https://other.invalid/v1" },
    { authKind: "oauth" }, { hasOauth: true }, { ownerPluginId: "plugin" },
    { apiStyle: "openai_codex_responses" }, { headers: { Authorization: "fixture" } },
  ]) assert.equal(isPlatformProvider({ ...provider, ...patch }), false);
  for (const style of ["chat_completions", "responses", "anthropic_messages"]) {
    assert.equal(isPlatformApiStyle(style), true);
  }
  for (const style of ["auto", "google_generative_ai", "pi_messages", "opencode_go", undefined]) {
    assert.equal(isPlatformApiStyle(style), false);
  }
});

test("platform copy is translated with identical interpolation contracts", () => {
  const keys = Object.keys(catalogs.en.settings).filter((key) => key.startsWith("platform") || key === "presetAiPlatform");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      const text = catalog.settings[key];
      assert.equal(typeof text, "string", `${locale}.${key}`);
      assert.ok(text.length > 0);
      assert.deepEqual(text.match(/{{\w+}}/g), catalogs.en.settings[key].match(/{{\w+}}/g));
      if (locale !== "en" && key !== "presetAiPlatform") assert.notEqual(text, catalogs.en.settings[key]);
    }
  }
  assert.match(catalogs["zh-CN"].settings.platformTokenNotWallet, /并非账户钱包余额/);
  assert.match(catalogs["zh-TW"].settings.platformTokenNotWallet, /並非帳戶錢包餘額/);
});
