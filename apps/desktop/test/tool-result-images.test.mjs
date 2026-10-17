import assert from "node:assert/strict";
import test from "node:test";

const { normalizeToolResultImages } = await import(
  new URL(
    "../../../packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent/dist/utils/tool-result-images.js",
    import.meta.url,
  ),
);

test("omits a tool image from persistent history when resizing fails", async () => {
  const image = {
    type: "image",
    data: Buffer.from("not a valid PNG").toString("base64"),
    mimeType: "image/png",
  };
  const content = [
    { type: "text", text: "Screenshot saved at /tmp/screenshot.png" },
    image,
  ];

  const normalized = await normalizeToolResultImages(content, { autoResizeImages: true });

  assert.deepEqual(normalized, [
    { type: "text", text: "Screenshot saved at /tmp/screenshot.png" },
    {
      type: "text",
      text: "[Image omitted: could not be resized below the inline image size limit.]",
    },
  ]);
  assert.equal(normalized.some((block) => block.type === "image"), false);
});
