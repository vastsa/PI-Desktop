import { describe, expect, it } from "vitest";
import { assistantContent, toJsonObject, toJsonValue } from "./agent-messages.js";

describe("agent message JSON projections", () => {
  it("keeps JSON objects and rejects readonly arrays as object maps", () => {
    const values: readonly unknown[] = Object.freeze([{ nested: "value" }]);

    expect(toJsonObject({ details: values })).toEqual({ details: [{ nested: "value" }] });
    expect(toJsonObject(values)).toEqual({});
    expect(toJsonValue(values)).toEqual([{ nested: "value" }]);
  });

  it("excludes only explicitly signed Responses commentary from answer text", () => {
    const message = assistantContent([
      { type: "text", text: "I will check. " },
      { type: "text", text: "Working…", textSignature: '{"v":1,"id":"msg_c","phase":"commentary"}' },
      { type: "thinking", thinking: "real reasoning" },
      { type: "text", text: "A", textSignature: "{invalid" },
      { type: "text", text: "B", textSignature: '{"phase":"commentary"}' },
      { type: "text", text: "C", textSignature: '{"v":1,"id":"msg_f","phase":"final_answer"}' },
    ]);
    expect(message.text).toBe("I will check. ABC");
    expect(message.thinking).toBe("real reasoning");
  });
});
