import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { chainRowsToMessages } from "./delegation-history.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { toolResultFromUi } from "./runtime.js";

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "", authKind: "none",
  baseUrl: "http://127.0.0.1:1/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(20);
const image = { type: "image", data: imageData, mimeType: "image/png" };

function restore(raw: unknown) {
  const row: UiMessage = {
    id: "tool-row", role: "tool", content: "", toolName: "Read", toolCallId: "read-1",
    toolArgs: { path: "shot.png" }, toolResult: raw, toolStatus: "success",
    createdAt: "2026-11-04T00:00:00.000Z", parentToolCallId: "task-1", agentName: "explorer",
  };
  const messages = chainRowsToMessages([row], provider, buildProviderModel(provider));
  const restored = messages.find((entry) => entry.role === "toolResult");
  if (!restored || restored.role !== "toolResult") throw new Error("missing restored tool result");
  expect(restored.content).toEqual(toolResultFromUi(row, Date.parse(row.createdAt)).content);
  for (const block of restored.content) {
    if (block.type === "text") expect(block.text).not.toContain(imageData);
  }
  expect(restored.toolCallId).toBe("read-1");
  return restored.content;
}

describe("Resumed delegate tool content matches parent restoration", () => {
  it("restores a host Read image without flattening base64 into text", () => {
    expect(restore({ path: "shot.png", text: "Image attached.", images: [image] }))
      .toContainEqual(image);
  });

  it("restores bare plugin content-block arrays", () => {
    expect(restore([{ type: "text", text: "ok" }, image]))
      .toEqual([{ type: "text", text: "ok" }, image]);
  });

  it("restores an MCP resource without a missing-result placeholder", () => {
    expect(restore({ content: [{ type: "resource", resource: {
      uri: "file:///a.ts", mimeType: "text/plain", text: "export const answer = 42;\n",
    } }] })).toEqual([{ type: "text", text: "export const answer = 42;\n" }]);
  });

  it("keeps text, embedded resources, and resource links together", () => {
    expect(restore({ content: [
      { type: "text", text: "downloaded" },
      { type: "resource", resource: { uri: "file:///a.ts", text: "source body" } },
      { type: "resource_link", uri: "https://example.invalid/a.ts", name: "a.ts" },
    ] })).toEqual([
      { type: "text", text: "downloaded" },
      { type: "text", text: "source body" },
      { type: "text", text: "[resource link] a.ts: https://example.invalid/a.ts" },
    ]);
  });
});
