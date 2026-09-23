import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVendorModelIds,
  pinnedSiblingId,
  vendorModelListRequest,
  wireForLiveModel,
} from "../electron/main/vendor-live-models.ts";

function codexToken() {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
  })).toString("base64url");
  return `header.${payload}.sig`;
}

test("ChatGPT accounts list models from the Codex endpoint, not /models", () => {
  const request = vendorModelListRequest({
    vendorId: "openai-codex",
    apiKey: codexToken(),
  });
  assert.equal(request?.url, "https://chatgpt.com/backend-api/codex/models");
  assert.equal(request?.headers["chatgpt-account-id"], "acct_123");
  assert.equal(parseVendorModelIds("openai-codex", {
    models: [
      { slug: "gpt-6-luna", visibility: "list" },
      { slug: "gpt-6-hidden", visibility: "hide" },
    ],
  })?.join(","), "gpt-6-luna");
  assert.equal(parseVendorModelIds("openai-codex", {
    data: [{ id: "gpt-4o" }],
  }), null);
  assert.equal(vendorModelListRequest({
    vendorId: "openai-codex",
    apiKey: "not-a-jwt",
  }), undefined);
});

test("Copilot keeps picker flags and the API version header", () => {
  const request = vendorModelListRequest({
    vendorId: "github-copilot",
    apiKey: "copilot-token",
  });
  assert.equal(request?.url, "https://api.individual.githubcopilot.com/models");
  assert.equal(request?.headers["X-GitHub-Api-Version"], "2026-06-01");
  assert.deepEqual(parseVendorModelIds("github-copilot", {
    data: [
      { id: "gpt-6-luna", model_picker_enabled: true, policy: { state: "enabled" } },
      { id: "gpt-5.4", policy: { state: "enabled" } },
      {
        id: "gpt-image",
        model_picker_enabled: true,
        capabilities: { supports: { tool_calls: false } },
      },
    ],
  }, true), ["gpt-6-luna"]);
});

test("Anthropic OAuth sends the Claude Code identity headers", () => {
  const request = vendorModelListRequest({
    vendorId: "anthropic",
    apiKey: "sk-ant-oat01-test",
  });
  assert.equal(request?.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(request?.headers["x-app"], "cli");
  assert.equal(request?.headers.Authorization, "Bearer sk-ant-oat01-test");
  assert.match(request?.headers["anthropic-beta"] ?? "", /oauth-2025-04-20/);
});

test("a new Grok inherits the newest explicit sibling, not pin order", () => {
  assert.equal(
    pinnedSiblingId("xai", "grok-4.7", ["grok-4.3", "grok-4.5", "grok-4.6"]),
    "grok-4.6",
  );
  assert.equal(
    pinnedSiblingId("xai", "grok-4.8", ["grok-4.3", "grok-4.7", "grok-4.6"]),
    "grok-4.7",
  );
});

test("an unknown Claude does not inherit a different tier", () => {
  assert.equal(
    pinnedSiblingId("anthropic", "claude-3-5-sonnet-20241022", ["claude-fable-5", "claude-sonnet-4-6"]),
    "claude-sonnet-4-6",
  );
  assert.equal(
    pinnedSiblingId("anthropic", "claude-3-5-sonnet-20241022", ["claude-fable-5"]),
    undefined,
  );
});

test("Copilot only keeps a new id when its family has one wire API", () => {
  const pinned = [
    { id: "gpt-5.4", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com" },
    { id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: "https://api.individual.githubcopilot.com" },
  ];
  assert.equal(
    wireForLiveModel("github-copilot", "gpt-6-luna", pinned, pinned[0].baseUrl)?.api,
    "openai-responses",
  );
  assert.equal(
    wireForLiveModel("github-copilot", "mystery-1", pinned, pinned[0].baseUrl),
    undefined,
  );
  assert.equal(
    wireForLiveModel("openai-codex", "gpt-6-luna", pinned, "https://chatgpt.com/backend-api")?.api,
    "openai-codex-responses",
  );
});
