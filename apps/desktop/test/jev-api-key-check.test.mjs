/**
 * Contract test for the TypeSafe key check behind Jev (settings IA, D625).
 *
 * Jev keeps a key only when TypeSafe answered it, so this probe is the gate:
 * it must ask the same address and classifier the Agent's `JevClassify` tool
 * uses, report a refusal with its status, never leak the key into its own
 * message, and answer a hung or unreachable service with a sentence instead
 * of a rejection.
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

test("a refusal without a body still names the status", async () => {
  const { fetch } = recordingFetch(jsonResponse({ ok: false, status: 403 }));
  const result = await probeJevApiKey(KEY, { fetchImpl: fetch });
  assert.deepEqual(result, { ok: false, status: 403, message: "TypeSafe returned 403" });
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
