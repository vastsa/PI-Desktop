/**
 * Contract tests for the non-persisting Jev System One credential check.
 *
 * The probe must ask the same normalized endpoint and exact classifier id the
 * Agent's `JevClassify` tool uses, report refusals with status, never leak the
 * key, refuse cross-origin credential redirects, and bound silent services.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JEV_PROBE_TIMEOUT_MS, probeJevApiKey } from "../electron/main/jev-probe.ts";
import {
  TYPESAFE_JEV_MODEL_ID,
  TYPESAFE_SYSTEM_ONE_URL,
} from "../../../packages/shared/src/secret-refs.ts";

const KEY = "typesafe-fixture-key";

/** A fetch stand-in that records the one request it received. */
function recordingFetch(response) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return typeof response === "function" ? response(url, init) : response;
    },
  };
}

function jsonResponse({ ok, status, body = "" }) {
  return {
    ok,
    status,
    text: async () => body,
  };
}

test("the check asks the System One endpoint the classifier tool uses", async () => {
  const { calls, fetch } = recordingFetch(jsonResponse({ ok: true, status: 200 }));
  const result = await probeJevApiKey(KEY, { fetchImpl: fetch });

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TYPESAFE_SYSTEM_ONE_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.ok(calls[0].init.signal, "the request carries an abort signal");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, TYPESAFE_JEV_MODEL_ID);
  assert.equal(Object.keys(body.questions).length, 1);
  const [question] = Object.values(body.questions);
  assert.equal(question.type, "noul");
  assert.deepEqual(Object.keys(question.criteria), ["true", "false"]);
});

test("legacy empty options still use the official binding", async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetch } = recordingFetch(jsonResponse({ ok: true, status: 200 }));
  globalThis.fetch = fetch;
  try {
    const result = await probeJevApiKey(KEY, {});
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(calls[0].url, TYPESAFE_SYSTEM_ONE_URL);
    assert.equal(JSON.parse(calls[0].init.body).model, TYPESAFE_JEV_MODEL_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a trimmed key is what travels, and a blank key sends nothing", async () => {
  const { calls, fetch } = recordingFetch(jsonResponse({ ok: true, status: 200 }));
  await probeJevApiKey(`  ${KEY}  `, { fetchImpl: fetch });
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);

  const blank = recordingFetch(jsonResponse({ ok: true, status: 200 }));
  const result = await probeJevApiKey("   ", { fetchImpl: blank.fetch });
  assert.equal(result.ok, false);
  assert.deepEqual(blank.calls, [], "a blank key must not reach the network");
});

test("a refused key reports TypeSafe's status without repeating the key", async () => {
  const { fetch } = recordingFetch(
    jsonResponse({ ok: false, status: 401, body: `invalid api key ${KEY}` }),
  );
  const result = await probeJevApiKey(KEY, { fetchImpl: fetch });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /401/);
  assert.ok(!result.message.includes(KEY), "the key must not be echoed back");
  assert.match(result.message, /\[redacted\]/);
});

test("a long key is redacted before provider detail is truncated", async () => {
  const longKey = `fixture-${"k".repeat(400)}`;
  const { fetch } = recordingFetch(
    jsonResponse({ ok: false, status: 401, body: `invalid api key ${longKey}` }),
  );
  const result = await probeJevApiKey(longKey, { fetchImpl: fetch });

  assert.equal(result.ok, false);
  assert.match(result.message, /\[redacted\]/);
  assert.ok(!result.message.includes(longKey.slice(0, 80)));
});

test("a refusal without a body still names the status", async () => {
  const { fetch } = recordingFetch(jsonResponse({ ok: false, status: 403 }));
  const result = await probeJevApiKey(KEY, { fetchImpl: fetch });
  assert.deepEqual(result, { ok: false, status: 403, message: "System One returned 403" });
});

test("a custom root and full operation use one /systemone with the exact model id", async () => {
  for (const baseUrl of [
    "https://openrouter.test/api/v1",
    "https://openrouter.test/api/v1/systemone/",
  ]) {
    const { calls, fetch } = recordingFetch(jsonResponse({ ok: true, status: 200 }));
    const asserted = [];
    const result = await probeJevApiKey(KEY, {
      baseUrl,
      modelId: "~typesafe/jev-latest",
    }, {
      fetchImpl: fetch,
      assertEndpoint: async (url) => asserted.push(url),
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://openrouter.test/api/v1/systemone");
    assert.deepEqual(asserted, ["https://openrouter.test/api/v1/systemone"]);
    assert.equal(JSON.parse(calls[0].init.body).model, "~typesafe/jev-latest");
  }
});

test("a credential-bearing redirect cannot leave the configured origin", async () => {
  const { calls, fetch } = recordingFetch(new Response(null, {
    status: 307,
    headers: { location: "https://attacker.test/systemone" },
  }));
  const result = await probeJevApiKey(KEY, {
    baseUrl: "https://openrouter.test/api/v1",
    modelId: "~typesafe/jev-latest",
  }, { fetchImpl: fetch });
  assert.equal(result.ok, false);
  assert.match(result.message, /left the configured origin/);
  assert.equal(calls.length, 1);
  assert.ok(!result.message.includes(KEY));
});

test("an unreachable service answers with a message, not a rejection", async () => {
  const { fetch } = recordingFetch(() => {
    throw new Error(`connect ECONNREFUSED ${KEY}`);
  });
  const result = await probeJevApiKey(KEY, { fetchImpl: fetch });
  assert.equal(result.ok, false);
  assert.equal(result.status, undefined);
  assert.ok(!result.message.includes(KEY), "a transport error must not leak the key");
});

test("a silent service is reported as a timeout", async () => {
  const { fetch } = recordingFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        });
      }),
  );
  const result = await probeJevApiKey(KEY, { fetchImpl: fetch, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.message, /did not answer/);
  assert.ok(!result.message.includes(KEY));
});

test("the default timeout is bounded", () => {
  assert.ok(JEV_PROBE_TIMEOUT_MS > 0 && JEV_PROBE_TIMEOUT_MS <= 60_000);
});
