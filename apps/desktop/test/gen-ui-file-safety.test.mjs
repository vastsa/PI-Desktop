import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import fs from "node:fs/promises";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "data:text/javascript,export const protocol = {};", shortCircuit: true };
    return next(specifier, context);
  }
`)}`);
const { createGenUiFragmentReader } = await import("../electron/main/gen-ui-files.ts");
const { resolveGenUiRequest, genUiResponse } = await import("../electron/main/gen-ui-protocol.ts");
const { GEN_UI_MAX_FRAGMENT_BYTES } = await import("@pi-desktop/shared");
const location = { sessionId: "session", fileName: "chart.html" };
const wire = (text) => ({ ok: true, base64: Buffer.from(text).toString("base64") });
const unavailable = { ok: false, status: 500, code: "runtime-unavailable" };

// Filesystem regressions live with the real native directory-capability reader.
// This suite mocks only that external Host boundary, never a second file policy.
test("the protocol asks the native Host for identity only and enforces response sandbox", async () => {
  const calls = [];
  const readFragment = createGenUiFragmentReader(() => ({
    async call(method, args, timeout) {
      calls.push({ method, args, timeout });
      return wire("<p>chart</p>");
    },
  }));
  const result = await resolveGenUiRequest({
    method: "GET", url: "pi-genui://session/session/chart.html", readFragment,
    loadKit: async () => ({ css: "", head: "", runtime: "", vendorUrls: new Map(), vendorFiles: new Map() }),
  });
  assert.equal(result.ok, true);
  assert.match(result.document, /<p>chart<\/p>/);
  assert.deepEqual(calls, [{ method: "visualizations.readFragment", args: location, timeout: 5_000 }]);
  for (const value of [result, { ok: false, status: 404, code: "not-found" }]) {
    const response = genUiResponse(value);
    assert.match(response.headers.get("content-security-policy"), /(?:^|; )sandbox allow-scripts(?:;|$)/);
    assert.doesNotMatch(await response.text(), /<meta[^>]+content="[^"]*sandbox /);
  }
});

test("invalid identities cannot reach a native Host or name an absolute file", async () => {
  let calls = 0;
  const read = createGenUiFragmentReader(() => ({ async call() { calls += 1; return wire("bad"); } }));
  for (const input of [
    { sessionId: "../other", fileName: "chart.html" }, { sessionId: "session", fileName: "/private/chart.html" },
    { sessionId: "session", fileName: "..\\chart.html" }, { sessionId: "session", fileName: "chart.txt" },
  ]) assert.deepEqual(await read(input), { ok: false, status: 404, code: "not-found" });
  assert.equal(calls, 0);
});

test("fixed native errors map to the existing public card failures", async () => {
  for (const [code, status] of [["not-found", 404], ["too-large", 413]]) {
    const read = createGenUiFragmentReader(() => ({ async call() { return { ok: false, code }; } }));
    assert.deepEqual(await read(location), { ok: false, status, code });
  }
});

test("malformed native replies fail closed and never log bytes or filesystem paths", async (t) => {
  const diagnostics = [];
  t.mock.method(console, "warn", (...args) => diagnostics.push(args));
  for (const result of [
    null, [], { ok: true }, { ok: true, base64: "!!!!" }, { ok: true, base64: "AB==" },
    { ok: false, code: "not-found", path: "/private/DO_NOT_PRINT" },
    { ok: true, base64: "A".repeat(Math.ceil(GEN_UI_MAX_FRAGMENT_BYTES / 3) * 4 + 4) },
  ]) {
    const read = createGenUiFragmentReader(() => ({ async call() { return result; } }));
    assert.deepEqual(await read(location), unavailable);
  }
  assert.ok(diagnostics.length > 0, "unexpected boundary failures remain observable");
  assert.doesNotMatch(JSON.stringify(diagnostics), /DO_NOT_PRINT|!!!!|AB==/);
});

test("byte limits apply after base64 decode and do not depend on JSON expansion", async () => {
  for (const size of [0, GEN_UI_MAX_FRAGMENT_BYTES, GEN_UI_MAX_FRAGMENT_BYTES + 1]) {
    const read = createGenUiFragmentReader(() => ({ async call() { return wire(Buffer.alloc(size)); } }));
    const result = await read(location);
    if (size <= GEN_UI_MAX_FRAGMENT_BYTES) {
      assert.equal(result.ok, true);
      assert.equal(result.fragment.length, size);
    } else assert.deepEqual(result, { ok: false, status: 413, code: "too-large" });
  }
});

test("restart and relocation switch the Host without retaining a stale reader", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  let current = { async call() { return wire("old profile"); } };
  const read = createGenUiFragmentReader(() => current);
  assert.deepEqual(await read(location), { ok: true, fragment: "old profile" });
  current = null;
  assert.deepEqual(await read(location), unavailable);
  current = { async call() { return wire("new profile"); } };
  assert.deepEqual(await read(location), { ok: true, fragment: "new profile" });
  current = { async call() { throw new Error("/private/transport-failure"); } };
  assert.deepEqual(await read(location), unavailable);
});

test("Main has no local filesystem fallback when reading a native fragment", async (t) => {
  let fileOperations = 0;
  for (const name of ["lstat", "realpath", "open", "readFile"]) {
    t.mock.method(fs, name, () => { fileOperations += 1; throw new Error("Main must not reopen fragment paths"); });
  }
  const read = createGenUiFragmentReader(() => ({ async call() { return wire("native bytes"); } }));
  assert.deepEqual(await read(location), { ok: true, fragment: "native bytes" });
  assert.equal(fileOperations, 0);
});
