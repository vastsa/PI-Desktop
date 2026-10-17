import { describe, expect, it, vi } from "vitest";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import {
  providerUsesSessionAffinity,
  sessionAffinityCompat,
  withSessionAffinityOptions,
  withSessionPromptCacheKey,
  type SessionAffinityProvider,
} from "./session-affinity.js";

/** A row the user pointed at a self-hosted OpenAI-compatible gateway. */
const ownGateway: SessionAffinityProvider = {
  apiStyle: "chat_completions",
  vendorKey: "custom",
};
/** A row the user pointed at a self-hosted Anthropic-compatible relay. */
const ownAnthropicRelay: SessionAffinityProvider = {
  apiStyle: "anthropic_messages",
  vendorKey: "custom",
};
/** A row on OpenCode Go's own apiStyle. */
const openCodeGoRow: SessionAffinityProvider = {
  apiStyle: "opencode_go",
  vendorKey: "opencode-go",
};

const GATEWAY = "https://gateway.example.com/v1";
const ANTHROPIC_RELAY = "https://relay.example.com";
const LOCAL = "http://127.0.0.1:11434/v1";

const completionsModel = {
  id: "gateway-model-1",
  name: "Gateway Model 1",
  api: "openai-completions",
  provider: "gateway-uuid",
  baseUrl: GATEWAY,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<"openai-completions">;

describe("providerUsesSessionAffinity", () => {
  it("stamps the user's own Completions and Anthropic endpoints", () => {
    expect(providerUsesSessionAffinity(ownGateway, "openai-completions", GATEWAY)).toBe(
      true,
    );
    expect(
      providerUsesSessionAffinity(ownAnthropicRelay, "anthropic-messages", ANTHROPIC_RELAY),
    ).toBe(true);
    expect(providerUsesSessionAffinity(ownGateway, "openai-completions", LOCAL)).toBe(
      true,
    );
  });

  it("stamps custom Responses endpoints with a proxy-safe affinity header", () => {
    expect(providerUsesSessionAffinity(ownGateway, "openai-responses", GATEWAY)).toBe(
      true,
    );
    expect(
      providerUsesSessionAffinity(ownGateway, "openai-responses", "https://api.openai.com/v1"),
    ).toBe(false);
  });

  it("leaves every other wire API on the adapter's own behavior", () => {
    for (const api of [
      "openai-codex-responses",
      "google-generative-ai",
      "google-vertex",
      "pi-messages",
      "",
    ]) {
      expect(providerUsesSessionAffinity(ownGateway, api, GATEWAY)).toBe(false);
    }
  });

  it("stays off the OpenCode path, which carries its own session header", () => {
    expect(providerUsesSessionAffinity(openCodeGoRow, "openai-completions", GATEWAY)).toBe(
      false,
    );
    // Each case below isolates one guard: the host is neither OpenCode's nor a
    // published vendor host, so only the named guard can be the one answering.
    for (const vendorKey of ["opencode", "opencode-go"]) {
      expect(
        providerUsesSessionAffinity(
          { apiStyle: "chat_completions", vendorKey },
          "openai-completions",
          GATEWAY,
        ),
      ).toBe(false);
    }
    expect(
      providerUsesSessionAffinity(
        { apiStyle: "chat_completions", vendorKey: "custom" },
        "openai-completions",
        // An opencode.ai host the preset table does not list.
        "https://sub.opencode.ai/v1",
      ),
    ).toBe(false);
    expect(
      providerUsesSessionAffinity(
        { apiStyle: "chat_completions", vendorKey: "custom" },
        "openai-completions",
        "https://opencode.ai/zen/v1",
      ),
    ).toBe(false);
  });

  it("keeps a published vendor host on its current request bytes", () => {
    expect(
      providerUsesSessionAffinity(ownGateway, "openai-completions", "https://api.openai.com/v1"),
    ).toBe(false);
    expect(
      providerUsesSessionAffinity(
        ownAnthropicRelay,
        "anthropic-messages",
        "https://api.anthropic.com",
      ),
    ).toBe(false);
    // The preset record spells `https://api.deepseek.com` with no path.
    expect(
      providerUsesSessionAffinity(ownGateway, "openai-completions", "https://api.deepseek.com/v1"),
    ).toBe(false);
  });

  it("treats a host that merely contains a vendor host as the user's own", () => {
    expect(
      providerUsesSessionAffinity(
        ownGateway,
        "openai-completions",
        "https://api.openai.com.evil.test/v1",
      ),
    ).toBe(true);
  });

  it("stamps a row whose base URL has no host at all", () => {
    expect(providerUsesSessionAffinity(ownGateway, "openai-completions", undefined)).toBe(
      true,
    );
    expect(providerUsesSessionAffinity(ownGateway, "openai-completions", "not a url")).toBe(
      true,
    );
  });
});

describe("sessionAffinityCompat", () => {
  it("returns the adapter's own non-OpenRouter shape for the user's endpoint", () => {
    expect(sessionAffinityCompat(ownGateway, "openai-completions", GATEWAY)).toEqual({
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openai",
    });
    expect(
      sessionAffinityCompat(ownAnthropicRelay, "anthropic-messages", ANTHROPIC_RELAY),
    ).toEqual({ sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" });
  });

  it("is undefined whenever the row is not stamped", () => {
    expect(
      sessionAffinityCompat(ownGateway, "openai-completions", "https://api.openai.com/v1"),
    ).toBeUndefined();
    expect(sessionAffinityCompat(ownGateway, "openai-responses", GATEWAY)).toBeUndefined();
    expect(
      sessionAffinityCompat(openCodeGoRow, "openai-completions", GATEWAY),
    ).toBeUndefined();
  });
});

describe("withSessionPromptCacheKey", () => {
  const input = (overrides: Partial<Parameters<typeof withSessionPromptCacheKey>[0]> = {}) => ({
    payload: { model: "gateway-model-1", messages: [] },
    api: "openai-completions",
    sessionId: "session-7",
    enabled: true,
    ...overrides,
  });

  it("adds the session id to a Completions payload on a copy", () => {
    const payload = { model: "gateway-model-1", messages: [] };
    const result = withSessionPromptCacheKey(input({ payload }));
    expect(result).toEqual({
      model: "gateway-model-1",
      messages: [],
      prompt_cache_key: "session-7",
    });
    expect(result).not.toBe(payload);
    expect(payload).toEqual({ model: "gateway-model-1", messages: [] });
  });

  it("leaves every other wire API's payload untouched", () => {
    const payload = { model: "gateway-model-1", messages: [] };
    expect(
      withSessionPromptCacheKey(input({ payload, api: "anthropic-messages" })),
    ).toBe(payload);
    expect(withSessionPromptCacheKey(input({ payload, api: "openai-responses" }))).toBe(
      payload,
    );
  });

  it("adds nothing when the endpoint is not stamped", () => {
    const payload = { model: "gateway-model-1", messages: [] };
    expect(withSessionPromptCacheKey(input({ payload, enabled: false }))).toBe(payload);
  });

  it("never overwrites a key the adapter or a caller already set", () => {
    const payload = {
      model: "gateway-model-1",
      messages: [],
      prompt_cache_key: "caller-set",
    };
    const result = withSessionPromptCacheKey(input({ payload }));
    expect(result).toBe(payload);
    expect(payload.prompt_cache_key).toBe("caller-set");
  });

  it("fills a key that is explicitly null", () => {
    expect(
      withSessionPromptCacheKey(
        input({ payload: { model: "gateway-model-1", prompt_cache_key: null } }),
      ),
    ).toEqual({ model: "gateway-model-1", prompt_cache_key: "session-7" });
  });

  it("preserves a non-null empty-string key", () => {
    const payload = { model: "gateway-model-1", prompt_cache_key: "" };
    expect(withSessionPromptCacheKey(input({ payload }))).toBe(payload);
  });

  it("leaves a payload the adapter did not hand over as a plain object", () => {
    for (const payload of [undefined, null, "body", 42, [], true]) {
      expect(withSessionPromptCacheKey(input({ payload }))).toBe(payload);
    }
  });

  it("adds no key without a usable session id", () => {
    const payload = { model: "gateway-model-1", messages: [] };
    expect(withSessionPromptCacheKey(input({ payload, sessionId: undefined }))).toBe(
      payload,
    );
    expect(withSessionPromptCacheKey(input({ payload, sessionId: "" }))).toBe(payload);
    expect(withSessionPromptCacheKey(input({ payload, sessionId: "   " }))).toBe(payload);
    expect(withSessionPromptCacheKey(input({ payload, sessionId: "\n\t" }))).toBe(payload);
  });

  it("trims the session id it does write", () => {
    expect(
      withSessionPromptCacheKey(
        input({ payload: { model: "m" }, sessionId: "  session-7  " }),
      ),
    ).toEqual({ model: "m", prompt_cache_key: "session-7" });
  });

  // Oracle: derived. 64 is the adapter's own OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
  // (pi-ai dist/api/openai-prompt-cache.js), and the limit counts code points.
  it("clamps the key to the adapter's 64-character limit", () => {
    const longAscii = "s".repeat(80);
    expect(
      withSessionPromptCacheKey(input({ payload: { model: "m" }, sessionId: longAscii })),
    ).toEqual({ model: "m", prompt_cache_key: "s".repeat(64) });

    const longAstral = Array.from({ length: 70 }, () => "🙂").join("");
    expect(
      withSessionPromptCacheKey(input({ payload: { model: "m" }, sessionId: longAstral })),
    ).toEqual({
      model: "m",
      prompt_cache_key: Array.from({ length: 64 }, () => "🙂").join(""),
    });
  });

  it("keeps a key at the limit whole", () => {
    const exact = "k".repeat(64);
    expect(
      withSessionPromptCacheKey(input({ payload: { model: "m" }, sessionId: exact })),
    ).toEqual({ model: "m", prompt_cache_key: exact });
  });
});

describe("withSessionAffinityOptions", () => {
  const input = (
    overrides: Partial<{
      provider: SessionAffinityProvider;
      api: string;
      baseUrl: string | undefined;
      sessionId: string | undefined;
    }> = {},
  ) => ({
    provider: ownGateway,
    api: "openai-completions",
    baseUrl: GATEWAY,
    sessionId: "session-7",
    ...overrides,
  });

  it("returns the caller's own options object for a row it does not stamp", () => {
    const options: SimpleStreamOptions = { temperature: 0 };
    expect(
      withSessionAffinityOptions(options, {
        provider: ownGateway,
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        sessionId: "session-7",
      }),
    ).toBe(options);
    expect(
      withSessionAffinityOptions(
        options,
        input({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
      ),
    ).toBe(options);
    expect(
      withSessionAffinityOptions(options, input({ provider: openCodeGoRow })),
    ).toBe(options);
  });

  it("keeps the caller's other options while adding its own hook", () => {
    const options: SimpleStreamOptions = { temperature: 0, sessionId: "session-7" };
    const result = withSessionAffinityOptions(options, input());
    expect(result).not.toBe(options);
    expect(result.temperature).toBe(0);
    expect(result.sessionId).toBe("session-7");
    expect(result.onPayload).toEqual(expect.any(Function));
  });

  it("adds a stable hyphenated affinity header to custom Responses options", () => {
    const options: SimpleStreamOptions = {
      temperature: 0,
      sessionId: "session-7",
      headers: { "X-Gateway": "keep" },
    };
    const result = withSessionAffinityOptions(
      options,
      input({ api: "openai-responses" }),
    );

    expect(result).not.toBe(options);
    expect(result.headers).toEqual({
      "X-Gateway": "keep",
      "x-session-affinity": "session-7",
    });
    expect(result.temperature).toBe(0);
  });

  it("does not add a Responses affinity header when the caller has no session id", () => {
    const options: SimpleStreamOptions = { temperature: 0 };
    expect(
      withSessionAffinityOptions(
        options,
        input({ api: "openai-responses", sessionId: undefined }),
      ),
    ).toBe(options);
  });

  it("keys the adapter payload and still runs the caller's payload hook first", async () => {
    const previous = vi.fn(async (payload: unknown) => payload);
    const options: SimpleStreamOptions = { onPayload: previous };
    const adapterPayload = { model: "gateway-model-1", stream: true };
    const result = withSessionAffinityOptions(options, input());

    const payload = await result.onPayload?.(adapterPayload, completionsModel);

    expect(previous).toHaveBeenCalledWith(adapterPayload, completionsModel);
    expect(payload).toEqual({
      model: "gateway-model-1",
      stream: true,
      prompt_cache_key: "session-7",
    });
    expect(adapterPayload).toEqual({ model: "gateway-model-1", stream: true });
  });

  it("adds the key to whatever the caller's hook returned, not to the adapter payload", async () => {
    const replacement = { model: "rewritten", extra: true };
    const options: SimpleStreamOptions = { onPayload: async () => replacement };
    const result = withSessionAffinityOptions(options, input());

    const payload = await result.onPayload?.(
      { model: "gateway-model-1", stream: true },
      completionsModel,
    );

    expect(payload).toEqual({ model: "rewritten", extra: true, prompt_cache_key: "session-7" });
    expect(replacement).toEqual({ model: "rewritten", extra: true });
  });

  it("lets a key the caller's hook set survive", async () => {
    const options: SimpleStreamOptions = {
      onPayload: async () => ({ model: "rewritten", prompt_cache_key: "caller-set" }),
    };
    const result = withSessionAffinityOptions(options, input());

    expect(
      await result.onPayload?.({ model: "gateway-model-1" }, completionsModel),
    ).toEqual({ model: "rewritten", prompt_cache_key: "caller-set" });
  });

  it("adds no key for a caller with no session id", async () => {
    const adapterPayload = { model: "gateway-model-1", stream: true };
    const result = withSessionAffinityOptions({}, input({ sessionId: undefined }));

    const payload = await result.onPayload?.(adapterPayload, completionsModel);

    // `undefined` is pi-ai's "keep the payload the adapter built".
    expect(payload).toBeUndefined();
    expect(adapterPayload).toEqual({ model: "gateway-model-1", stream: true });
  });

  it("leaves the adapter's payload as the caller's hook returned it when nothing is added", async () => {
    const replacement = { model: "rewritten", stream: true };
    const result = withSessionAffinityOptions(
      { onPayload: async () => replacement },
      input({ sessionId: undefined }),
    );

    expect(
      await result.onPayload?.({ model: "gateway-model-1" }, completionsModel),
    ).toBe(replacement);
  });
});

/**
 * Oracle: derived, from the adapter this module feeds
 * (pi-ai dist/api/openai-completions.js createClient / buildParams): it writes
 * `session_id`, `x-client-request-id` and `x-session-affinity` beside the body
 * key, and only the non-OpenRouter format does so.
 */
describe("the pi-ai Completions adapter's session identity", () => {
  it("sends the headers and body key §6.3 names, and no key on a published host", async () => {
    const sent: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetchStub: typeof globalThis.fetch = async (_url, init) => {
      sent.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const streamOnce = async (
      baseUrl: string,
      provider: SessionAffinityProvider,
    ): Promise<void> => {
      const model = {
        ...completionsModel,
        baseUrl,
        compat: sessionAffinityCompat(provider, "openai-completions", baseUrl),
      } as Model<"openai-completions">;
      const options = withSessionAffinityOptions(
        { apiKey: "sk-test", sessionId: "session-42", fetch: fetchStub },
        { provider, api: "openai-completions", baseUrl, sessionId: "session-42" },
      );
      for await (const _event of completionsStreamSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
        options,
      )) {
        // drain so the request the stub captured is the whole request
      }
    };

    await streamOnce(GATEWAY, ownGateway);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get("session_id")).toBe("session-42");
    expect(sent[0].headers.get("x-client-request-id")).toBe("session-42");
    expect(sent[0].headers.get("x-session-affinity")).toBe("session-42");
    expect(sent[0].body.prompt_cache_key).toBe("session-42");

    await streamOnce("https://api.deepseek.com/v1", ownGateway);
    expect(sent).toHaveLength(2);
    expect(sent[1].headers.get("x-session-affinity")).toBeNull();
    expect(sent[1].headers.get("session_id")).toBeNull();
    expect(sent[1].body.prompt_cache_key).toBeUndefined();
  });
});

/**
 * Oracle: derived, from the Anthropic adapter's own header choice
 * (pi-ai dist/api/anthropic-messages.js: any format but `openrouter` writes
 * `x-session-affinity`, and `openrouter` would write `x-session-id` instead).
 */
describe("the pi-ai Anthropic adapter's session identity", () => {
  it("writes x-session-affinity for the user's own relay", async () => {
    const model = {
      ...completionsModel,
      api: "anthropic-messages",
      baseUrl: ANTHROPIC_RELAY,
      compat: sessionAffinityCompat(
        ownAnthropicRelay,
        "anthropic-messages",
        ANTHROPIC_RELAY,
      ),
    } as Model<"anthropic-messages">;
    const sent: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetchStub: typeof globalThis.fetch = async (_url, init) => {
      sent.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const options = withSessionAffinityOptions(
      { apiKey: "sk-test", sessionId: "session-42", maxTokens: 16, fetch: fetchStub },
      {
        provider: ownAnthropicRelay,
        api: "anthropic-messages",
        baseUrl: ANTHROPIC_RELAY,
        sessionId: "session-42",
      },
    );

    for await (const _event of streamSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
      options,
    )) {
      // drain: only the captured request matters here
    }

    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get("x-session-affinity")).toBe("session-42");
    expect(sent[0].headers.get("x-session-id")).toBeNull();
    // The body key is the Chat Completions channel only.
    expect(sent[0].body.prompt_cache_key).toBeUndefined();
  });
});

describe("the pi-ai Responses adapter's proxy-safe session identity", () => {
  it("sends x-session-affinity alongside its existing session headers", async () => {
    const model = {
      ...completionsModel,
      api: "openai-responses",
      baseUrl: GATEWAY,
    } as Model<"openai-responses">;
    const sent: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetchStub: typeof globalThis.fetch = async (_url, init) => {
      sent.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ error: { message: "fixture response" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    };
    const options = withSessionAffinityOptions(
      { apiKey: "sk-test", sessionId: "session-42", fetch: fetchStub },
      { provider: ownGateway, api: "openai-responses", baseUrl: GATEWAY, sessionId: "session-42" },
    );

    await responsesStreamSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
      options,
    ).result();

    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get("session_id")).toBe("session-42");
    expect(sent[0].headers.get("x-client-request-id")).toBe("session-42");
    expect(sent[0].headers.get("x-session-affinity")).toBe("session-42");
  });
});
