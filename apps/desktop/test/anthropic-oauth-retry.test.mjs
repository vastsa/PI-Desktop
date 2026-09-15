import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { VendorOAuth, secretRefForProviderOauth } from "../electron/main/oauth.ts";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CANARY = "fixture-token-must-not-appear-in-errors";
const credential = () => ({ type: "oauth", access: "fixture-old-access", refresh: "fixture-old-refresh", expires: 0 });
const success = { access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, "OAuth fixture timed out"); await pause(5); }
}

function hostFixture() {
  const providers = new Map();
  const secrets = new Map();
  const writes = [];
  let id = 0;
  const call = async (method, input = {}) => {
    switch (method) {
      case "providers.list": return { providers: [...providers.values()].map(row => ({ ...row,
        hasOauth: secrets.has(secretRefForProviderOauth(row.id)) })) };
      case "providers.create": {
        const row = { id: `fixture-${++id}`, ...input };
        providers.set(row.id, row); return { provider: row };
      }
      case "providers.update": {
        Object.assign(providers.get(input.id), input); return { provider: providers.get(input.id) };
      }
      case "providers.delete": providers.delete(input.id); secrets.delete(secretRefForProviderOauth(input.id)); return { ok: true };
      case "secrets.getForRuntime": return { value: secrets.get(input.secretRef) ?? null };
      case "secrets.set": writes.push(input); secrets.set(input.secretRef, input.value); return { ok: true };
      default: throw new Error(`Unexpected fixture RPC ${method}`);
    }
  };
  return { providers, secrets, writes, call };
}

async function fixture(outcomes, run) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ body: JSON.parse(body), headers: req.headers, time: Date.now() });
    const outcome = outcomes[Math.min(requests.length - 1, outcomes.length - 1)];
    if (outcome.hang) return;
    if (outcome.disconnect) { req.socket.destroy(); return; }
    if (outcome.partialBody) { res.writeHead(429); res.write(CANARY); return; }
    const headers = { "Content-Type": "application/json" };
    if (outcome.retryAfter !== undefined) headers["Retry-After"] = outcome.retryAfter;
    res.writeHead(outcome.status ?? 200, headers);
    res.end(outcome.raw ?? JSON.stringify(outcome.body ?? success));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  globalThis.fetch = (input, init) => {
    assert.equal(String(input), TOKEN_URL, "OAuth fixture must never call an external endpoint");
    return originalFetch(`http://127.0.0.1:${server.address().port}/token`, init);
  };
  const host = hostFixture();
  const events = [];
  const oauth = new VendorOAuth({ call: host.call, openExternal: async () => {}, emit: event => {
    events.push(event);
    if (event.kind === "prompt") oauth.respond({ loginId: event.loginId,
      promptId: event.request.promptId, value: "fixture-authorization-code" });
  } });
  const signIn = async () => {
    await oauth.start("anthropic");
    await until(() => events.some(e => ["done", "error", "cancelled"].includes(e.kind)));
    return events.find(e => ["done", "error", "cancelled"].includes(e.kind));
  };
  const seed = () => {
    const row = { id: "saved-account", vendorKey: "anthropic", authKind: "oauth", hasOauth: true,
      headers: { "X-OAuth-Fixture": "preserved" } };
    host.providers.set(row.id, row);
    host.secrets.set(secretRefForProviderOauth(row.id), JSON.stringify(credential()));
    return row.id;
  };
  try { await run({ requests, host, oauth, events, signIn, seed }); }
  finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const limited = (retryAfter = "0") => ({ status: 429, retryAfter,
  body: { error: { type: "rate_limit_error", message: CANARY }, refresh_token: CANARY } });
const safeError = (error) => {
  assert.doesNotMatch(error.message, new RegExp(`${CANARY}|stack=|https://platform|fixture-old`));
};

test("real Anthropic authorization exchange retries 429 and stores one successful grant", async () => {
  await fixture([limited(), {}], async ({ requests, host, signIn }) => {
    const result = await signIn();
    assert.equal(result.kind, "done");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.grant_type, "authorization_code");
    assert.deepEqual(requests[1].body, requests[0].body, "PKCE/code body changed during retry");
    assert.ok(requests[1].time - requests[0].time >= 950);
    assert.equal(host.writes.length, 1);
    assert.equal(JSON.parse(host.writes[0].value).refresh, success.refresh_token);
  });
});

test("real refresh retries inside the provider lock and preserves request headers", async () => {
  await fixture([limited("1"), {}], async ({ requests, host, oauth, seed }) => {
    const id = seed();
    const pending = Promise.all([oauth.resolveAuth(id), oauth.resolveAuth(id)]);
    await until(() => requests.length === 1);
    assert.equal(host.writes.length, 0, "rate limiting must not replace the old credential");
    const auth = await pending;
    assert.ok(auth.every(value => value.apiKey === success.access_token));
    assert.equal(requests.length, 2, "concurrent refresh bypassed the existing store lock");
    assert.equal(requests[0].body.grant_type, "refresh_token");
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.ok(requests.every(req => req.headers["x-oauth-fixture"] === "preserved"));
    assert.equal(host.writes.length, 1);
  });
});

test("429 exhaustion is three attempts with safe recovery text and no stored partial login", async () => {
  await fixture([limited()], async ({ requests, host, signIn }) => {
    const result = await signIn();
    assert.equal(result.kind, "error");
    assert.equal(requests.length, 3);
    assert.ok(requests[2].time - requests[1].time >= 1950);
    assert.match(result.message, /rate limited.*start a new sign-in/i);
    safeError({ message: result.message });
    assert.equal(host.providers.size, 0);
    assert.equal(host.secrets.size, 0);
  });
});

for (const header of ["30", "3600", "9999999999999999999999999999999999999999999999999"]) {
  test(`Retry-After ${header} beyond the total budget is not shortened`, async () => {
    await fixture([limited(header)], async ({ requests, host, oauth, seed }) => {
      const id = seed();
      await assert.rejects(oauth.resolveAuth(id), error => {
        assert.match(error.message, /rate limited.*Wait before retrying/i); safeError(error); return true;
      });
      assert.equal(requests.length, 1);
      assert.equal(host.writes.length, 0);
      assert.deepEqual(JSON.parse(host.secrets.get(secretRefForProviderOauth(id))), credential());
    });
  });
}

test("Retry-After HTTP date is respected by the real token request", async () => {
  const when = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  await fixture([limited(new Date(when).toUTCString()), {}], async ({ requests }) => {
    await anthropicProvider().auth.oauth.refresh(credential(), new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].time >= when);
  });
});

test("malformed Retry-After uses the bounded fallback", async () => {
  await fixture([limited("not-a-date"), {}], async ({ requests }) => {
    await anthropicProvider().auth.oauth.refresh(credential(), new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].time - requests[0].time >= 950);
  });
});

for (const [name, outcome] of [
  ["invalid_grant", { status: 400, body: { error: "invalid_grant", secret: CANARY } }],
  ["invalid_grant even with 429", { status: 429, body: { error: { type: "invalid_grant" }, secret: CANARY } }],
  ["server error", { status: 503, body: { error: CANARY }, retryAfter: "0" }],
  ["invalid success JSON", { status: 200, raw: CANARY }],
  ["ambiguous network disconnect", { disconnect: true }],
]) {
  test(`${name} is never retried`, async () => {
    await fixture([outcome, {}], async ({ requests }) => {
      await assert.rejects(anthropicProvider().auth.oauth.refresh(credential(), new AbortController().signal), error => {
        if (outcome.disconnect) {
          // Network diagnostics are existing behavior; only HTTP/token-body
          // failures gain sanitized recovery text in this patch.
          assert.doesNotMatch(error.message, new RegExp(`${CANARY}|fixture-old`));
        } else {
          safeError(error);
        }
        return true;
      });
      assert.equal(requests.length, 1);
    });
  });
}

for (const [name, outcome] of [["backoff", limited()], ["request", { hang: true }], ["response body", { partialBody: true }]]) {
  test(`caller cancellation stops the ${name} without retrying`, async () => {
    await fixture([outcome, {}], async ({ requests }) => {
      const controller = new AbortController();
      const pending = anthropicProvider().auth.oauth.refresh(credential(), controller.signal);
      await until(() => requests.length === 1);
      controller.abort();
      await assert.rejects(pending, error => error.name === "AbortError");
      assert.equal(requests.length, 1);
    });
  });
}

test("an earlier refresh deadline aborts waiting rather than restarting the 30-second budget", async () => {
  await fixture([limited(), {}], async ({ requests }) => {
    const started = Date.now();
    await assert.rejects(anthropicProvider().auth.oauth.refresh(credential(), AbortSignal.timeout(80)),
      error => error.name === "TimeoutError");
    assert.equal(requests.length, 1);
    assert.ok(Date.now() - started < 1000);
  });
});

test("cancelling the Desktop login during rate-limit wait removes only its new row", async () => {
  await fixture([limited(), {}], async ({ requests, oauth, events, host, seed }) => {
    const existing = seed();
    const { loginId } = await oauth.start("anthropic");
    await until(() => requests.length === 1);
    assert.equal(oauth.cancel(loginId), true);
    await until(() => events.some(event => event.kind === "cancelled"));
    assert.equal(requests.length, 1);
    assert.deepEqual([...host.providers.keys()], [existing]);
    assert.ok(host.secrets.has(secretRefForProviderOauth(existing)));
  });
});


test("a grant rejection after 429 stops immediately rather than exhausting retries", async () => {
  await fixture([limited(), { status: 400, body: { error: "invalid_grant", secret: CANARY } }, {}],
    async ({ requests }) => {
      await assert.rejects(anthropicProvider().auth.oauth.refresh(credential(), new AbortController().signal), error => {
        assert.match(error.message, /rejected the authorization grant/); safeError(error); return true;
      });
      assert.equal(requests.length, 2);
    });
});

test("a failed refresh retains its credential and releases the lock for a later attempt", async () => {
  await fixture([limited("3600"), {}], async ({ requests, host, oauth, seed }) => {
    const id = seed();
    await assert.rejects(oauth.resolveAuth(id), /rate limited/);
    assert.equal(host.writes.length, 0);
    assert.deepEqual(JSON.parse(host.secrets.get(secretRefForProviderOauth(id))), credential());
    const auth = await oauth.resolveAuth(id);
    assert.equal(auth.apiKey, success.access_token);
    assert.equal(requests.length, 2);
    assert.equal(host.writes.length, 1);
  });
});
