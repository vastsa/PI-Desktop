import assert from "node:assert/strict";
import test from "node:test";
import { createNetworkDnsController } from "../electron/main/network-dns.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const configs = [];
  const queries = [];
  const systemQueries = [];
  let clears = 0;
  const controller = createNetworkDnsController({
    platform: "win32",
    configureHostResolver: (config) => configs.push(config),
    clearHostResolverCache: async () => { clears += 1; },
    resolveHost: async (host, options) => {
      queries.push({ host, options });
      return { endpoints: [{ address: "203.0.113.10", family: "ipv4" }] };
    },
    systemLookup: async (host, family) => {
      systemQueries.push({ host, family });
      return [{ address: "192.0.2.10", family: 4 }];
    },
    ...overrides,
  });
  return { controller, configs, queries, systemQueries, clears: () => clears };
}

const enabled = { mode: "doh", serverUrl: "https://1.1.1.1/dns-query" };

test("disabled startup never overrides Chromium and keeps the system lookup", async () => {
  const f = fixture();
  await f.controller.apply(undefined);
  assert.deepEqual(await f.controller.lookupAll("provider.example"), [{ address: "192.0.2.10", family: 4 }]);
  assert.deepEqual(f.configs, []);
  assert.equal(f.clears(), 0);
  assert.equal(f.queries.length, 0);
  assert.equal(f.systemQueries.length, 1);
});

test("opt-in configures secure native DNS and supplies addresses to socket lookup", async () => {
  const f = fixture();
  await f.controller.apply(enabled);
  const addresses = await new Promise((resolve, reject) => {
    f.controller.lookup("provider.example", { all: true }, (error, result) => error ? reject(error) : resolve(result));
  });
  assert.deepEqual(addresses, [{ address: "203.0.113.10", family: 4 }]);
  assert.deepEqual(f.configs, [{ enableBuiltInResolver: true, secureDnsMode: "secure", secureDnsServers: [enabled.serverUrl] }]);
  assert.equal(f.clears(), 1);
  assert.deepEqual(f.queries[0], { host: "provider.example", options: { secureDnsPolicy: "allow" } });
  assert.equal(f.systemQueries.length, 0);
});

test("plaintext fallback requires an explicit opt-in", async () => {
  const f = fixture();
  await f.controller.apply({ ...enabled, allowSystemFallback: true });
  assert.equal(f.configs[0].secureDnsMode, "automatic");
});

test("equivalent settings writes do not invalidate the native cache", async () => {
  const f = fixture();
  await f.controller.apply(enabled);
  await f.controller.apply({ ...enabled, allowSystemFallback: false });
  assert.equal(f.configs.length, 1);
  assert.equal(f.clears(), 1);
});

test("disabled endpoint preferences do not override platform DNS", async () => {
  const f = fixture();
  await f.controller.apply({ ...enabled, mode: "system", allowSystemFallback: true });
  assert.equal(f.configs.length, 0);
  assert.equal(f.clears(), 0);
  assert.equal(f.controller.current().serverUrl, enabled.serverUrl);
});

for (const [platform, builtIn] of [["win32", false], ["linux", false], ["darwin", true]]) {
  test(`disabling restores Chromium defaults on ${platform}`, async () => {
    const f = fixture({ platform });
    await f.controller.apply(enabled);
    await f.controller.apply({ mode: "system" });
    assert.deepEqual(f.configs[1], { enableBuiltInResolver: builtIn, secureDnsMode: "automatic", secureDnsServers: [] });
    assert.equal(f.clears(), 2);
    await f.controller.lookupAll("provider.example");
    assert.equal(f.systemQueries.length, 1);
  });
}

test("a configuration switch rejects an old lookup before its late completion", async () => {
  const pending = deferred();
  const started = deferred();
  const f = fixture({ resolveHost: () => { started.resolve(); return pending.promise; } });
  await f.controller.apply(enabled);
  const result = f.controller.lookupAll("provider.example");
  await started.promise;
  const rejected = assert.rejects(result, { code: "EAI_AGAIN" });
  await f.controller.apply({ ...enabled, serverUrl: "https://8.8.8.8/dns-query" });
  await rejected;
  pending.resolve({ endpoints: [{ address: "203.0.113.20", family: "ipv4" }] });
  assert.equal(f.clears(), 2);
});

test("lookups wait until the ordered native configuration and cache clear finish", async () => {
  const firstClear = deferred();
  const clearing = deferred();
  let clears = 0;
  const f = fixture({ clearHostResolverCache: async () => {
    clears += 1;
    if (clears === 1) { clearing.resolve(); await firstClear.promise; }
  } });
  const first = f.controller.apply(enabled);
  await clearing.promise;
  const second = f.controller.apply({ ...enabled, allowSystemFallback: true });
  const lookup = f.controller.lookupAll("provider.example");
  assert.equal(f.queries.length, 0);
  firstClear.resolve();
  await Promise.all([first, second, lookup]);
  assert.deepEqual(f.configs.map((c) => c.secureDnsMode), ["secure", "automatic"]);
  assert.equal(f.queries.length, 1);
});

test("a stuck native lookup times out without falling back to system DNS", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred();
  const f = fixture({ resolveHost: () => { started.resolve(); return new Promise(() => {}); } });
  await f.controller.apply(enabled);
  const result = f.controller.lookupAll("provider.example");
  await started.promise;
  const rejected = assert.rejects(result, { code: "ETIMEOUT" });
  t.mock.timers.tick(10_001);
  await rejected;
  assert.equal(f.systemQueries.length, 0);
});

test("caller cancellation rejects promptly and ignores the late resolver response", async () => {
  const started = deferred();
  const pending = deferred();
  const f = fixture({ resolveHost: () => { started.resolve(); return pending.promise; } });
  await f.controller.apply(enabled);
  const abort = new AbortController();
  const result = f.controller.lookupAll("provider.example", { signal: abort.signal });
  await started.promise;
  const rejected = assert.rejects(result, { name: "AbortError" });
  abort.abort();
  await rejected;
  pending.resolve({ endpoints: [] });
});

test("native resolver failure is observable and never silently falls back", async () => {
  const f = fixture({ resolveHost: async () => { throw Object.assign(new Error("native lookup failed"), { code: "ENOTFOUND" }); } });
  await f.controller.apply(enabled);
  await assert.rejects(f.controller.lookupAll("provider.example"), { code: "ENOTFOUND" });
  assert.equal(f.systemQueries.length, 0);
});

test("a failed configuration blocks new lookups until a successful reapply", async () => {
  let fail = true;
  const f = fixture({ configureHostResolver: () => { if (fail) throw new Error("native configuration failed"); } });
  await assert.rejects(f.controller.apply(enabled), /native configuration failed/);
  await assert.rejects(f.controller.lookupAll("provider.example"), /native configuration failed/);
  fail = false;
  await f.controller.apply(enabled);
  assert.equal((await f.controller.lookupAll("provider.example")).length, 1);
});

test("socket lookup requests the selected address family and validates native answers", async () => {
  const queries = [];
  const f = fixture({ resolveHost: async (_host, options) => {
    queries.push(options);
    return { endpoints: [
      { address: "invalid", family: "ipv6" },
      { address: "203.0.113.10", family: "ipv4" },
      { address: "2001:db8::1", family: "ipv6" },
      { address: "2001:db8::1", family: "ipv6" },
    ] };
  } });
  await f.controller.apply(enabled);
  const result = await new Promise((resolve, reject) => {
    f.controller.lookup("provider.example", { family: 6 }, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  assert.deepEqual(result, { address: "2001:db8::1", family: 6 });
  assert.deepEqual(queries, [{ queryType: "AAAA", secureDnsPolicy: "allow" }]);
});

test("empty native answers fail closed", async () => {
  const f = fixture({ resolveHost: async () => ({ endpoints: [] }) });
  await f.controller.apply(enabled);
  await assert.rejects(f.controller.lookupAll("provider.example"), { code: "ENOTFOUND" });
});

test("dispose cancels pending resolution and prevents new lookups", async () => {
  const started = deferred();
  const f = fixture({ resolveHost: () => { started.resolve(); return new Promise(() => {}); } });
  await f.controller.apply(enabled);
  const result = f.controller.lookupAll("provider.example");
  await started.promise;
  const rejected = assert.rejects(result, { code: "ECANCELED" });
  f.controller.dispose();
  await rejected;
  await assert.rejects(f.controller.lookupAll("provider.example"), { code: "ECANCELED" });
});
