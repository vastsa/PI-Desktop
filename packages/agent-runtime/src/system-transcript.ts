import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  createInitialSystemMessage,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getToolStateChanges,
  type SystemMessage,
  type Tool,
  toToolDeclaration,
} from "@earendil-works/pi-ai";

function systemMessages(messages: readonly AgentMessage[]): SystemMessage[] {
  return messages.filter((message): message is SystemMessage => message.role === "system");
}

function nextSystemTimestamp(messages: readonly AgentMessage[]): number {
  // 同一毫秒内也必须晚于旧响应；时钟回拨时只前移，不伪造早于 usage 的时间。
  return messages.reduce((timestamp, message) => Math.max(timestamp, message.timestamp + 1), Date.now());
}

function currentSystemMessage(messages: readonly AgentMessage[]): SystemMessage | undefined {
  const systems = systemMessages(messages);
  if (systems.length < 2) return systems[0];
  const current = getCurrentSystemMessage(systems)!;
  // 上游折叠器保留第一条的时间，但 sections/工具删除可能来自较晚的 delta。
  // 快照的语义时间必须覆盖所有贡献者，否则旧 usage 会被错误地重新激活。
  return {
    ...current,
    timestamp: systems.reduce((timestamp, message) => Math.max(timestamp, message.timestamp), systems[0]!.timestamp),
  };
}

/** The unrendered content, without flattening named sections into the prompt. */
export function systemPromptContent(messages: readonly AgentMessage[]): string {
  return contentText(getCurrentSystemMessage(messages)?.content ?? "");
}

export function initialSystemTranscript(
  prompt: string,
  tools: readonly Tool[],
  messages: AgentMessage[],
): AgentMessage[] {
  const system = createInitialSystemMessage(prompt, tools.map(toToolDeclaration));
  // 持久化历史不记录 system 状态，重启后无法证明新配置与旧请求相同。
  // 保守使用实际初始化时间；不能沿用上游初始值 0 来让历史 usage 假装有效。
  return system
    ? [{ ...system, timestamp: nextSystemTimestamp(messages) }, ...messages]
    : messages;
}

export function replaceSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  const current = currentSystemMessage(messages);
  if (prompt === getCurrentSystemPrompt(messages) || prompt === contentText(current?.content ?? "")) {
    return messages;
  }
  // prompt 只替换内容；命名 sections 与最终工具状态仍由上游 replay 负责。
  // recovery 读写未渲染内容，避免把 sections 再嵌入 content 造成重复。
  return [
    { ...current, role: "system", content: prompt, timestamp: nextSystemTimestamp(messages) },
    ...messages.filter((message) => message.role !== "system"),
  ];
}

export function rebuildSystemTranscript(
  previous: readonly AgentMessage[],
  messages: AgentMessage[],
): AgentMessage[] {
  // recovery 传入完整 live transcript 的切片，保留其位置、对象及 delta，不重复加前缀。
  if (messages.some((message) => message.role === "system")) return messages;
  // durable projection 不含 system；用上游 replay 还原有效 sections 和工具集合，
  // 而不是将渲染后的 systemPrompt 当成新消息。折叠不产生新的语义时间。
  const system = currentSystemMessage(previous);
  return system ? [system, ...messages] : messages;
}

export function syncSystemTools(messages: AgentMessage[], tools: readonly Tool[]): AgentMessage[] {
  const changes = getToolStateChanges(getCurrentTools(messages), tools);
  if (changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0) return messages;
  // 真正的工具变化成为较新的前缀，旧 usage 因此失效。保留删除/同名替换的 delta，
  // 并让声明集合与可执行 catalog 一致，避免 agent-loop 下一轮再次自动追加同一变化。
  return [
    ...systemMessages(messages),
    {
      role: "system",
      content: "",
      ...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
      ...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}),
      timestamp: nextSystemTimestamp(messages),
    },
    ...messages.filter((message) => message.role !== "system"),
  ];
}
