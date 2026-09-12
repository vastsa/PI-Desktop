import { describe, expect, it } from "vitest";
import { bindingForCustomModel } from "./model-catalog.js";
import {
  draftMatchesExisting,
  existingProviderMatchKey,
  parseCcSwitchConfigJson,
  parseCcSwitchProviders,
  parseClaudeCodeModelConfig,
  parseCodexModelConfig,
  parseJsonDocument,
  parseOpenCodeModelConfig,
  parsePiModelConfig,
  providerCreateInputFromDraft,
  publicModelConfigCandidate,
} from "./model-config-import.js";

describe("parseClaudeCodeModelConfig", () => {
  it("imports a proxy endpoint, models, and the stored API key", () => {
    const drafts = parseClaudeCodeModelConfig({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_BASE_URL: "https://anyrouter.top",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2.5-pro",
      },
      model: "claude-sonnet-4-5",
    });

    expect(drafts).toHaveLength(1);
    expect(publicModelConfigCandidate(drafts[0])).toEqual({
      source: "claude-code",
      externalId: "default",
      name: "Claude Code",
      baseUrl: "https://anyrouter.top",
      apiStyle: "anthropic_messages",
      modelIds: ["claude-sonnet-4-5", "mimo-v2.5-pro"],
      hasSecret: true,
    });
    expect(drafts[0].secretValue).toBe("sk-ant-test");
    expect(drafts[0].vendorKey).toBe("custom");
    expect(providerCreateInputFromDraft(drafts[0]).secretValue).toBe("sk-ant-test");
  });

  it("does not emit a candidate without models or a connection", () => {
    expect(parseClaudeCodeModelConfig({ permissions: { allow: [] } })).toEqual([]);
    expect(
      parseClaudeCodeModelConfig({
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      }),
    ).toEqual([]);
  });

  it("lets local settings overlay env and model", () => {
    const drafts = parseClaudeCodeModelConfig(
      {
        env: { ANTHROPIC_API_KEY: "global-key", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        model: "claude-haiku",
      },
      {
        env: { ANTHROPIC_API_KEY: "local-key" },
        model: "claude-sonnet",
      },
    );
    expect(drafts[0]?.secretValue).toBe("local-key");
    expect(drafts[0]?.modelIds).toEqual(["claude-sonnet"]);
    expect(drafts[0]?.vendorKey).toBe("anthropic");
  });
});

describe("parseOpenCodeModelConfig", () => {
  it("reads provider options, models, and an auth.json API key", () => {
    const drafts = parseOpenCodeModelConfig(
      {
        model: "ink/mimo-v2.5-pro",
        provider: {
          ink: {
            npm: "@ai-sdk/openai-compatible",
            name: "ink",
            options: {
              baseURL: "https://api.oj.ink/v1",
            },
            models: {
              "mimo-v2.5-pro": { name: "mimo-v2.5-pro" },
              "mimo-v2.5": { name: "mimo-v2.5" },
            },
          },
        },
      },
      { ink: { type: "api", key: "sk-opencode" } },
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].baseUrl).toBe("https://api.oj.ink/v1");
    expect(drafts[0].apiStyle).toBe("chat_completions");
    expect(drafts[0].modelIds).toEqual(["mimo-v2.5-pro", "mimo-v2.5"]);
    expect(drafts[0].secretValue).toBe("sk-opencode");
    expect(drafts[0].hasSecret).toBe(true);
  });

  it("does not attach a bare default model onto providers that already list models", () => {
    const drafts = parseOpenCodeModelConfig({
      model: "other-default",
      provider: {
        ink: {
          options: { baseURL: "https://api.oj.ink/v1" },
          models: { "mimo-v2.5": {} },
        },
      },
    });
    expect(drafts[0]?.modelIds).toEqual(["mimo-v2.5"]);
  });

  it("skips OAuth auth.json entries and placeholder keys", () => {
    const drafts = parseOpenCodeModelConfig(
      {
        provider: {
          anthropic: {
            npm: "@ai-sdk/anthropic",
            options: { apiKey: "YOUR_API_KEY" },
            models: { "claude-sonnet-4-5": {} },
          },
        },
      },
      { anthropic: { type: "oauth", refresh: "token" } },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].hasSecret).toBe(false);
    expect(drafts[0].secretValue).toBeUndefined();
    expect(drafts[0].apiStyle).toBe("anthropic_messages");
  });
});

describe("parseCodexModelConfig", () => {
  it("imports [model_providers] tables and resolves env_key", () => {
    const toml = `
model = "gpt-4.1"
# comment
[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[model_providers."my-gw"]
name = "Gateway"
base_url = "https://gw.example.com/v1"
api_key = "sk-gw"
wire_api = "chat"

[model_providers.chatgpt]
name = "ChatGPT"
requires_openai_auth = true
`;
    const drafts = parseCodexModelConfig(toml, { OPENAI_API_KEY: "sk-openai" });
    expect(drafts.map((d) => d.externalId).sort()).toEqual(["my-gw", "openai"]);
    const openai = drafts.find((d) => d.externalId === "openai")!;
    expect(openai.apiStyle).toBe("responses");
    expect(openai.secretValue).toBe("sk-openai");
    expect(openai.modelIds).toEqual(["gpt-4.1"]);
    const gw = drafts.find((d) => d.externalId === "my-gw")!;
    expect(gw.apiStyle).toBe("chat_completions");
    expect(gw.secretValue).toBe("sk-gw");
  });

  it("ignores ChatGPT-only configs without custom providers", () => {
    expect(
      parseCodexModelConfig(`
model = "gpt-5.6-sol"
requires_openai_auth = true
`),
    ).toEqual([]);
  });
});

describe("parsePiModelConfig", () => {
  it("reads ~/.pi/agent/models.json providers, env: keys, and limits", () => {
    const drafts = parsePiModelConfig(
      {
        providers: {
          radius: {
            baseUrl: "https://api.example.com",
            api: "anthropic-messages",
            apiKey: "env:RADIUS_KEY",
            models: [
              {
                id: "pi-model",
                reasoning: true,
                contextWindow: 200000,
                maxTokens: 16384,
                input: ["text", "image"],
              },
            ],
          },
        },
      },
      { RADIUS_KEY: "sk-pi" },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].apiStyle).toBe("anthropic_messages");
    expect(drafts[0].secretValue).toBe("sk-pi");
    expect(drafts[0].supportsReasoning).toBe(true);
    expect(drafts[0].models[0]).toMatchObject({
      id: "pi-model",
      contextWindow: 200000,
      maxTokens: 16384,
      supportsImages: true,
      defaultThinkingLevel: "medium",
    });
  });
});

describe("matching and sanitizing", () => {
  it("matches only the same endpoint, api style, and credential", () => {
    const key = existingProviderMatchKey({
      baseUrl: "https://API.example.com/v1/",
      apiStyle: "chat_completions",
    });
    expect(key).toBe("url:https://api.example.com/v1|chat_completions");
    expect(
      draftMatchesExisting(
        {
          baseUrl: "https://api.example.com/v1",
          apiStyle: "chat_completions",
          vendorKey: "custom",
          secretValue: "same-key",
          hasSecret: true,
        },
        [
          {
            baseUrl: "https://API.example.com/v1/",
            apiStyle: "chat_completions",
            vendorKey: "other",
            secretValue: "same-key",
            hasSecret: true,
          },
        ],
      ),
    ).toBe(true);
    expect(
      draftMatchesExisting(
        {
          baseUrl: "https://api.example.com/v1",
          apiStyle: "chat_completions",
          vendorKey: "custom",
          secretValue: "different-key",
          hasSecret: true,
        },
        [
          {
            baseUrl: "https://api.example.com/v1",
            apiStyle: "chat_completions",
            secretValue: "same-key",
            hasSecret: true,
          },
        ],
      ),
    ).toBe(false);
    expect(
      draftMatchesExisting(
        {
          baseUrl: "https://api.example.com/v1",
          apiStyle: "chat_completions",
          vendorKey: "custom",
          secretValue: "same-key",
          hasSecret: true,
        },
        [
          {
            baseUrl: "https://api.example.com/v1",
            apiStyle: "chat_completions",
            hasSecret: false,
          },
        ],
      ),
    ).toBe(false);
    expect(
      draftMatchesExisting(
        {
          baseUrl: "https://api.example.com/v1",
          apiStyle: "chat_completions",
          vendorKey: "custom",
          hasSecret: false,
        },
        [
          {
            baseUrl: "https://api.example.com/v1",
            apiStyle: "chat_completions",
            hasSecret: false,
          },
        ],
      ),
    ).toBe(true);
  });

  it("drops placeholder secrets", () => {
    const drafts = (key: string) =>
      parseClaudeCodeModelConfig({
        env: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://anyrouter.top" },
        model: "claude-sonnet-4-5",
      });
    expect(publicModelConfigCandidate(drafts("YOUR_API_KEY")[0]).hasSecret).toBe(false);
    expect(publicModelConfigCandidate(drafts("${OPENAI_API_KEY}")[0]).hasSecret).toBe(false);
    expect(publicModelConfigCandidate(drafts("sk-live-real")[0]).hasSecret).toBe(true);
  });

  it("never copies a secret onto the public candidate", () => {
    const [draft] = parseClaudeCodeModelConfig({
      env: { ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      model: "claude-sonnet",
    });
    expect(JSON.stringify(publicModelConfigCandidate(draft))).not.toContain("sk-secret");
    expect(draft.models[0]).toEqual(bindingForCustomModel("claude-sonnet"));
  });
});

describe("parseCcSwitchProviders", () => {
  it("reads Claude, OpenCode, and Gemini rows and skips empty official seeds", () => {
    const drafts = parseCcSwitchProviders([
      {
        id: "claude-official",
        appType: "claude",
        name: "Claude Official",
        settingsConfig: { env: {} },
      },
      {
        id: "packy",
        appType: "claude",
        name: "Packy",
        settingsConfig: {
          env: {
            ANTHROPIC_API_KEY: "sk-cc",
            ANTHROPIC_BASE_URL: "https://cc.example/v1",
            ANTHROPIC_MODEL: "claude-sonnet",
          },
        },
      },
      {
        id: "ink",
        appType: "opencode",
        name: "ink",
        settingsConfig: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://api.oj.ink/v1", apiKey: "{env:INK_KEY}" },
          models: { "mimo-v2.5": { name: "mimo-v2.5" } },
        },
      },
      {
        id: "gemini-gw",
        appType: "gemini",
        name: "Gemini GW",
        settingsConfig: {
          env: {
            GEMINI_API_KEY: "sk-gem",
            GOOGLE_GEMINI_BASE_URL: "https://gem.example/v1",
          },
          config: { model: "gemini-2.5-pro" },
        },
      },
    ], { INK_KEY: "sk-ink" });

    expect(drafts.map((d) => d.externalId).sort()).toEqual(
      ["claude:packy", "gemini:gemini-gw", "opencode:ink"].sort(),
    );
    expect(drafts.find((d) => d.externalId === "claude:packy")).toMatchObject({
      source: "cc-switch",
      name: "Packy",
      baseUrl: "https://cc.example/v1",
      apiStyle: "anthropic_messages",
      secretValue: "sk-cc",
    });
    expect(drafts.find((d) => d.externalId === "opencode:ink")?.secretValue).toBe("sk-ink");
    expect(drafts.find((d) => d.externalId === "gemini:gemini-gw")?.modelIds).toEqual([
      "gemini-2.5-pro",
    ]);
  });

  it("parses the legacy MultiAppConfig JSON", () => {
    const rows = parseCcSwitchConfigJson({
      version: 2,
      claude: {
        providers: {
          a: {
            name: "Relay",
            settingsConfig: {
              env: { ANTHROPIC_API_KEY: "sk", ANTHROPIC_BASE_URL: "https://r.example" },
              model: "claude-sonnet",
            },
          },
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(parseCcSwitchProviders(rows)[0]?.source).toBe("cc-switch");
  });
});

describe("parseJsonDocument / parseTomlSubset", () => {
  it("accepts JSONC", () => {
    expect(parseJsonDocument('{ // c\n "a": 1, /* x */ "b": 2 }')).toEqual({ a: 1, b: 2 });
  });

  it("accepts trailing commas before } and ] the way JSONC editors leave them", () => {
    expect(
      parseJsonDocument('{\n  "a": [1, 2,],\n  "b": { "c": 1, }, // note\n}\n'),
    ).toEqual({ a: [1, 2], b: { c: 1 } });
    expect(parseJsonDocument('{ "s": "keep ,] and ,} inside", }')).toEqual({
      s: "keep ,] and ,} inside",
    });
    expect(parseJsonDocument('{ "a": 1,, }')).toBeNull();
  });

  it("keeps quoted table keys", () => {
    const drafts = parseCodexModelConfig(
      `[model_providers."my.gw"]\nname = "GW"\nbase_url = "https://gw.example.com/v1"\nmodels = "m1"\n`,
    );
    expect(drafts.map((d) => [d.externalId, d.name])).toEqual([["my.gw", "GW"]]);
  });
});
