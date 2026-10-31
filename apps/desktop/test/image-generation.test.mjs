import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createImageGenerationTool } = await import(
  "../electron/main/services/image-generation-service.ts"
);
const { imageInputLoader } = await import("../electron/main/services/image-inputs.ts");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);

test("configure, batch generate, edit a result, replace binding, clear; files survive service recreation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-images-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("latin1");
    requests.push({ url: request.url, body, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let settings = {
    defaultModelId: "chat",
    defaultProviderId: "chat-provider",
    imageGeneration: { providerId: "image-provider", modelId: "image-one" },
  };
  const host = {
    call: async (method) => {
      if (method === "settings.get") return structuredClone(settings);
      if (method === "providers.get")
        return {
          provider: {
            id: "image-provider",
            enabled: true,
            authKind: "api_key_and_base_url",
            models: [{ id: "image-one" }, { id: "image-two" }],
            baseUrl: `http://127.0.0.1:${server.address().port}`,
          },
        };
      if (method === "providers.getSecret") return { value: "fixture-key" };
      if (method === "session.getScratchPath") return { path: join(dataDir, "scratch", "session") };
      if (method === "session.get") return { session: {} };
      throw new Error(method);
    },
  };
  const options = { dataDir, getHost: () => host };
  const call = (args) =>
    createImageGenerationTool(options)({
      sessionId: "session",
      toolCallId: "call",
      args,
      signal: new AbortController().signal,
    });
  const batch = await call({ items: [{ prompt: "cover", count: 2 }, { prompt: "icon" }] });
  assert.equal(batch.ok, true);
  assert.equal(batch.content.results.length, 3);
  for (const image of batch.content.results) assert.deepEqual(await readFile(image.path), png);
  assert.ok(
    requests.every(
      (request) =>
        request.url === "/v1/images/generations" && request.authorization === "Bearer fixture-key",
    ),
  );
  const original = batch.content.results[0].path;
  const edited = await call({ items: [{ prompt: "make it green", images: [original], count: 2 }] });
  assert.equal(edited.content.results.length, 2);
  assert.ok(
    requests
      .slice(3)
      .every(
        (request) => request.url === "/v1/images/edits" && request.body.includes('name="image"'),
      ),
  );
  assert.notEqual(edited.content.results[0].path, original);
  assert.deepEqual(await readFile(original), png);
  settings.imageGeneration = { providerId: "image-provider", modelId: "image-two" };
  await call({ items: [{ prompt: "replacement" }] });
  assert.equal(JSON.parse(requests.at(-1).body).model, "image-two");
  settings.imageGeneration = null;
  assert.equal((await call({ items: [{ prompt: "unset" }] })).errorCode, "IMAGE_NOT_CONFIGURED");
  assert.equal(requests.length, 6);
  assert.equal(settings.defaultModelId, "chat");
});

test("edit inputs reject outside paths, traversal and non-image files", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-image-input-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const scratchPath = join(dataDir, "scratch", "s");
  await mkdir(scratchPath, { recursive: true });
  await writeFile(join(dataDir, "outside.png"), png);
  await writeFile(join(scratchPath, "fake.png"), "not an image");
  const load = imageInputLoader({ dataDir, scratchPath });
  await assert.rejects(load([join(dataDir, "outside.png")]), /outside/);
  await assert.rejects(load(["../../outside.png"]), /outside/);
  await assert.rejects(load(["fake.png"]), /IMAGE_INVALID_CONTENT/);
});

test("the default imagegen skill is discoverable and loads in an ordinary session", async () => {
  const {
    assertBuiltinSkillEnabled,
    builtinSkillCatalog,
    builtinSkills,
    loadBuiltinSkillBody,
  } = await import("../electron/main/builtin-skills.ts");
  const catalogIds = builtinSkillCatalog().map((skill) => skill.id);
  assert.ok(catalogIds.includes("pi-desktop/imagegen"));
  assert.ok(catalogIds.includes("pi-desktop/plugin-development"));
  const skills = builtinSkills({});
  assert.equal(skills.find((skill) => skill.id === "pi-desktop/imagegen")?.name, "imagegen");
  assert.ok(!skills.some((skill) => skill.id === "pi-desktop/plugin-development"));
  const pluginSkills = builtinSkills({
    workspacePath: "/repo",
    pluginPaths: ["/repo/example-plugin"],
    disabledIds: ["pi-desktop/imagegen"],
  });
  assert.ok(!pluginSkills.some((skill) => skill.id === "pi-desktop/imagegen"));
  assert.ok(pluginSkills.some((skill) => skill.id === "pi-desktop/plugin-development"));
  await assert.rejects(
    assertBuiltinSkillEnabled("pi-desktop/imagegen", async () => ["pi-desktop/imagegen"]),
    /disabled in Settings/,
  );
  let queriedActivation = false;
  await assertBuiltinSkillEnabled("plugin/review", async () => {
    queriedActivation = true;
    return ["pi-desktop/imagegen"];
  });
  assert.equal(queriedActivation, false);
  const body = loadBuiltinSkillBody("pi-desktop/imagegen").body;
  assert.match(body, /GenerateImages/);
  assert.match(body, /previous result path/);
  assert.match(body, /Do not retry/);
  assert.match(body, /desktop renders successful images directly from the tool result/i);
  assert.match(body, /Do not repeat those result paths as Markdown image links/i);
  assert.equal(loadBuiltinSkillBody("../../outside"), null);
});

/** The user path for a ChatGPT (Codex) login: pick its image model, then generate. */
test("a signed-in Codex account generates and edits through its own image routes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-images-codex-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    requests.push({
      url: request.url,
      body,
      authorization: request.headers.authorization,
      originator: request.headers.originator,
      contentType: request.headers["content-type"],
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = {
    call: async (method) => {
      if (method === "settings.get")
        return {
          defaultModelId: "gpt-6.1-sol",
          defaultProviderId: "codex-account",
          imageGeneration: { providerId: "codex-account", modelId: "gpt-image-2.5" },
        };
      if (method === "providers.get")
        return {
          provider: {
            id: "codex-account",
            enabled: true,
            authKind: "oauth",
            hasOauth: true,
            vendorKey: "openai-codex",
            // The account's chat models; its image model is not one of them.
            models: [{ id: "gpt-6.1-sol" }],
            baseUrl: `http://127.0.0.1:${server.address().port}/backend-api`,
          },
        };
      if (method === "session.getScratchPath") return { path: join(dataDir, "scratch", "session") };
      if (method === "session.get") return { session: {} };
      throw new Error(method);
    },
  };
  const call = (args) =>
    createImageGenerationTool({
      dataDir,
      getHost: () => host,
      resolveAuth: async () => ({ apiKey: "chatgpt-account-token" }),
    })({ sessionId: "session", toolCallId: "call", args, signal: new AbortController().signal });

  const batch = await call({ items: [{ prompt: "cover" }] });
  assert.equal(batch.ok, true);
  assert.deepEqual(await readFile(batch.content.results[0].path), png);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/backend-api/codex/images/generations");
  assert.equal(requests[0].authorization, "Bearer chatgpt-account-token");
  assert.equal(requests[0].originator, "pi");
  assert.deepEqual(JSON.parse(requests[0].body), { model: "gpt-image-2.5", prompt: "cover", size: "auto" });

  const edited = await call({
    items: [{ prompt: "make it blue", images: [batch.content.results[0].path] }],
  });
  assert.equal(edited.ok, true);
  assert.equal(requests.at(-1).url, "/backend-api/codex/images/edits");
  assert.equal(requests.at(-1).contentType, "application/json");
  assert.match(requests.at(-1).body, /"image_url":"data:image\/png;base64,/);
});

test("a Codex image binding without a signed-in credential is refused", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-images-codex-empty-"));
  await rm(dataDir, { recursive: true, force: true });
  const host = {
    call: async (method) => {
      if (method === "settings.get")
        return { imageGeneration: { providerId: "codex-account", modelId: "gpt-image-2" } };
      if (method === "providers.get")
        return {
          provider: {
            id: "codex-account",
            enabled: true,
            authKind: "oauth",
            hasOauth: false,
            vendorKey: "openai-codex",
            models: [],
            baseUrl: "https://chatgpt.example/backend-api",
          },
        };
      throw new Error(method);
    },
  };
  const result = await createImageGenerationTool({ dataDir, getHost: () => host })({
    sessionId: "session",
    toolCallId: "call",
    args: { items: [{ prompt: "cover" }] },
    signal: new AbortController().signal,
  });
  assert.equal(result.errorCode, "IMAGE_MODEL_UNAVAILABLE");
});
