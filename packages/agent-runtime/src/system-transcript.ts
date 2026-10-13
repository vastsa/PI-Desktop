import { TOOL_ACTIVATION_SECTION } from "./fixed-tool-declarations.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  type SystemMessage,
  type Tool,
  toToolDeclaration,
} from "@earendil-works/pi-ai";

import { SKILL_SECTION_PREFIX } from "./plugin-skills-prompt.js";

function systemMessages(messages: readonly AgentMessage[]): SystemMessage[] {
  return messages.filter((message): message is SystemMessage => message.role === "system");
}

function nextSystemTimestamp(messages: readonly AgentMessage[]): number {
  // Never backdate a state change relative to the response it invalidates.
  return messages.reduce((timestamp, message) => Math.max(timestamp, message.timestamp + 1), Date.now());
}

function currentSystemMessage(messages: readonly AgentMessage[]): SystemMessage | undefined {
  const systems = systemMessages(messages);
  if (systems.length < 2) return systems[0];
  const current = getCurrentSystemMessage(systems)!;
  // The upstream fold retains the first timestamp. A checkpoint must cover
  // every contributing update so old usage is not accidentally reactivated.
  return {
    ...current,
    timestamp: systems.reduce((timestamp, message) => Math.max(timestamp, message.timestamp), systems[0]!.timestamp),
  };
}

/** Desktop-owned sections retain their order ahead of extension sections. */
export const CONTEXT_BUDGET_SECTION = "context_budget";
export const SESSION_TODOS_SECTION = "session_todos";

function desktopSectionNames(sections: Record<string, unknown>): string[] {
  return ["runtime", TOOL_ACTIVATION_SECTION, "skills", ...Object.keys(sections)
    .filter((name) => name.startsWith(SKILL_SECTION_PREFIX))
    .sort((a, b) => a.localeCompare(b)), "context", SESSION_TODOS_SECTION];
}

/** Update one owned section without replacing a transient or extension prompt. */
export function syncSystemSection(
  messages: AgentMessage[], name: string, text: string | null,
): AgentMessage[] {
  if ((getCurrentSystemMessage(messages)?.sections?.[name] ?? null) === text) return messages;
  return [...messages, {
    role: "system", content: "", sections: { [name]: text }, timestamp: nextSystemTimestamp(messages),
  }];
}

export function systemPromptContent(messages: readonly AgentMessage[], omittedSections: readonly string[] = []): string {
  const current = getCurrentSystemMessage(messages);
  const sections = current?.sections;
  if (sections && desktopSectionNames(sections).some((name) => name in sections)) {
    return desktopSectionNames(sections).filter((name) => !omittedSections.includes(name)).map((name) => sections[name]).filter(Boolean).join("\n\n");
  }
  return contentText(current?.content ?? "");
}

export function syncSystemSections(
  messages: AgentMessage[],
  desired: Record<string, string>,
): AgentMessage[] {
  const current = getCurrentSystemMessage(messages)?.sections ?? {};
  const sections: Record<string, string | null> = {};
  for (const name of desktopSectionNames({ ...current, ...desired })) {
    const next = desired[name] ?? null;
    if ((current[name] ?? null) !== next) sections[name] = next;
  }
  if (Object.keys(sections).length === 0) return messages;
  return [...messages, { role: "system", content: "", sections, timestamp: nextSystemTimestamp(messages) }];
}

export function initialSystemTranscript(
  prompt: string,
  tools: readonly Tool[],
  messages: AgentMessage[],
  sections: Record<string, string> = { runtime: prompt },
): AgentMessage[] {
  if (messages.some((message) => message.role === "system")) {
    // The asynchronous Host read will refresh or revoke this section before
    // admission. Avoid a revoke/re-add pair when a restart finds the same list.
    const todos = getCurrentSystemMessage(messages)?.sections?.[SESSION_TODOS_SECTION];
    return syncSystemSections(messages, { ...sections, ...(todos ? { [SESSION_TODOS_SECTION]: todos } : {}) });
  }
  if (!prompt && tools.length === 0) return messages;
  // Old sessions have no recorded baseline. Declare the current state at the
  // continuation boundary rather than inventing past instructions or tools.
  return [...messages, {
    role: "system", content: "", sections,
    toolsAdded: tools.map(toToolDeclaration), timestamp: nextSystemTimestamp(messages),
  }];
}

export function replaceSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  if (prompt === getCurrentSystemPrompt(messages) || prompt === systemPromptContent(messages)) return messages;
  const activation = getCurrentSystemMessage(messages)?.sections?.[TOOL_ACTIVATION_SECTION];
  const todos = getCurrentSystemMessage(messages)?.sections?.[SESSION_TODOS_SECTION];
  return syncSystemSections(messages, { runtime: prompt,
    ...(activation ? { [TOOL_ACTIVATION_SECTION]: activation } : {}),
    ...(todos ? { [SESSION_TODOS_SECTION]: todos } : {}),
  });
}

export function rebuildSystemTranscript(
  previous: readonly AgentMessage[],
  messages: AgentMessage[],
): AgentMessage[] {
  let result = messages;
  for (let i = 0; i < previous.length; i++) {
    const message = previous[i];
    if (message.role !== "system" || result.includes(message)) continue;
    const following = previous.slice(i + 1).find((item) => result.includes(item));
    const preceding = previous.slice(0, i).reverse().find((item) => result.includes(item));
    let position = following ? result.indexOf(following) : preceding ? result.indexOf(preceding) + 1 : result.length;
    if (!following) while (result[position]?.role === "system") position++;
    if (result === messages) result = [...messages];
    result.splice(position, 0, message);
  }
  return result;
}

/** Fold state only at an explicit compaction boundary, with semantic time. */
export function systemTranscriptCheckpoint(messages: readonly AgentMessage[]): SystemMessage | undefined {
  const current = currentSystemMessage(messages);
  if (!current) return undefined;
  // Use the journal's durable shape, including extension-provided text blocks.
  const checkpoint: SystemMessage = { ...current, content: contentText(current.content),
    ...(current.toolsAdded ? { toolsAdded: current.toolsAdded.map(toToolDeclaration) } : {}) };
  if (!checkpoint.sections || !(CONTEXT_BUDGET_SECTION in checkpoint.sections)) return checkpoint;
  const { [CONTEXT_BUDGET_SECTION]: _expired, ...sections } = checkpoint.sections;
  return { ...checkpoint, sections };
}

/** Recovery discards failed trailing responses even after a prompt cleanup delta. */
export function removeTrailingAssistantMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index--) {
    if (result[index].role === "system") continue;
    if (result[index].role !== "assistant") break;
    result.splice(index, 1);
  }
  return result;
}
