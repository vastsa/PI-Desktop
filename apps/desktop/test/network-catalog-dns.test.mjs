import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

// Call the production catalog entry points with their real policy/scanner wiring.
// Only native resolution, session routing and HTTP I/O are replaced; no OS DNS
// lookup or external request is allowed, including on the pre-integration code.
function fixture(kind, { address = "93.184.216.34", redirect, lookupError } = {}) {
  const lookups = [];
  const connections = [];
  const systemLookups = [];
  const body = JSON.stringify(kind === "mcp" ? { servers: [] } : { skills: [] });
  const nativeLookup = async (host) => {
    lookups.push(host);
    if (lookupError && host === "catalog.doh.invalid") throw new Error("native resolver unavailable");
    if (isIP(host)) return [{ address: host, family: isIP(host) }];
    return [{ address, family: isIP(address) }];
  };
  const responseFor = (url) => new Response(body, {
    status: redirect && url.includes("catalog.doh.invalid") ? 302 : 200,
    headers: redirect && url.includes("catalog.doh.invalid") ? { location: redirect } : {},
  });
  const pinnedFetch = async (url, _init, pinned) => {
    connections.push({ url, pinned });
    return responseFor(url);
  };
  const request = (options, receive) => {
    connections.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => { if (error) req.emit("error", error); };
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      const redirects = redirect && options.headers.Host === "catalog.doh.invalid";
      response.statusCode = redirects ? 302 : 200;
      response.headers = redirects ? { location: redirect } : {};
      response.resume = () => {};
      receive(response);
      response.emit("data", Buffer.from(body));
      response.emit("end");
    });
    return req;
  };
  const boundaries = {
    "@pi-desktop/shared": shared,
    "node:net": { isIP },
    "node:dns/promises": { lookup: async (host) => {
      systemLookups.push(host);
      throw new Error("system lookup is forbidden in the catalog fixture");
    } },
    "node:https": { request },
    "node:http": { request },
    electron: {
      session: { defaultSession: { resolveProxy: async () => "DIRECT" } },
      net: { fetch: async (url) => {
        connections.push({ url, nativeSession: true });
        return responseFor(url);
      } },
    },
    "./network-proxy": { lookupDesktopHost: nativeLookup },
    "./public-https-direct": { fetchPinnedDirect: pinnedFetch },
    "./endpoint-policy": {
      allowInsecureUserEndpointsEnabled: () => false,
      noteInsecureUserEndpoint() {},
      relaxedNetworkPolicyEnabled: () => false,
    },
  };
  const modules = new Map();
  const load = (name) => {
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} };
    modules.set(name, module.exports);
    const source = readFileSync(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: `${name}.ts`,
    });
    new Function("require", "exports", "module", outputText)((specifier) => {
      if (Object.hasOwn(boundaries, specifier)) return boundaries[specifier];
      if (["./public-https-fetch", "./skill-market-scan"].includes(specifier)) return load(specifier.slice(2));
      throw new Error(`Unexpected catalog dependency: ${specifier}`);
    }, module.exports, module);
    modules.set(name, module.exports);
    return module.exports;
  };
  const catalog = load(kind === "mcp" ? "mcp-registry-catalog" : "skill-market-catalog");
  const source = { id: "native-dns", name: "Native DNS", kind: "catalog", url: "https://catalog.doh.invalid/catalog.json" };
  return {
    get lookups() { return lookups.filter((host) => host === "catalog.doh.invalid"); },
    get connections() { return connections.filter((item) => item.url?.includes("catalog.doh.invalid") || item.headers?.Host === "catalog.doh.invalid"); },
    systemLookups,
    search: () => kind === "mcp"
      ? catalog.searchMcpMarket("", [source])
      : catalog.searchSkillMarket("", [source]),
  };
}

for (const kind of ["mcp", "skill"]) {
  test(`${kind} catalog resolves through Desktop and retains its direct transport`, async () => {
    const f = fixture(kind);
    const result = await f.search();
    assert.deepEqual(result.failedSources, []);
    assert.deepEqual(f.lookups, ["catalog.doh.invalid"]);
    assert.deepEqual(f.systemLookups, []);
    assert.equal(f.connections.length, 1);
    if (kind === "mcp") {
      assert.equal(f.connections[0].hostname, "93.184.216.34");
      assert.equal(f.connections[0].servername, "catalog.doh.invalid");
      assert.equal(f.connections[0].headers.Host, "catalog.doh.invalid");
    } else {
      assert.deepEqual(f.connections[0], { url: "https://catalog.doh.invalid/catalog.json", nativeSession: true });
    }
  });

  test(`${kind} catalog never falls back after native lookup failure`, async () => {
    const f = fixture(kind, { lookupError: true });
    assert.equal((await f.search()).failedSources.length, 1);
    assert.deepEqual([...new Set(f.lookups)], ["catalog.doh.invalid"]);
    assert.deepEqual(f.systemLookups, []);
    assert.deepEqual(f.connections, []);
  });

  test(`${kind} catalog revalidates native DNS answers on a redirect`, async () => {
    const f = fixture(kind, { redirect: "https://127.0.0.1/redirect.json" });
    assert.equal((await f.search()).failedSources.length, 1);
    assert.deepEqual(f.lookups, ["catalog.doh.invalid"]);
    assert.deepEqual(f.systemLookups, []);
    assert.equal(f.connections.length, 1, "redirects must not escape the public-address policy");
  });
}
