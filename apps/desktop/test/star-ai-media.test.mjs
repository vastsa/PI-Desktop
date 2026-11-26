import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  parseVideoGenerationInput,
  STARAI_DEFAULT_IMAGE_MODEL,
  STARAI_DEFAULT_VIDEO_MODEL,
  STARAI_PROVIDER_ID,
} = await import("@pi-desktop/shared");
const { createImageGenerationTool } = await import("../electron/main/services/image-generation-service.ts");
const { createVideoGenerationTool } = await import("../electron/main/services/video-generation-service.ts");
const { runStarAiStudioGeneration } = await import("../electron/main/services/star-ai-studio-media.ts");
const { generatedMediaUrlFromScratchRoot } = await import("../electron/main/services/star-ai-media-url.ts");

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
]);

test("parseVideoGenerationInput defaults to minimax_h3_768p and validates fields", () => {
  const parsed = parseVideoGenerationInput({
    prompt: "Camera slowly orbits a glowing star sculpture",
    images: ["frame.png"],
    seconds: 6,
  });
  assert.equal(parsed.model, STARAI_DEFAULT_VIDEO_MODEL);
  assert.equal(parsed.model, "minimax_h3_768p");
  assert.equal(parsed.seconds, 6);
  assert.deepEqual(parsed.images, ["frame.png"]);

  assert.throws(() => parseVideoGenerationInput({ prompt: "   " }));
  assert.throws(() => parseVideoGenerationInput({ prompt: "ok", seconds: 99 }));
});

test("runStarAiStudioGeneration submits, polls until completed, and downloads media", async () => {
  const submittedFields = {};
  let polls = 0;
  const studio = {
    submit: async (form) => {
      for (const [k, v] of form.entries()) {
        submittedFields[k] = typeof v === "string" ? v : v.name;
      }
      return Response.json({ success: true, data: { id: "gen_123", status: "queued" } });
    },
    get: async (id) => {
      assert.equal(id, "gen_123");
      polls += 1;
      if (polls === 1) return Response.json({ success: true, data: { id, status: "in_progress", progress: 40 } });
      return Response.json({
        success: true,
        data: {
          id,
          status: "completed",
          result_urls: ["/pg/studio/generations/gen_123/content?index=0"],
          billed_amount: 1200,
        },
      });
    },
    download: async (path) => {
      assert.equal(path, "/pg/studio/generations/gen_123/content?index=0");
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    },
  };
  const outcome = await runStarAiStudioGeneration(
    studio,
    {
      kind: "image",
      model: STARAI_DEFAULT_IMAGE_MODEL,
      prompt: "Milky white icon with colorful star",
    },
    new AbortController().signal,
    { pollIntervalMs: 5 },
  );
  assert.equal(submittedFields.kind, "image");
  assert.equal(submittedFields.model, "gpt-image-2.6-sunburst");
  assert.equal(outcome.id, "gen_123");
  assert.equal(outcome.files.length, 1);
  assert.equal(outcome.files[0].extension, "png");
  assert.equal(polls, 2);
});

test("GenerateImages falls back to StarAI gpt-image-2.6-sunburst when no manual image model is configured", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "starai-img-"));
  const scratchDir = join(dataDir, "scratch", "sess-1");
  try {
    let submittedModel = "";
    const tool = createImageGenerationTool({
      dataDir,
      getHost: () => ({
        call: async (method) => {
          if (method === "settings.get") return {};
          if (method === "session.getScratchPath") return { path: scratchDir };
          if (method === "session.get") return { session: { id: "sess-1" } };
          throw new Error(`unexpected method ${method}`);
        },
      }),
      getStarAi: () => ({
        isSignedIn: async () => true,
        studioMedia: {
          submit: async (form) => {
            submittedModel = String(form.get("model") ?? "");
            return Response.json({
              success: true,
              data: { id: "img_1", status: "completed", result_urls: ["/pg/studio/generations/img_1/content?index=0"] },
            });
          },
          get: async () => Response.json({
            success: true,
            data: { id: "img_1", status: "completed", result_urls: ["/pg/studio/generations/img_1/content?index=0"] },
          }),
          download: async () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
        },
      }),
    });

    const result = await tool({
      sessionId: "sess-1",
      toolCallId: "tc-1",
      args: { items: [{ prompt: "Minimalist colorful star logo" }] },
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, true);
    assert.equal(submittedModel, "gpt-image-2.6-sunburst");
    const content = result.content;
    assert.equal(content.kind, "generated-images");
    assert.equal(content.providerId, STARAI_PROVIDER_ID);
    assert.equal(content.modelId, "gpt-image-2.6-sunburst");
    assert.equal(content.results.length, 1);
    assert.equal(content.results[0].status, "succeeded");
    const saved = await readFile(content.results[0].path);
    assert.deepEqual(saved, PNG_BYTES);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GenerateVideo guides minimax_h3_768p without images and generates video with pi-media URL when image is provided", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "starai-vid-"));
  const scratchDir = join(dataDir, "scratch", "sess-2");
  try {
    let submittedModel = "";
    let uploadedImages = 0;
    const tool = createVideoGenerationTool({
      dataDir,
      getHost: () => ({
        call: async (method) => {
          if (method === "session.getScratchPath") return { path: scratchDir };
          if (method === "session.get") return { session: { id: "sess-2" } };
          throw new Error(`unexpected method ${method}`);
        },
      }),
      getStarAi: () => ({
        isSignedIn: async () => true,
        studioMedia: {
          submit: async (form) => {
            submittedModel = String(form.get("model") ?? "");
            uploadedImages = form.getAll("image[]").length;
            return Response.json({
              success: true,
              data: { id: "vid_1", status: "completed", result_urls: ["/pg/studio/generations/vid_1/content?index=0"] },
            });
          },
          get: async () => Response.json({
            success: true,
            data: { id: "vid_1", status: "completed", result_urls: ["/pg/studio/generations/vid_1/content?index=0"] },
          }),
          download: async () => new Response(MP4_BYTES, { status: 200, headers: { "content-type": "video/mp4" } }),
        },
      }),
    });

    const missingRef = await tool({
      sessionId: "sess-2",
      toolCallId: "tc-no-img",
      args: { prompt: "A glowing star rotates gently" },
      signal: new AbortController().signal,
    });
    assert.equal(missingRef.ok, false);
    assert.equal(missingRef.errorCode, "INVALID_ARGUMENT");
    assert.match(missingRef.content.message, /GenerateImages/);

    const { mkdir } = await import("node:fs/promises");
    await mkdir(scratchDir, { recursive: true });
    const refPath = join(scratchDir, "keyframe.png");
    await writeFile(refPath, PNG_BYTES);

    const okResult = await tool({
      sessionId: "sess-2",
      toolCallId: "tc-with-img",
      args: {
        prompt: "Smooth slow push-in on the glowing star",
        images: [refPath],
        aspectRatio: "16:9",
        seconds: 5,
      },
      signal: new AbortController().signal,
    });
    assert.equal(okResult.ok, true);
    assert.equal(submittedModel, "minimax_h3_768p");
    assert.equal(uploadedImages, 1);
    const content = okResult.content;
    assert.equal(content.kind, "generated-video");
    assert.equal(content.modelId, "minimax_h3_768p");
    assert.equal(content.result.status, "succeeded");
    assert.match(content.result.mediaUrl, /^pi-media:\/\/scratch\/sess-2\/generated-video-.*\.mp4$/);
    const realScratchRoot = await realpath(join(dataDir, "scratch"));
    assert.equal(generatedMediaUrlFromScratchRoot(realScratchRoot, content.result.path), content.result.mediaUrl);
    const saved = await readFile(content.result.path);
    assert.deepEqual(saved, MP4_BYTES);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
