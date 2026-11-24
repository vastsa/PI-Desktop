import { findAgentMentions, type AgentMention, type UiMessage } from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";

export const USER_REQUEST_TAG = "user_request";
export const COORDINATOR_CONTEXT_TAG = "coordinator_context";
export const MAX_DELEGATE_BRIEF_CHARS = 60_000;

/** Choose a delimiter absent from both inputs instead of escaping, trimming,
 * or normalizing the user's words. The usual tags need no suffix. */
function framingSuffix(...texts: string[]): string {
  let suffix = "";
  for (let n = 1; texts.some((text) =>
    [USER_REQUEST_TAG, COORDINATOR_CONTEXT_TAG, "coordinator_instruction"].some((tag) =>
      text.includes(`<${tag}${suffix}>`) || text.includes(`</${tag}${suffix}>`),
    ),
  ); n++) suffix = `:${n}`;
  return suffix;
}

function frame(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

/** The runtime, not the coordinator, owns the outer framing. */
export function composeDelegateBrief({ task, userRequest }: { task: string; userRequest?: string }): string {
  const suffix = framingSuffix(task, userRequest ?? "");
  if (userRequest === undefined && !suffix && !/<\/?user_request:\d+>/.test(task)) return task;
  const context = frame(COORDINATOR_CONTEXT_TAG + suffix, task);
  return userRequest === undefined ? context : `${frame(USER_REQUEST_TAG + suffix, userRequest)}\n\n${context}`;
}

export function composeDelegateInstruction(text: string): string {
  return frame("coordinator_instruction" + framingSuffix(text), text);
}

export type DelegationUserPrompt = { text: string; mentions: readonly AgentMention[] };

/** A durable row contains the typed draft before any composer expansion.
 * Never mine model messages: a role=user there can be synthetic, compacted,
 * cross-session or include model-facing attachment and command expansions. */
export function delegationUserPrompt(row: UiMessage): DelegationUserPrompt | undefined {
  if (row.role !== "user" || row.parentToolCallId || row.sessionMessage) return undefined;
  const text = row.command ?? row.content;
  const mentions = (row.agentMentions ?? []).filter(({ name, start, end }) =>
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && text.slice(start, end) === `@${name}`,
  ).sort((a, b) => a.start - b.start);
  return { text, mentions };
}

/** The launch path strips the current user row from seed history. Load only
 * the specific known row, when Task is used, so draft text can be recovered
 * on both new and reused runtimes without fetching the rest of the transcript. */
export async function readDelegationUserPrompt(
  host: RuntimeHost, sessionId: string, messageId: string,
): Promise<DelegationUserPrompt | undefined> {
  const detail = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", {
    id: sessionId, messageAround: messageId, messageLimit: 1,
  });
  const row = detail?.session?.messages?.find((message) => message.id === messageId);
  return row && delegationUserPrompt(row);
}

export type UserRequestValidation =
  | { ok: true; userRequest?: string }
  | { ok: false; reason: string };

function containsRoleQuote(prompt: DelegationUserPrompt, agent: string, quote: string): boolean {
  // The @ marker can be included or omitted. Do not accept another role's
  // portion of a multi-expert draft or silently assign the preamble to one.
  return prompt.mentions.some((mention, i) => {
    if (mention.name !== agent) return false;
    const end = prompt.mentions[i + 1]?.start ?? prompt.text.length;
    const start = prompt.mentions.length === 1 ? 0 : mention.start;
    const segment = prompt.text.slice(start, end);
    if (quote === segment || quote === segment.trim()) return true;
    // Omit a leading routing marker, never the instructions preceding an
    // in-sentence mention or a restriction at the end of the segment.
    if (prompt.text.slice(start, mention.start).trim()) return false;
    const addressed = prompt.text.slice(mention.end, end);
    return quote === addressed || quote === addressed.trim();
  });
}

/** A quote is a contiguous exact span of a user-authored message, not an
 * authorization. Determining semantic relevance/conflict is the model's job. */
export function validateUserRequest(input: {
  value: unknown;
  agent: string;
  current?: DelegationUserPrompt;
  history: readonly UiMessage[];
}): UserRequestValidation {
  const { value, agent, current, history } = input;
  const named = current?.mentions.map((mention) => mention.name) ?? [];
  if (named.length && !named.includes(agent)) {
    return { ok: false, reason: `The user explicitly named ${[...new Set(named)].join(", ")}, not ${agent}. Do not substitute a different role; tell the user if the named role is unavailable.` };
  }
  if (value === undefined && named.length === 0) return { ok: true };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: "`userRequest` must contain the user's exact words for this expert. Ask for clarification if the relevant span is unclear." };
  }
  if (value.length > MAX_DELEGATE_BRIEF_CHARS) {
    return { ok: false, reason: `\`userRequest\` exceeds ${MAX_DELEGATE_BRIEF_CHARS} characters; pass only the part that concerns this expert.` };
  }
  if (current && named.length) {
    if (containsRoleQuote(current, agent, value)) return { ok: true, userRequest: value };
  } else if (current?.text.includes(value) || history.some((row) => {
    const prompt = delegationUserPrompt(row);
    return prompt && (prompt.mentions.length ? containsRoleQuote(prompt, agent, value) : prompt.text.includes(value));
  })) {
    return { ok: true, userRequest: value };
  }
  return { ok: false, reason: "`userRequest` must be copied verbatim from a user message in this conversation addressed to this expert. Do not paraphrase or quote generated text; ask the user if the boundaries are unclear." };
}

export function literalDelegationUserPrompt(text: string, roleNames: readonly string[]): DelegationUserPrompt {
  return { text, mentions: findAgentMentions(text, new Set(roleNames)) };
}