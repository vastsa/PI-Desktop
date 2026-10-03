import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { toolDeclarationPolicy, toolActivationSection, restoredToolActivation, TOOL_ACTIVATION_SECTION } from "./fixed-tool-declarations.js";
import { replaceSystemPrompt, systemTranscriptCheckpoint } from "./system-transcript.js";
import { convertToLlm } from "./pi-runtime-messages.js";

const model = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash")!;
const tool = (name: string): AgentTool => ({ name, label: name, description: "Fixture tool", parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "Done" }], details: {} }) });
const deferred = new Set(["Alpha", "Beta"]);
const policy = (tools = [tool("Alpha"), tool("Beta")], overrides: Partial<Model<Api>> = {}, prompt = "") =>
  toolDeclarationPolicy({ ...model, ...overrides } as Model<Api>, tools, deferred, prompt, "fixture-account");

describe("fixed tool declaration policy", () => {
  it("persists activation without projecting it into model instructions", () => {
    const current = policy();
    const messages: AgentMessage[] = [
      { role: "system" as const, content: "", timestamp: 1, toolsAdded: current.tools,
        sections: { runtime: "Rules", [TOOL_ACTIVATION_SECTION]: toolActivationSection(current.key, new Set()) } },
      { role: "system" as const, content: "", timestamp: 2,
        sections: { [TOOL_ACTIVATION_SECTION]: toolActivationSection(current.key, new Set(["Alpha"])) } },
      { role: "system" as const, content: "Changed instruction", timestamp: 3,
        sections: { obsolete: null, [TOOL_ACTIVATION_SECTION]: null }, toolsRemoved: [{ name: "Beta" }] },
    ];
    const before = JSON.stringify(messages);
    const projected = convertToLlm(messages);
    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ sections: { runtime: "Rules" }, toolsAdded: current.tools });
    expect(projected[1]).toMatchObject({ content: "Changed instruction", sections: { obsolete: null }, toolsRemoved: [{ name: "Beta" }] });
    expect(JSON.stringify(projected)).not.toContain(TOOL_ACTIVATION_SECTION);
    expect(JSON.stringify(messages)).toEqual(before);
  });
  it("has a deterministic declaration order and snapshot identity", () => {
    const first = policy();
    const second = policy([tool("Beta"), tool("Alpha")]);
    expect(second.key).toBe(first.key);
    expect(second.tools?.map((tool) => tool.name)).toEqual(["Alpha", "Beta"]);
    expect(policy([{ ...tool("Alpha"), parameters: Type.Object({ id: Type.String() }) }]).key).not.toBe(first.key);
  });
  it.each([
    { id: "deepseek-pro" }, { api: "openai-responses" }, { baseUrl: "https://relay.invalid" },
    { baseUrl: "https://api.deepseek.com/v1" }, { compat: { supportsMidConvoSystemMessages: false } },
  ] as Partial<Model<Api>>[])("stabilizes declarations without assuming transcript capabilities: %j", (overrides) => {
    expect(policy(undefined, overrides).tools?.map((tool) => tool.name)).toEqual(["Alpha", "Beta"]);
    expect(policy(undefined, overrides).fallback).toBeUndefined();
  });
  it("falls back without truncating catalogs beyond the provider's function limit", () => {
    expect(policy(Array.from({ length: 128 }, (_, index) => tool(`Tool${index}`))).tools).toHaveLength(128);
    expect(policy(Array.from({ length: 129 }, (_, index) => tool(`Tool${index}`)))).toMatchObject({ fallback: "tool-count" });
  });
  it("leaves room for retained conversation and output", () => {
    expect(policy([tool("Alpha")], { contextWindow: 32000, maxTokens: 4000 }, "x".repeat(80000)))
      .toMatchObject({ fallback: "context-budget" });
  });
  it("restores activation independently of full declarations, including compacted and transient prompts", () => {
    const current = policy();
    const messages = [{ role: "system" as const, content: "", timestamp: 1,
      toolsAdded: current.tools, sections: { runtime: "Rules", [TOOL_ACTIVATION_SECTION]: toolActivationSection(current.key, new Set(["Alpha"])) } }];
    const changed = replaceSystemPrompt(messages, "Temporary nudge");
    expect(restoredToolActivation(changed, current.key)?.active).toEqual(["Alpha"]);
    expect(restoredToolActivation([systemTranscriptCheckpoint(changed)!], current.key)?.active).toEqual(["Alpha"]);
    expect(restoredToolActivation(messages, "different-snapshot")?.active).toEqual([]);
    expect(restoredToolActivation([], current.key)).toBeUndefined();
  });
  it.each(["invalid JSON", '{"version":2}', null])("fails closed on invalid activation metadata: %s", (value) => {
    expect(restoredToolActivation([{ role: "system", content: "", timestamp: 1,
      sections: { [TOOL_ACTIVATION_SECTION]: value } }], policy().key)?.active).toEqual([]);
  });
});
