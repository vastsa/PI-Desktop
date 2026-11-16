import { describe, expect, it } from "vitest";
import { textToolCallDiagnostic } from "./text-tool-call.js";

const tools = new Map([["TodoWrite", {}]]);
const xml = '<tool_call>\n<function=TodoWrite>\n<parameter=todos>\n[]\n</parameter>\n</function>\n</tool_call>';

describe("text tool-call diagnostics", () => {
  it.each([xml, `Workspace checked.\n${xml}`, xml.replaceAll("\n", "")])("recognizes a complete call outside code", (text) => {
    expect(textToolCallDiagnostic(text, tools)?.code).toBe("TOOL_CALL_NOT_EXECUTED");
  });
  it.each([
    `\`\`\`xml\n${xml}\n\`\`\``,
    `~~~xml\n${xml}\n~~~`,
    `\`\`\`\`xml\n\`\`\`\n${xml}\n\`\`\`\``,
    `\`${xml.replaceAll("\n", "")}\``,
    xml.split("\n").map((line) => `> ${line}`).join("\n"),
    xml.split("\n").map((line) => `    ${line}`).join("\n"),
    xml.replace("</tool_call>", ""),
    xml.replace("</function>", ""),
    xml.replace("TodoWrite", "UnknownTool"),
    "The task is complete.",
  ])("leaves examples, incomplete calls and unknown names alone", (text) => {
    expect(textToolCallDiagnostic(text, tools)).toBeUndefined();
  });
  it("still checks prose following a fenced example", () => {
    expect(textToolCallDiagnostic(`~~~xml\n${xml}\n~~~\n${xml}`, tools)?.code).toBe("TOOL_CALL_NOT_EXECUTED");
  });
});
