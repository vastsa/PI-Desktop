import assert from "node:assert/strict";
import test from "node:test";

import {
  VendorOAuth,
  apiStyleForWireApi,
  isXaiConversationModel,
  protocolForApiStyle,
  secretRefForProviderOauth,
} from "../electron/main/oauth.ts";

/**
 * A host-core stand-in: the provider table plus the encrypted secret store,
 * reduced to the RPCs the OAuth module is allowed to call.
 */
function fakeHost() {
  const providers = new Map();
  const secrets = new Map();
  let nextRow = 0;
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "providers.list":
        return {
          providers: [...providers.values()].map((row) => ({
            ...row,
            hasOauth: secrets.has(secretRefForProviderOauth(row.id)),
          })),
        };
      case "providers.create": {
        const id = `row-${++nextRow}`;
        providers.set(id, { id, ...params });
        return { provider: providers.get(id) };
      }
      case "providers.update": {
        const row = providers.get(params.id);
        if (!row) return { provider: null };
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) row[key] = value;
        }
        return { provider: row };
      }
      case "providers.delete":
        providers.delete(params.id);
        secrets.delete(secretRefForProviderOauth(params.id));
        secrets.delete(`secret:provider:${params.id}:api_key`);
        return { ok: true };
      case "secrets.set":
        secrets.set(params.secretRef, params.value);
        return { ok: true };
      case "secrets.getForRuntime":
        return { value: secrets.get(params.secretRef) ?? null };
      case "secrets.delete":
        secrets.delete(params.secretRef);
        return { ok: true };
      default:
        throw new Error(`unexpected host call: ${method}`);
    }
  };
  return { call, providers, secrets, calls };
}

/**
 * A pi-ai `Models` stand-in for one OAuth vendor. `login` drives the same
 * prompt/notify conversation the real Anthropic flow does — open a URL, then
 * fall back to a pasted code — and persists through the injected store, so the
 * test exercises the credential path rather than mocking it away.
 */
function fakeModels(credentials, { login, models: configuredModels, provider: providerOverride } = {}) {
  const provider = providerOverride ?? {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: {
      oauth: {
        name: "Anthropic (Claude Pro/Max)",
        isSubscription: true,
        loginLabel: "Sign in with Claude Pro/Max",
      },
    },
  };
  const models = configuredModels ?? [
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
      },
      cost: { input: 0, output: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    },
    {
      id: "claude-haiku-5",
      name: "Claude Haiku 5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  ];
  return {
    getProviders: () => [provider],
    getProvider: (id) => (id === provider.id ? provider : undefined),
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getAvailable: async () => models,
    getModel: (providerId, modelId) => providerId === provider.id
      ? models.find((model) => model.id === modelId)
      : undefined,
    login:
      login ??
      (async (_id, _type, interaction) => {
        interaction.notify({
          type: "auth_url",
          url: "https://claude.ai/oauth/authorize",
          instructions: "Approve the request, then paste the code.",
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "Paste the authorization code",
        });
        const credential = {
          type: "oauth",
          refresh: `refresh-for-${code}`,
          access: `access-for-${code}`,
          expires: 4102444800000,
        };
        await credentials.modify(provider.id, async () => credential);
        return credential;
      }),
    logout: async (id) => credentials.delete(id),
    getAuth: async (id) => {
      const credential = await credentials.read(id);
      if (!credential) return undefined;
      // What the real toAuth() hands back: the access token only.
      return { auth: { apiKey: credential.access }, source: "OAuth" };
    },
  };
}

function harness(options = {}) {
  const host = fakeHost();
  const events = [];
  const opened = [];
  let counter = 0;
  const stores = [];
  const oauth = new VendorOAuth({
    call: host.call,
    emit: (event) => events.push(event),
    openExternal: async (url) => {
      opened.push(url);
      if (options.browserFails) throw new Error("no browser");
    },
    createModels: (store) => {
      stores.push(store);
      return fakeModels(store, options);
    },
    modelConfigFor: options.modelConfigFor,
    newId: () => `id-${++counter}`,
    fetch:
      options.fetch ??
      (async () => {
        throw new Error("live model list disabled in test");
      }),
  });
  // The store the module handed pi-ai, so a test can drive it the way a token
  // refresh would.
  // The catalog is created first; every following store belongs to one local
  // provider row. Tests can inspect a specific account without collapsing it
  // into a vendor-global credential.
  const store = (accountIndex = 0) => stores[accountIndex + 1];
  return { host, events, opened, oauth, store, stores };
}

/** Wait until an event of this kind shows up, so tests never poll blindly. */
async function waitFor(events, kind, maxAttempts = 200) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const found = events.find((event) => event.kind === kind);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no ${kind} event; saw ${events.map((e) => e.kind).join(", ")}`);
}

test("wire apis map to the provider row's api style and protocol", () => {
  assert.equal(apiStyleForWireApi("openai-codex-responses"), "openai_codex_responses");
  assert.equal(apiStyleForWireApi("pi-messages"), "pi_messages");
  assert.equal(apiStyleForWireApi("anthropic-messages"), "anthropic_messages");
  // An api we have no style for still produces a usable row.
  assert.equal(apiStyleForWireApi("something-new"), "chat_completions");
  assert.equal(protocolForApiStyle("anthropic_messages"), "anthropic");
  assert.equal(protocolForApiStyle("pi_messages"), "custom_http");
});

test("vendors are derived from pi-ai, not hardcoded", async () => {
  const { oauth } = harness();
  assert.deepEqual(await oauth.listVendors(), [
    {
      vendorId: "anthropic",
      name: "Anthropic (Claude Pro/Max)",
      loginLabel: "Sign in with Claude Pro/Max",
      isSubscription: true,
      accounts: [],
    },
  ]);
});

test("a completed login stores the credential and configures the row", async () => {
  const { host, events, opened, oauth } = harness();
  const { loginId } = await oauth.start("anthropic");

  const authUrl = await waitFor(events, "authUrl");
  assert.deepEqual(opened, ["https://claude.ai/oauth/authorize"]);
  assert.equal(authUrl.opened, true);

  const prompt = await waitFor(events, "prompt");
  assert.equal(prompt.request.type, "manual_code");
  assert.equal(oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" }), true);

  const done = await waitFor(events, "done");
  assert.equal(done.accountLabel, "Anthropic (Claude Pro/Max)");

  const row = host.providers.get(done.providerId);
  assert.equal(row.authKind, "oauth");
  assert.equal(row.vendorKey, "anthropic");
  assert.equal(row.apiStyle, "anthropic_messages");
  assert.equal(row.protocol, "anthropic");
  assert.equal(row.defaultModelId, "claude-opus-5");
  assert.equal(row.oauthAccountLabel, "Anthropic (Claude Pro/Max)");
  assert.deepEqual(row.models, [
    {
      id: "claude-opus-5",
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["off"],
      defaultThinkingLevel: "off",
    },
    {
      id: "claude-haiku-5",
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["off"],
      defaultThinkingLevel: "off",
    },
  ]);

  // The credential lands under the provider-scoped OAuth ref, never the api key.
  const stored = JSON.parse(host.secrets.get(secretRefForProviderOauth(row.id)));
  assert.equal(stored.type, "oauth");
  assert.equal(stored.refresh, "refresh-for-abc");
  assert.equal(host.secrets.has(`secret:provider:${row.id}:api_key`), false);

  // The sidecar only ever gets the short-lived access token.
  assert.deepEqual(await oauth.resolveAuth(row.id), { apiKey: "access-for-abc" });

  const [vendor] = await oauth.listVendors();
  assert.deepEqual(vendor.accounts, [
    {
      providerId: row.id,
      accountLabel: "Anthropic (Claude Pro/Max)",
      connected: true,
    },
  ]);
});

test("OAuth model configuration comes from the supplied models.dev snapshot", async () => {
  const modelConfigFor = async ({ option }) => ({
    source: "models.dev",
    name: option.modelId === "claude-opus-5" ? "Claude 4.6 Opus" : "Claude Haiku 5",
    baseUrl: option.baseUrl,
    reasoning: option.modelId === "claude-opus-5",
    supportedThinkingLevels: option.modelId === "claude-opus-5" ? ["low", "medium", "high"] : [],
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: {
      context: option.modelId === "claude-opus-5" ? 250_000 : 150_000,
      input: option.modelId === "claude-opus-5" ? 250_000 : 150_000,
      output: option.modelId === "claude-opus-5" ? 20_000 : 8_192,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    input: ["text", "image"],
    contextWindow: option.modelId === "claude-opus-5" ? 250_000 : 150_000,
    maxTokens: option.modelId === "claude-opus-5" ? 20_000 : 8_192,
  });
  const { host, events, oauth } = harness({ modelConfigFor });
  const { loginId } = await oauth.start("anthropic");
  const prompt = await waitFor(events, "prompt");
  assert.equal(oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" }), true);
  const done = await waitFor(events, "done");
  assert.deepEqual(host.providers.get(done.providerId).models, [
    {
      id: "claude-opus-5",
      contextWindow: 250_000,
      maxTokens: 20_000,
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "medium",
    },
    {
      id: "claude-haiku-5",
      contextWindow: 150_000,
      maxTokens: 8_192,
      thinkingLevels: ["off"],
      defaultThinkingLevel: "off",
    },
  ]);
});

test("cancelling takes the half-created row back out", async () => {
  const { host, events, oauth } = harness();
  const { loginId } = await oauth.start("anthropic");
  await waitFor(events, "prompt");
  assert.equal(oauth.cancel(loginId), true);

  await waitFor(events, "cancelled");
  assert.equal(host.providers.size, 0);
  assert.equal(host.secrets.size, 0);
  // The pending prompt is closed out so the dialog cannot hang on it.
  assert.ok(events.some((event) => event.kind === "promptCancelled"));
});

test("a failing login reports the reason and leaves no row behind", async () => {
  const { host, events, oauth } = harness({
    login: async () => {
      throw new Error("token exchange rejected");
    },
  });
  await oauth.start("anthropic");
  const failure = await waitFor(events, "error");
  assert.equal(failure.message, "token exchange rejected");
  assert.equal(host.providers.size, 0);
});

test("a browser that will not open falls back to a copyable link", async () => {
  const { events, oauth } = harness({ browserFails: true });
  await oauth.start("anthropic");
  const authUrl = await waitFor(events, "authUrl");
  assert.equal(authUrl.opened, false);
  assert.equal(authUrl.url, "https://claude.ai/oauth/authorize");
});

test("deleting an account removes its credential and configured row", async () => {
  const { host, events, oauth } = harness();
  const { loginId } = await oauth.start("anthropic");
  const prompt = await waitFor(events, "prompt");
  oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" });
  const done = await waitFor(events, "done");

  await oauth.deleteAccount(done.providerId);
  assert.equal(host.secrets.has(secretRefForProviderOauth(done.providerId)), false);
  assert.equal(host.providers.has(done.providerId), false);

  const [vendor] = await oauth.listVendors();
  assert.deepEqual(vendor.accounts, []);
  await assert.rejects(() => oauth.resolveAuth(done.providerId), /not signed in/);
});

test("signing in again creates an independent account row", async () => {
  const { host, events, oauth } = harness();
  const first = await oauth.start("anthropic");
  const prompt = await waitFor(events, "prompt");
  oauth.respond({ loginId: first.loginId, promptId: prompt.request.promptId, value: "abc" });
  const done = await waitFor(events, "done");

  events.length = 0;
  const second = await oauth.start("anthropic");
  const again = await waitFor(events, "prompt");
  oauth.respond({ loginId: second.loginId, promptId: again.request.promptId, value: "xyz" });
  const redone = await waitFor(events, "done");

  assert.notEqual(redone.providerId, done.providerId);
  assert.equal(host.providers.size, 2);
  const firstStored = JSON.parse(
    host.secrets.get(secretRefForProviderOauth(done.providerId)),
  );
  const secondStored = JSON.parse(
    host.secrets.get(secretRefForProviderOauth(redone.providerId)),
  );
  assert.equal(firstStored.access, "access-for-abc");
  assert.equal(secondStored.access, "access-for-xyz");
  assert.deepEqual(await oauth.resolveAuth(done.providerId), {
    apiKey: "access-for-abc",
  });
  assert.deepEqual(await oauth.resolveAuth(redone.providerId), {
    apiKey: "access-for-xyz",
  });

  await oauth.deleteAccount(done.providerId);
  assert.equal(host.providers.has(done.providerId), false);
  assert.equal(host.providers.has(redone.providerId), true);
  assert.deepEqual(await oauth.resolveAuth(redone.providerId), {
    apiKey: "access-for-xyz",
  });
});

test("a second attempt waits for the first to let go of its callback port", async () => {
  // StrictMode mounts a dialog twice, and a user can click again; either way the
  // old attempt still owns the local callback server. Standing up a new one
  // before it unwinds is how a login fails the moment it starts.
  let inFlight = 0;
  let overlapped = false;
  const { events, oauth } = harness({
    login: async (_id, _type, interaction) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      try {
        await interaction.prompt({ type: "manual_code", message: "Paste the code" });
        return { type: "oauth", refresh: "r", access: "a", expires: 4102444800000 };
      } finally {
        // The server closes a turn after the flow gives up, as a real one does.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }
    },
  });

  const first = await oauth.start("anthropic");
  await waitFor(events, "prompt");
  const second = await oauth.start("anthropic");

  assert.equal(overlapped, false, "the attempts never held the port together");
  assert.notEqual(second.loginId, first.loginId);
  assert.equal(
    events.filter((event) => event.kind === "cancelled").length,
    1,
    "the superseded attempt reported itself cancelled",
  );
  oauth.cancel(second.loginId);
});

function metaFetchMock({ mintStatus = 200 } = {}) {
  const requests = [];
  let tokenPolls = 0;
  const fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://auth.meta.com/oidc/device/authorization/") {
      return new Response(JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri_complete: "https://auth.meta.com/device/verify",
        interval: 0.001,
        expires_in: 30,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://auth.meta.com/oidc/device/token/") {
      tokenPolls += 1;
      return tokenPolls === 1
        ? new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 })
        : new Response(JSON.stringify({ access_token: "meta-identity-token" }), { status: 200 });
    }
    if (url === "https://api.meta.ai/muse-code/key") {
      return new Response(
        JSON.stringify(mintStatus === 200 ? { api_key: "muse-api-key" } : { message: "expired" }),
        { status: mintStatus, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected Meta request: ${url}`);
  };
  return { fetch, requests };
}

test("Meta device-code OAuth stores the identity refresh token and resolves the Muse API key", async () => {
  const host = fakeHost();
  const events = [];
  const meta = metaFetchMock();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = meta.fetch;
  const oauth = new VendorOAuth({ call: host.call, emit: (event) => events.push(event), openExternal: async () => {} });
  try {
    const { loginId } = await oauth.start("meta");
    const device = await waitFor(events, "deviceCode");
    assert.equal(device.userCode, "ABCD-EFGH");
    assert.equal(device.verificationUri, "https://auth.meta.com/device/verify");
    const done = await waitFor(events, "done", 1200);
    const row = host.providers.get(done.providerId);
    assert.equal(row.vendorKey, "meta");
    assert.equal(row.apiStyle, "responses");
    assert.equal(row.protocol, "openai");
    assert.equal(row.baseUrl, "https://api.meta.ai/v1");
    assert.ok(row.models.some((model) => model.id === "muse-spark-1.3"));
    assert.deepEqual(await oauth.resolveAuth(row.id), { apiKey: "muse-api-key" });
    const stored = JSON.parse(host.secrets.get(secretRefForProviderOauth(row.id)));
    assert.equal(stored.refresh, "meta-identity-token");
    assert.equal(stored.access, "muse-api-key");
    assert.equal(meta.requests.filter((request) => request.url.includes("meta.com")).length, 3);
    assert.equal(loginId, done.loginId);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Meta OAuth removes the provider row when API-key minting reports an expired session", async () => {
  const host = fakeHost();
  const events = [];
  const meta = metaFetchMock({ mintStatus: 401 });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = meta.fetch;
  const oauth = new VendorOAuth({ call: host.call, emit: (event) => events.push(event), openExternal: async () => {} });
  try {
    await oauth.start("meta");
    const error = await waitFor(events, "error", 1200);
    assert.match(error.message, /Meta session expired/);
    assert.equal(host.providers.size, 0);
    assert.equal(host.secrets.size, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the real pi-ai catalog offers every vendor account we ship", async () => {
  const host = fakeHost();
  // No createModels seam here: this exercises registerBunOAuthFlows() plus the
  // built-in provider list, which is what the packaged app runs.
  const oauth = new VendorOAuth({
    call: host.call,
    emit: () => {},
    openExternal: async () => {},
  });
  const vendors = await oauth.listVendors();
  assert.deepEqual(
    vendors.map((vendor) => vendor.vendorId).sort(),
    [
      "anthropic",
      "github-copilot",
      "kimi-coding",
      "meta",
      "openai-codex",
      "openrouter",
      "radius",
      "xai",
    ],
  );
  assert.ok(vendors.every((vendor) => vendor.name && vendor.accounts.length === 0));
});

test("the Meta OAuth catalog includes Muse Spark 1.3", async () => {
  const { META_MODELS } = await import("@earendil-works/pi-ai/providers/meta.models");
  const model = META_MODELS["muse-spark-1.3"];
  assert.ok(model, "Meta catalog must include muse-spark-1.3");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.provider, "meta");
  assert.equal(model.baseUrl, "https://api.meta.ai/v1");
});

test("the ChatGPT OAuth catalog includes GPT-6 Astra", async () => {
  const { OPENAI_CODEX_MODELS } = await import(
    "@earendil-works/pi-ai/providers/openai-codex.models"
  );
  const model = OPENAI_CODEX_MODELS["gpt-6-astra"];
  assert.ok(model, "openai-codex catalog must include gpt-6-astra");
  assert.equal(model.id, "gpt-6-astra");
  assert.equal(model.api, "openai-codex-responses");
});

test("the pi-ai 0.87.1 OAuth catalogs include the stable model wires", async () => {
  const { OPENAI_CODEX_MODELS } = await import(
    "@earendil-works/pi-ai/providers/openai-codex.models"
  );
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
    const model = OPENAI_CODEX_MODELS[modelId];
    assert.ok(model, `openai-codex catalog must include ${modelId}`);
    assert.equal(model.api, "openai-codex-responses");
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 272_000);
    assert.equal(model.maxTokens, 128_000);
    assert.ok(model.input.includes("image"));
  }

  const { GITHUB_COPILOT_MODELS } = await import(
    "@earendil-works/pi-ai/providers/github-copilot.models"
  );
  assert.equal(GITHUB_COPILOT_MODELS["claude-opus-5"]?.api, "anthropic-messages");
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-luna", "grok-4.6"]) {
    const model = GITHUB_COPILOT_MODELS[modelId];
    assert.ok(model, `github-copilot catalog must include ${modelId}`);
    assert.equal(model.api, "openai-responses");
    assert.ok(model.input.includes("image"));
  }

  const { ANTHROPIC_MODELS } = await import(
    "@earendil-works/pi-ai/providers/anthropic.models"
  );
  assert.equal(ANTHROPIC_MODELS["claude-opus-5"]?.api, "anthropic-messages");
  assert.equal(ANTHROPIC_MODELS["claude-opus-5"]?.contextWindow, 1_000_000);

  const { XAI_MODELS } = await import("@earendil-works/pi-ai/providers/xai.models");
  assert.equal(XAI_MODELS["grok-4.6"]?.api, "openai-responses");
  const thinkingLevels = Object.entries(XAI_MODELS["grok-4.6"]?.thinkingLevelMap ?? {})
    .filter(([, value]) => typeof value === "string")
    .map(([level]) => level);
  for (const level of ["low", "medium", "high", "xhigh"]) {
    assert.ok(thinkingLevels.includes(level), `xAI catalog must include ${level} thinking`);
  }
});

test("credential writes for one account run one at a time", async () => {
  const { host, events, oauth, store } = harness();
  const { loginId } = await oauth.start("anthropic");
  const prompt = await waitFor(events, "prompt");
  oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" });
  await waitFor(events, "done");

  let active = 0;
  let overlapped = false;
  const seen = [];
  const slow = async (current) => {
    active += 1;
    if (active > 1) overlapped = true;
    seen.push(current?.access);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    const next = `rotated-${seen.length}`;
    return { type: "oauth", refresh: next, access: next, expires: 0 };
  };
  const credentials = store(0);
  await Promise.all([
    credentials.modify("anthropic", slow),
    credentials.modify("anthropic", slow),
  ]);

  // Serialized, so the second call reads what the first wrote — the state
  // pi-ai's locked refresh depends on to avoid double-refreshing a token.
  assert.equal(overlapped, false);
  assert.deepEqual(seen, ["access-for-abc", "rotated-1"]);
  assert.equal(host.secrets.size, 1);
});

test("conversation-model filter drops xAI image and video ids", () => {
  assert.equal(isXaiConversationModel("grok-4.7"), true);
  assert.equal(isXaiConversationModel("grok-4.7-build-fast"), true);
  assert.equal(isXaiConversationModel("grok-imagine-image"), false);
  assert.equal(isXaiConversationModel("grok-imagine-video-1.5"), false);
  assert.equal(isXaiConversationModel("  "), false);
});

test("an xAI account offers the chat models its /models endpoint returns", async () => {
  const seen = [];
  const fetchModels = async (url, init) => {
    seen.push({
      url: String(url),
      authorization: init?.headers?.Authorization,
    });
    return new Response(JSON.stringify({
      data: [
        { id: "grok-4.6" },
        { id: "grok-4.7" },
        { id: "grok-imagine-image" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchModels;
  const xaiModel = {
    id: "grok-4.6",
    name: "Grok 4.6",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
  };
  try {
    const { host, events, oauth } = harness({
      fetch: fetchModels,
      provider: {
        id: "xai",
        name: "xAI",
        baseUrl: "https://api.x.ai/v1",
        auth: {
          oauth: {
            name: "xAI (Grok/X subscription)",
            isSubscription: true,
            loginLabel: "Sign in with SuperGrok or X Premium",
          },
        },
      },
      models: [
        xaiModel,
        { ...xaiModel, id: "grok-2", name: "Grok 2" },
      ],
    });
    const { loginId } = await oauth.start("xai");
    const prompt = await waitFor(events, "prompt");
    oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" });
    const done = await waitFor(events, "done");
    const row = host.providers.get(done.providerId);
    assert.deepEqual(row.models.map((model) => model.id), ["grok-4.6", "grok-4.7"]);
    const offered = row.models.find((model) => model.id === "grok-4.7");
    assert.equal(offered.contextWindow, 500_000);
    assert.deepEqual(offered.thinkingLevels, ["low", "medium", "high", "xhigh"]);
    assert.equal(await oauth.bindingFor(done.providerId, "grok-2"), undefined);
    const binding = await oauth.bindingFor(done.providerId, "grok-4.7");
    assert.equal(binding.apiStyle, "responses");
    assert.equal(binding.baseUrl, "https://api.x.ai/v1");
    assert.equal(seen[0].url, "https://api.x.ai/v1/models");
    assert.equal(seen[0].authorization, "Bearer access-for-abc");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a new Grok inherits grok-4.6 even when an older Grok is first in the pin", async () => {
  const fetchModels = async () => new Response(JSON.stringify({
    data: [{ id: "grok-4.7" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const older = {
    id: "grok-4.3",
    name: "Grok 4.3",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 30_000,
  };
  const newest = {
    ...older,
    id: "grok-4.6",
    name: "Grok 4.6",
    input: ["text", "image"],
    thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    contextWindow: 500_000,
    maxTokens: 500_000,
  };
  const { events, oauth } = harness({
    fetch: fetchModels,
    provider: {
      id: "xai",
      name: "xAI",
      baseUrl: "https://api.x.ai/v1",
      auth: { oauth: { name: "xAI", isSubscription: true, loginLabel: "Sign in" } },
    },
    models: [older, newest],
  });
  const { loginId } = await oauth.start("xai");
  const prompt = await waitFor(events, "prompt");
  oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" });
  const done = await waitFor(events, "done");
  const binding = await oauth.bindingFor(done.providerId, "grok-4.7");
  assert.equal(binding.modelConfig.contextWindow, 500_000);
  assert.equal(binding.modelConfig.maxTokens, 500_000);
  assert.deepEqual(binding.supportedThinkingLevels, ["low", "medium", "high", "xhigh"]);
});
