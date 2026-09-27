import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createImageGenerationTool } = await import("../electron/main/services/image-generation-service.ts");
const { composerModelsForProvider } = await import("../src/lib/composer-models.ts");
const { defaultModelOptions } = await import("../src/components/settings/default-model.ts");
const media = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "MiniMax-H3"];
const platform = {
  id: "platform", vendorKey: "ai-aggregation-platform", name: "Platform",
  baseUrl: "https://ai.yykkj.com/v1", authKind: "api_key_and_base_url",
  enabled: true, hasSecret: true, models: ["chat", ...media].map(id => ({ id })),
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");

for (const stored of [[], platform.models]) {
  test(`GenerateImages works with platform credentials and no separate image binding (${stored.length} stored models)`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "platform-default-media-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const settings = { defaultProviderId: "platform", defaultModelId: "chat" };
    const calls = [];
    const requests = [];
    const host = { async call(method, args) {
      calls.push({ method, args });
      if (method === "settings.get") return settings;
      if (method === "session.get") return { session: { providerId: "platform" } };
      if (method === "providers.get") return { provider: { ...platform, models: stored } };
      if (method === "providers.getSecret") return { value: "fixture-platform-token" };
      if (method === "session.getScratchPath") return { path: join(dataDir, "scratch", "session") };
      throw new Error(method);
    } };
    const tool = createImageGenerationTool({ dataDir, getHost: () => host, fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } });
    const result = await tool({ sessionId: "session", toolCallId: "image", args: { items: [{ prompt: "Starry ocean", count: 2 }] }, signal: new AbortController().signal });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content.modelId, media[0]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, "https://ai.yykkj.com/v1/images/generations");
      assert.equal(request.body.model, media[0]);
      assert.equal(request.body.n, 1);
      assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer fixture-platform-token");
    }
    for (const item of result.content.results) assert.deepEqual(await readFile(item.path), png);
    assert.equal(calls.some(({method}) => method === "settings.set"), false);
    assert.equal(settings.imageGeneration, undefined);
  });
}

test("built-in media models never appear as chat choices without a hidden image binding", () => {
  assert.deepEqual(composerModelsForProvider(platform).map(x => x.modelId), ["chat"]);
  assert.deepEqual(defaultModelOptions([platform]).map(x => x.modelId), ["chat"]);
});

for (const scenario of ["session-account", "missing-key", "disabled", "foreign", "wrong-row", "explicit-default"]) {
  test(`automatic image routing preserves account boundaries: ${scenario}`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "platform-media-account-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const explicit = scenario === "explicit-default";
    const settings = { defaultProviderId: "other", ...(explicit
      ? { imageGeneration: { providerId: "chosen", modelId: "gpt-image-2.5-sunburst" } } : {}) };
    const reads = [];
    const posts = [];
    const host = { async call(method, args) {
      if (method === "settings.get") return settings;
      if (method === "session.get") return { session: { providerId: "session" } };
      if (method === "providers.get") {
        reads.push(args.id);
        return { provider: { ...platform, id: scenario === "wrong-row" ? "other" : args.id,
          enabled: scenario !== "disabled", vendorKey: scenario === "foreign" ? "other" : platform.vendorKey } };
      }
      if (method === "providers.getSecret") {
        reads.push(`secret:${args.id}`);
        return { value: scenario === "missing-key" ? "" : "fixture-platform-key" };
      }
      if (method === "session.getScratchPath") return { path: join(dataDir, "scratch", "session") };
      throw new Error(method);
    } };
    const tool = createImageGenerationTool({ dataDir, getHost: () => host, fetchImpl: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } });
    const call = () => tool({ sessionId: "session", toolCallId: "image", args: { items: [{ prompt: "Ocean" }] }, signal: new AbortController().signal });
    if (scenario === "foreign") await assert.rejects(call(), { errorCode: "PLATFORM_PROVIDER_REQUIRED" });
    else {
      const result = await call();
      const success = scenario === "session-account" || explicit;
      assert.equal(result.ok, success, JSON.stringify(result));
      if (success) {
        assert.equal(result.content.providerId, explicit ? "chosen" : "session");
        assert.equal(posts[0].model, explicit ? media[1] : media[0]);
      }
      if (scenario === "missing-key") assert.equal(result.errorCode, "IMAGE_AUTH_FAILED");
    }
    assert.ok(!reads.includes("other") && !reads.includes("secret:other"));
    if (["foreign", "disabled", "wrong-row"].includes(scenario)) {
      assert.equal(posts.length, 0);
      assert.equal(reads.some(id => id.startsWith("secret:")), false);
    }
  });
}
