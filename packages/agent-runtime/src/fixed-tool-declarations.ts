import { createHash } from "node:crypto";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, toToolDeclaration, Type, type Api, type Model } from "@earendil-works/pi-ai";
import * as Value from "typebox/value";
import { contextBudgetLimitsFor, automaticCompactionThresholdFor } from "./context-budget.js";
import { estimateOutputCapInputTokens } from "./output-cap.js";

export const TOOL_ACTIVATION_SECTION = "tool_activation";
const activationSchema = Type.Object({
  version: Type.Literal(1), snapshot: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  active: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
}, { additionalProperties: false });

export type ToolDeclarationPolicy = {
  key: string;
  tools?: AgentTool[];
  fallback?: "tool-count" | "context-budget";
};

/** Only these Pi transports keep new schemas out of the request's initial tools. */
function hasAnchoredToolAdditions(model: Model<Api>): boolean {
  if (model.api === "pi-messages") return true;
  const compat = model.compat;
  if (!compat || !("supportsMidConvoSystemMessages" in compat)
    || compat.supportsMidConvoSystemMessages !== true) return false;
  if (model.api === "openai-completions") {
    return "supportsMidConvoToolAdditions" in compat && compat.supportsMidConvoToolAdditions === true;
  }
  if (model.api === "anthropic-messages") {
    // Pi 1.0.1 sends later schemas inline rather than growing top-level tools.
    return "supportsMidConvoToolChanges" in compat && compat.supportsMidConvoToolChanges === true;
  }
  if (["openai-responses", "openai-codex-responses"].includes(model.api)) {
    return ("supportsAdditionalTools" in compat && compat.supportsAdditionalTools === true)
      || ("supportsToolSearch" in compat && compat.supportsToolSearch === true);
  }
  return false;
}

/** Keep native anchored additions, otherwise stabilize the complete catalog. */
export function toolDeclarationPolicy(
  model: Model<Api>, tools: readonly AgentTool[], deferred: ReadonlySet<string>, prompt: string, accountId: string,
): ToolDeclarationPolicy {
  const ordered = [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const key = createHash("sha256").update(JSON.stringify({
    account: accountId, model: model.id, api: model.api, endpoint: model.baseUrl.replace(/\/+$/, ""),
    tools: ordered.map(toToolDeclaration), deferred: [...deferred].sort(),
  })).digest("hex");
  if (hasAnchoredToolAdditions(model)) return { key };
  // Conservative shared ceiling, including Chat Completions' 128-function limit.
  // Larger catalogs retain on-demand loading; never truncate or raise API limits.
  if (ordered.length > 128) return { key, fallback: "tool-count" };
  const budget = contextBudgetLimitsFor(model);
  const tokens = estimateOutputCapInputTokens({ messages: [], systemPrompt: prompt, tools: ordered }, model);
  // Leave the normal retained-tail budget available to the conversation. A
  // fixed catalog must not make every fresh/compacted request overflow again.
  if (tokens >= automaticCompactionThresholdFor(budget) - budget.keepRecentTokens) {
    return { key, fallback: "context-budget" };
  }
  return { key, tools: ordered };
}

export function toolActivationSection(key: string, active: ReadonlySet<string>): string {
  return JSON.stringify({ version: 1, snapshot: key, active: [...active].sort() });
}

/** A declaration is not activation. Malformed/new-version state fails closed. */
export function restoredToolActivation(messages: readonly AgentMessage[], key: string): { active: string[]; replayFrom: number } | undefined {
  const section = getCurrentSystemMessage(messages)?.sections?.[TOOL_ACTIVATION_SECTION];
  const closed = { active: [], replayFrom: messages.length };
  if (section == null) return messages.some((message) => message.role === "system"
    && TOOL_ACTIVATION_SECTION in (message.sections ?? {})) ? closed : undefined;
  try {
    const parsed: unknown = JSON.parse(section);
    if (!Value.Check(activationSchema, parsed) || parsed.snapshot !== key) return closed;
    const lastState = messages.map((message) => message.role === "system"
      && TOOL_ACTIVATION_SECTION in (message.sections ?? {})).lastIndexOf(true);
    return { active: parsed.active, replayFrom: lastState + 1 };
  } catch { return closed; }
}

/** Activation is appended after the result, never inserted into old instructions. */
export function syncToolActivation(messages: AgentMessage[], section: string): AgentMessage[] {
  if (getCurrentSystemMessage(messages)?.sections?.[TOOL_ACTIVATION_SECTION] === section) return messages;
  const timestamp = messages.reduce((latest, message) => Math.max(latest, message.timestamp + 1), Date.now());
  return [...messages, { role: "system", content: "", timestamp, sections: { [TOOL_ACTIVATION_SECTION]: section } }];
}
