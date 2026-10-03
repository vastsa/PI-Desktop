import type { Message } from "@earendil-works/pi-ai";
import { hostedSearchReplayProjection } from "@earendil-works/pi-ai/utils/hosted-search";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TOOL_ACTIVATION_SECTION } from "./fixed-tool-declarations.js";

export type CompactionSummaryMessage = {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
};

export type BranchSummaryMessage = {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
};

type BashExecutionMessage = {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
};

type CustomMessage = {
  role: "custom";
  content: string | Message["content"];
  timestamp: number;
};

type RuntimeMessage =
  | AgentMessage
  | CompactionSummaryMessage
  | BranchSummaryMessage
  | BashExecutionMessage
  | CustomMessage;

export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
export const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const BRANCH_SUMMARY_SUFFIX = "</summary>";

function normalizeTimestamp(timestamp: string | number): number {
  return typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
}

export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string | number,
): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: normalizeTimestamp(timestamp),
  };
}

export function createBranchSummaryMessage(
  summary: string,
  fromId: string | null,
  timestamp: string | number,
): BranchSummaryMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
    timestamp: normalizeTimestamp(timestamp),
  };
}

function bashExecutionToText(message: BashExecutionMessage): string {
  let text = `Ran \`${message.command}\`\n`;
  if (message.output) text += `\`\`\`\n${message.output}\n\`\`\``;
  else text += "(no output)";
  if (message.cancelled) text += "\n\n(command cancelled)";
  else if (message.exitCode !== undefined && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

/** Convert desktop-only transcript rows into provider messages. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const runtimeMessage = message as RuntimeMessage;
    switch (runtimeMessage.role) {
      case "bashExecution":
        if (runtimeMessage.excludeFromContext) continue;
        converted.push(asProviderMessage({
          role: "user",
          content: [{ type: "text", text: bashExecutionToText(runtimeMessage) }],
          timestamp: runtimeMessage.timestamp,
        }));
        break;
      case "custom":
        converted.push(asProviderMessage({
          role: "user",
          content: typeof runtimeMessage.content === "string"
            ? [{ type: "text", text: runtimeMessage.content }]
            : runtimeMessage.content,
          timestamp: runtimeMessage.timestamp,
        }));
        break;
      case "branchSummary":
        converted.push(asProviderMessage({
          role: "user",
          content: [{
            type: "text",
            text: `${BRANCH_SUMMARY_PREFIX}${runtimeMessage.summary}${BRANCH_SUMMARY_SUFFIX}`,
          }],
          timestamp: runtimeMessage.timestamp,
        }));
        break;
      case "compactionSummary":
        converted.push(asProviderMessage({
          role: "user",
          content: [{
            type: "text",
            text: `${COMPACTION_SUMMARY_PREFIX}${runtimeMessage.summary}${COMPACTION_SUMMARY_SUFFIX}`,
          }],
          timestamp: runtimeMessage.timestamp,
        }));
        break;
      case "system":
        // Activation is Desktop execution metadata, not a model instruction.
        // Persist it canonically, but omit it before Pi folds system messages:
        // otherwise each ToolSearch rewrites the prefix on non-native APIs.
        if (runtimeMessage.sections && TOOL_ACTIVATION_SECTION in runtimeMessage.sections) {
          const sections = Object.fromEntries(Object.entries(runtimeMessage.sections)
            .filter(([name]) => name !== TOOL_ACTIVATION_SECTION));
          if (Object.keys(sections).length || textFromContent(runtimeMessage.content)
            || runtimeMessage.toolsAdded?.length || runtimeMessage.toolsRemoved?.length) {
            converted.push(asProviderMessage({ ...runtimeMessage, sections }));
          }
          break;
        }
        converted.push(asProviderMessage(runtimeMessage));
        break;
      case "user":
      case "assistant":
      case "toolResult":
        converted.push(asProviderMessage(runtimeMessage));
        break;
      default:
        break;
    }
  }
  return converted;
}

function asProviderMessage(message: unknown): Message {
  // pi-agent-core and pi-ai may resolve separate copies of the same runtime
  // message declarations; hosted-search blocks also extend pi-ai's content union.
  return message as Message;
}

/** Match pi-ai's `contentText` projection while accepting hosted-search blocks. */
export function textFromContent(content: unknown, separator = "\n"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    if (Reflect.get(block, "type") !== "text") return [];
    const text = Reflect.get(block, "text");
    return typeof text === "string" ? [text] : [];
  }).join(separator);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Stable plain-text representation used for summary request sizing and input. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = textFromContent(message.content, "");
      if (content) parts.push(`[User]: ${content}`);
      continue;
    }
    if (message.role === "assistant") {
      const thinking: string[] = [];
      const toolCalls: string[] = [];
      const hostedSearch: string[] = [];
      for (const block of message.content) {
        if (block.type === "thinking") thinking.push(block.thinking);
        else if (block.type === "toolCall") {
          const args = Object.entries(block.arguments)
            .map(([key, value]) => `${key}=${safeJsonStringify(value)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${args})`);
        } else if (block.type === "hostedSearch") {
          const projection = hostedSearchReplayProjection(block);
          if (projection !== undefined) hostedSearch.push(safeJsonStringify(projection));
        }
      }
      if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (message.content.some((block) => block.type === "text")) {
        parts.push(`[Assistant]: ${textFromContent(message.content)}`);
      }
      if (toolCalls.length) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      if (hostedSearch.length) parts.push(`[Assistant hosted search]: ${hostedSearch.join("\n")}`);
      continue;
    }
    if (message.role === "toolResult") {
      const content = textFromContent(message.content, "");
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, 2_000)}`);
    }
  }
  return parts.join("\n\n");
}
