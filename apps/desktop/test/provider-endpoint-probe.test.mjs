/**
 * Endpoint-resolution probe contract.
 *
 * Resolution is only automatic when it is also explainable: these tests pin the
 * order candidates are asked in, the address that wins, the shared time budget,
 * and the two safety rules — the key never leaves the typed origin, and a
 * redirect may not carry it to another one.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { inferEndpointProfile } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  DISCOVERY_SWEEP_BUDGET_MS,
  probeDiscoveryCandidates,
} = await import("../electron/main/provider-endpoint-probe.ts");
const { probeModelList, probeProviderEndpoint } = await import("../electron/main/model-discovery.ts");

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Run `fn` with a stubbed global fetch, restoring it afterwards. */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      redirect: init?.redirect,
    });
    return handler(String(url), init);
  };
  try {
    return { calls, result: await fn() };
  } finally {
    globalThis.fetch = original;
  }
}

test("a bare host resolves to the path that answers, and the winner is reported", async () => {
  const profile = inferEndpointProfile({ baseUrl: "api.foo.com" });
  assert.deepEqual(profile.candidates.map((candidate) => candidate.baseUrl), [
    "https://api.foo.com",
    "https://api.foo.com/v1",
  ]);

  const { calls, result } = await withFetch(
    (url) => url === "https://api.foo.com/v1/models"
      ? jsonResponse({ data: [{ id: "gateway-model", display_name: "Gateway Model" }] })
      : new Response("not found", { status: 404 }),
    () => probeDiscoveryCandidates({
      origin: profile.origin,
      candidates: profile.candidates,
      apiKey: "sk-secret",
    }),
  );

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.foo.com/models",
    "https://api.foo.com/v1/models",
  ]);
  assert.equal(result.outcome.effectiveBaseUrl, "https://api.foo.com/v1");
  assert.equal(result.outcome.discoveryStyle, "openai_models");
  assert.deepEqual(result.outcome.models, [
    { modelId: "gateway-model", displayName: "Gateway Model" },
  ]);
  // The first candidate's failure is recorded, so the UI can explain the sweep.
  assert.equal(result.outcome.attempts[0].status, 404);
  assert.equal(result.outcome.attempts[1].status, 200);
});

test("candidates are asked one at a time and the sweep stops at the first answer", async () => {
  const profile = inferEndpointProfile({ baseUrl: "https://api.foo.com" });
  const seen = [];
  let inFlight = 0;
  const { result } = await withFetch((url) => {
    seen.push(url);
    return url.includes("missing") ? new Response("", { status: 404 }) : jsonResponse({ data: [{ id: "only" }] });
  }, () => probeDiscoveryCandidates({
    origin: profile.origin,
    candidates: [
      { ...profile.candidates[0], baseUrl: "https://api.foo.com/missing" },
      profile.candidates[0],
      profile.candidates[1],
    ],
    apiKey: "sk-secret",
    probe: async (options) => {
      inFlight += 1;
      assert.equal(inFlight, 1, "a sweep must never fan the credential out in parallel");
      try {
        return await probeModelList(options);
      } finally {
        inFlight -= 1;
      }
    },
  }));

  assert.deepEqual(seen, ["https://api.foo.com/missing/models", "https://api.foo.com/models"]);
  assert.equal(result.outcome.effectiveBaseUrl, "https://api.foo.com");
});

test("the key never reaches an origin the user did not type", async () => {
  const profile = inferEndpointProfile({ baseUrl: "https://api.foo.com" });
  const { calls, result } = await withFetch(
    () => jsonResponse({ data: [{ id: "m" }] }),
    () => probeDiscoveryCandidates({
      origin: profile.origin,
      candidates: [
        // A caller-supplied list is still refused at the probe boundary.
        { ...profile.candidates[0], baseUrl: "https://api.bar.com/v1" },
        profile.candidates[0],
      ],
      apiKey: "sk-secret",
    }),
  );

  assert.deepEqual(calls.map((call) => new URL(call.url).origin), ["https://api.foo.com"]);
  assert.equal(result.attempts[0].error, "refused: candidate left the configured origin");
  assert.equal(result.outcome.effectiveBaseUrl, "https://api.foo.com");
});

test("the endpoint's own model id is reported unchanged", async () => {
  // `mify/mimo-v2.5-pro-0731` may borrow metadata from `mimo-v2.5-pro`,
  // but the id a request is addressed with is the one the service served.
  const profile = inferEndpointProfile({ baseUrl: "https://api.foo.com" });
  const { result } = await withFetch(
    () => jsonResponse({ data: [{ id: "mify/mimo-v2.5-pro-0731" }] }),
    () => probeDiscoveryCandidates({
      origin: profile.origin,
      candidates: profile.candidates,
      apiKey: "sk-secret",
    }),
  );
  assert.deepEqual(result.outcome.models, [
    { modelId: "mify/mimo-v2.5-pro-0731", displayName: "mify/mimo-v2.5-pro-0731" },
  ]);
});


test("candidates share one time budget instead of timing out one by one", async () => {
  const profile = inferEndpointProfile({ baseUrl: "https://api.foo.com" });
  const candidates = [
    { ...profile.candidates[0], baseUrl: "https://api.foo.com/a" },
    { ...profile.candidates[0], baseUrl: "https://api.foo.com/b" },
    { ...profile.candidates[0], baseUrl: "https://api.foo.com/c" },
  ];
  let clock = 0;
  const asked = [];
  const { result } = await withFetch(
    () => { throw Object.assign(new Error("timed out"), {}); },
    () => probeDiscoveryCandidates({
      origin: profile.origin,
      candidates,
      apiKey: "sk-secret",
      now: () => clock,
      probe: async (options) => {
        asked.push(options.baseUrl);
        // The first candidate consumes the whole budget.
        clock += options.baseUrl.endsWith("/a") ? DISCOVERY_SWEEP_BUDGET_MS : 1;
        throw new Error("timed out");
      },
    }),
  );

  assert.deepEqual(asked, ["https://api.foo.com/a"]);
  assert.equal(result.outcome, undefined);
  assert.equal(result.attempts.at(-1).error, "sweep budget exhausted");
});

test("a cross-origin redirect is refused before the credential travels", async () => {
  const { calls } = await withFetch(
    () => new Response("", { status: 302, headers: { location: "https://api.bar.com/v1/models" } }),
    async () => {
      await assert.rejects(
        () => probeModelList({ baseUrl: "https://api.foo.com", apiKey: "sk-secret" }),
        /redirect refused/,
      );
    },
  );
  assert.equal(calls.length, 1, "a refused redirect must not be followed");
  assert.equal(calls[0].redirect, "manual");
});

test("Anthropic token-plan endpoints can pass connection testing without a model list", async () => {
  const { calls, result } = await withFetch((url, init) => {
    if (init?.method === "OPTIONS" && url.endsWith("/anthropic/v1/messages")) {
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }, () => probeProviderEndpoint({
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    apiStyle: "anthropic_messages",
    apiKey: "sk-secret",
  }));

  assert.equal(result.status, 200);
  assert.deepEqual(result.models, []);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://token-plan-cn.xiaomimimo.com/anthropic/v1/models?limit=1000",
    "https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages",
  ]);
  assert.equal(calls[1].method, "OPTIONS");
  assert.equal(calls[1].headers["x-api-key"], undefined);
});

test("a same-origin redirect is followed with the same credential", async () => {
  const { calls } = await withFetch(
    (url) => url.endsWith("/moved")
      ? jsonResponse({ data: [{ id: "after-redirect" }] })
      : new Response("", { status: 307, headers: { location: "https://api.foo.com/v1/moved" } }),
    () => probeModelList({ baseUrl: "https://api.foo.com", apiKey: "sk-secret" }),
  );
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.foo.com/models",
    "https://api.foo.com/v1/moved",
  ]);
  assert.equal(calls[1].headers.Authorization, "Bearer sk-secret");
});

test("each discovery style uses its own endpoint and auth header", async () => {
  const { calls } = await withFetch(() => jsonResponse({ data: [] }), async () => {
    await probeModelList({ baseUrl: "https://api.anthropic.com", apiKey: "sk-a", apiStyle: "anthropic_messages" });
    await probeModelList({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      apiStyle: "google_generative_ai",
    });
  });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(calls[0].headers["x-api-key"], "sk-a");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.match(calls[1].url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?/);
  assert.match(calls[1].url, /key=g-key/);
});

test("an HTTP failure reports its status so the caller can classify it", async () => {
  await withFetch(() => new Response("unauthorized", { status: 401 }), async () => {
    await assert.rejects(
      () => probeModelList({ baseUrl: "https://api.foo.com", apiKey: "sk-secret" }),
      (error) => error.status === 401,
    );
  });
});

test("a typed path that answers keeps the row, even when a sibling path also answers", async () => {
  /*
    The reported failure: a Zhipu OpenAI Responses row at
    `https://open.bigmodel.cn/api/v1` publishes `{ models: [{ slug }] }`. Reading
    that shape is what keeps the row on the address the user typed; without it
    the sweep would move on and answer from the sibling coding-plan path, with
    the wrong models and a rewritten Base URL.
  */
  const profile = inferEndpointProfile({
    baseUrl: "https://open.bigmodel.cn/api/v1",
    apiStyle: "responses",
    explicitApiStyle: true,
  });
  assert.deepEqual(profile.candidates.map((candidate) => candidate.baseUrl), [
    "https://open.bigmodel.cn/api/v1",
  ]);

  const { calls, result } = await withFetch(
    (url) => url === "https://open.bigmodel.cn/api/v1/models"
      ? jsonResponse({ models: [{ slug: "glm-5.3", display_name: "glm-5.3" }] })
      : jsonResponse({ data: [{ id: "should-not-be-used" }] }),
    () => probeDiscoveryCandidates({
      origin: profile.origin,
      candidates: profile.candidates,
      apiKey: "sk-secret",
    }),
  );
  assert.deepEqual(calls.map((call) => call.url), ["https://open.bigmodel.cn/api/v1/models"]);
  assert.equal(result.outcome.effectiveBaseUrl, "https://open.bigmodel.cn/api/v1");
  assert.deepEqual(result.outcome.models, [{ modelId: "glm-5.3", displayName: "glm-5.3" }]);
});
