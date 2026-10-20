import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createProviderMetadataFetch } = await import("../electron/main/provider-metadata-fetch.ts");

const url = "https://provider.example/v1/models";
const options = () => ({ headers: { Authorization: "Bearer fixture" }, redirect: "manual", signal: new AbortController().signal });
const certificateError = () => new Error("net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED");

test("optional client certificate failure retries the same metadata request once", async () => {
  const init = options();
  const transport = createProviderMetadataFetch(async (target, request) => {
    assert.equal(target, url);
    assert.equal(request, init);
    throw certificateError();
  }, async (target, request) => {
    assert.equal(target, url);
    assert.equal(request, init);
    return new Response('{"data":[{"id":"fixture-model"}]}');
  });
  assert.deepEqual(await (await transport(url, init)).json(), { data: [{ id: "fixture-model" }] });
});

test("HTTP responses and unrelated TLS/network errors never use the fallback", async () => {
  const forbidden = () => { assert.fail("unexpected fallback"); };
  for (const status of [200, 401, 403, 429, 500]) {
    const response = new Response("", { status });
    assert.equal(await createProviderMetadataFetch(async () => response, forbidden)(url, options()), response);
  }
  for (const message of ["net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CERT_COMMON_NAME_INVALID", "net::ERR_CONNECTION_RESET", "net::ERR_TIMED_OUT", "net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED_SUFFIX"]) {
    const error = new Error(message);
    await assert.rejects(createProviderMetadataFetch(async () => { throw error; }, forbidden)(url, options()), (actual) => actual === error);
  }
});

test("fallback failures propagate without another retry", async () => {
  const failure = new Error("client certificate required by server");
  await assert.rejects(createProviderMetadataFetch(async () => { throw certificateError(); }, async () => { throw failure; })(url, options()), (error) => error === failure);
});

test("an aborted request cannot start a second transport", async () => {
  const controller = new AbortController();
  const transport = createProviderMetadataFetch(async () => {
    controller.abort();
    throw certificateError();
  }, () => { assert.fail("aborted retry"); });
  await assert.rejects(transport(url, { ...options(), signal: controller.signal }), { name: "AbortError" });
});

test("non-metadata methods and non-HTTPS URLs cannot be replayed", async () => {
  const error = certificateError();
  const transport = createProviderMetadataFetch(async () => { throw error; }, () => { assert.fail("unsafe replay"); });
  for (const method of ["POST", "PUT", "DELETE"]) {
    await assert.rejects(transport(url, { ...options(), method }), (actual) => actual === error);
  }
  await assert.rejects(transport("http://provider.example/models", options()), (actual) => actual === error);
});
