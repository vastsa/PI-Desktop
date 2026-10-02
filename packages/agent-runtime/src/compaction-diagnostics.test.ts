import { describe, expect, it } from "vitest";
import { compactionRequestShape } from "./compaction-diagnostics.js";

const model = { api: "openai-responses" } as never;

describe("compactionRequestShape", () => {
  it("records bounded wire shape without message or tool contents", () => {
    expect(
      compactionRequestShape({
        model,
        payload: {
          model: "secret-model-name-is-not-copied",
          input: [{ role: "user", content: "private prompt" }],
          max_output_tokens: 4096,
          authorization: "Bearer secret",
        },
        messages: [
          { role: "user" },
          { role: "assistant" },
          { role: "toolResult" },
        ],
        tools: [{ name: "private-tool" }],
      }),
    ).toEqual({
      api: "openai-responses",
      topLevelFields: ["model", "input", "max_output_tokens", "authorization"],
      roleCounts: { user: 1, assistant: 1, toolResult: 1 },
      toolCount: 1,
      outputLimit: 4096,
    });
  });

  it("reports omitted output limits and ignores invalid field names", () => {
    expect(
      compactionRequestShape({
        model,
        payload: { "x bad": true, valid_field: true },
        messages: [],
      }),
    ).toMatchObject({
      topLevelFields: ["valid_field"],
      outputLimit: "omitted",
      toolCount: 0,
    });
  });
});
