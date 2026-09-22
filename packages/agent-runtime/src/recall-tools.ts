/**
 * The recall tools: read this session's (or this project's) own history back.
 *
 * Compaction moves messages out of the working window; nothing removes them
 * from the session. These two tools are how a model gets that text again, which
 * is what makes the compaction wording truthful instead of a promise the model
 * cannot act on (ADR 0300):
 *
 * - `recall` searches one session's complete transcript and reads any of its
 *   messages back verbatim, page by page. Tool results are readable this way
 *   even though they are not in the word index, which is how a narrowed tool
 *   result's remainder comes back.
 * - `recall_project` does the same across the sessions of the project this
 *   session is bound to, and only those: the host resolves the project from the
 *   path the caller supplies and refuses a session that belongs to another
 *   project, so session existence never leaks across projects.
 *
 * The host owns matching and isolation; these functions own only what the model
 * sees: the query's shape, the output bound, and the advice when nothing
 * matched. They take a two-method adapter rather than the runtime itself, so
 * both are testable without a session, a provider or a process.
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
/** Host calls these tools make. `call` is the runtime's host bridge. */
export type RecallHost = {
  sessionId: string;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export const RECALL_TOOL_NAME = "recall";
export const RECALL_PROJECT_TOOL_NAME = "recall_project";

/**
 * The query rule is the host's, not a preference: it splits the query into
 * words and every word must appear in the message, and unspaced Chinese counts
 * as one word. A model that does not know this writes a paraphrase and gets
 * nothing, so the description states the rule and what to do instead.
 */
export const RECALL_TOOL_DESCRIPTION =
  "Search this session's complete message history, including messages that compaction moved out of the working window, and read any message back verbatim. How `query` is read: it is split into words and every word must appear in the message (case-insensitive); unspaced Chinese text counts as one word and therefore matches only literally, so a short distinctive phrase finds more than a sentence. Write the query in the words of the person who wrote the message — an identifier, an error string, a file path, or their own phrasing — not your paraphrase of it. Results are best matches first. Passing `messageId` reads that message's text in bounded pages, which is how a tool result (not in the word index) is read back; page forward with the offset the answer reports.";

export const RECALL_PROJECT_TOOL_DESCRIPTION =
  "Search the other sessions of this project and read any of their messages back verbatim. Scope is the project this session is bound to; a session of another project is not reachable this way. `query` follows the same rule as `recall` (every word must appear; unspaced Chinese matches literally). Passing `sessionId` reads that session's messages, newest page first, and `beforeSeq` pages backwards; passing `sessionId` with `messageId` reads one message by id, which is how the rest of a truncated project row comes back.";

export const RECALL_DEFAULT_MATCHES = 10;
export const RECALL_MAX_MATCHES = 25;
/** Output bound: one answer must not become the next compaction's reason. */
export const RECALL_MAX_OUTPUT_CHARS = 16_384;
export const RECALL_READ_DEFAULT_CHARS = 8_000;
export const RECALL_READ_MAX_CHARS = 20_000;
export const RECALL_PROJECT_READ_DEFAULT = 20;
export const RECALL_PROJECT_READ_MAX = 50;

/** One lexical hit as the host returns it. */
export type RecallToolHit = {
  id: string;
  role: string;
  createdAt: string;
  index: number;
  snippet: string;
};

export type RecallHostResult = {
  hits: RecallToolHit[];
  totalMessages: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hostMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the model reads for a search. A hit line carries enough to decide
 * whether to read the message in full (index, role, timestamp, id) plus the
 * bounded snippet, and the empty answer says what to try instead — a bare
 * "no matches" teaches nothing and invites the same query again.
 */
export function recallAnswerText(
  result: RecallHostResult,
  query: string,
  toolName: string = RECALL_TOOL_NAME,
): string {
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const total = Number.isFinite(result.totalMessages) ? result.totalMessages : 0;
  if (hits.length === 0) {
    return (
      `No message in this session contains every word of "${query}" ` +
      `(${total} messages searched).\n\n` +
      "Try again with the words as they were written — an identifier, an error " +
      "string, a file path, or a short distinctive phrase — rather than a " +
      "paraphrase, and remember that an unspaced Chinese sentence matches only " +
      `literally. Passing messageId instead reads one message you already know the id of.`
    );
  }
  const lines = hits.map((hit) => {
    const header = `[${hit.index}] ${hit.role} ${hit.createdAt} (id: ${hit.id})`;
    return `${header}\n${hit.snippet}`;
  });
  const shown = `${hits.length} of ${total} messages match, best first`;
  let text = `${shown}.\n\n${lines.join("\n\n")}`;
  if (hits.length >= RECALL_MAX_MATCHES) {
    text += `\n\n[only the best ${RECALL_MAX_MATCHES} matches are shown; narrow the query to see others]`;
  }
  if (text.length > RECALL_MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, RECALL_MAX_OUTPUT_CHARS)}\n\n[${toolName} output truncated]`;
  }
  return text;
}

type MessageTextWindow = {
  messageId: string;
  role: string;
  createdAt: string;
  index: number;
  totalChars: number;
  offset: number;
  text: string;
  hasMore: boolean;
  nextOffset: number;
};

/** Read one message of this session by id, in bounded pages. */
async function readSessionMessage(
  host: RecallHost,
  params: Record<string, unknown>,
): Promise<string> {
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const maxChars = Math.min(
    RECALL_READ_MAX_CHARS,
    Math.max(1, Math.floor(Number(params.limit) || RECALL_READ_DEFAULT_CHARS)),
  );
  const window = (await host.call("session.readMessage", {
    sessionId: host.sessionId,
    messageId,
    offset,
    maxChars,
  })) as MessageTextWindow;
  const end = window.nextOffset;
  const header =
    `[${window.index}] ${window.role} ${window.createdAt} (id: ${window.messageId}) ` +
    `characters ${window.offset}–${end} of ${window.totalChars}`;
  const next = window.hasMore
    ? `\n\n[more of this message remains: call ${RECALL_TOOL_NAME} again with messageId "${window.messageId}" and offset ${end}]`
    : "";
  return `${header}\n\n${window.text}${next}`;
}

/** `recall`: search this session, or read one of its messages by id. */
export function buildRecallTool(host: RecallHost): AgentTool {
  return {
    name: RECALL_TOOL_NAME,
    label: "Recall",
    description: RECALL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Text to search for in message content (case-insensitive). Required unless messageId is given.",
        }),
      ),
      messageId: Type.Optional(
        Type.String({
          description:
            "Read one message's text verbatim, page by page. Use an id returned by an earlier search; tool results are readable this way and are not in the search index.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "With messageId: the character offset to start this page at (default 0). Page forward using the offset the answer reports.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `With messageId: characters to return (default ${RECALL_READ_DEFAULT_CHARS}, max ${RECALL_READ_MAX_CHARS}). Without it: maximum matches (default ${RECALL_DEFAULT_MATCHES}, max ${RECALL_MAX_MATCHES}).`,
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = isRecord(params) ? params : {};
      const messageId =
        typeof input.messageId === "string" ? input.messageId.trim() : "";
      try {
        if (messageId) {
          return {
            content: [{ type: "text", text: await readSessionMessage(host, input) }],
            details: { messageId },
          };
        }
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) {
          return {
            content: [
              {
                type: "text",
                text: 'Provide either `query` (text to search for) or `messageId` (read one message back).',
              },
            ],
            details: { error: "missing-query" },
          };
        }
        const limit = Math.min(
          RECALL_MAX_MATCHES,
          Math.max(1, Math.floor(Number(input.limit) || RECALL_DEFAULT_MATCHES)),
        );
        const result = (await host.call("session.recall", {
          sessionId: host.sessionId,
          query,
          limit,
        })) as RecallHostResult;
        return {
          content: [
            { type: "text", text: recallAnswerText(result, query, RECALL_TOOL_NAME) },
          ],
          details: {
            matches: Array.isArray(result.hits) ? result.hits.length : 0,
            total: result.totalMessages,
          },
        };
      } catch (error) {
        const message = hostMessage(error);
        return {
          content: [{ type: "text", text: `recall failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  } as AgentTool;
}

/** `recall_project`: search and read the sessions bound to this project. */
export function buildRecallProjectTool(
  host: RecallHost,
  projectPath: string | undefined,
): AgentTool {
  return {
    name: RECALL_PROJECT_TOOL_NAME,
    label: "Recall project",
    description: RECALL_PROJECT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Text to search for in message content (case-insensitive). Required unless sessionId is given.",
        }),
      ),
      sessionId: Type.Optional(
        Type.String({
          description:
            "Read that session's messages, newest page first. Use an id returned by a search.",
        }),
      ),
      messageId: Type.Optional(
        Type.String({
          description:
            "With sessionId: read that message's text verbatim, page by page. Tool results are readable this way and the rest of a truncated row comes back here.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "With messageId: the character offset to start this page at (default 0).",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `With sessionId: messages per page (default ${RECALL_PROJECT_READ_DEFAULT}, max ${RECALL_PROJECT_READ_MAX}). Otherwise: maximum sessions (default ${RECALL_DEFAULT_MATCHES}, max ${RECALL_MAX_MATCHES}).`,
        }),
      ),
      beforeSeq: Type.Optional(
        Type.Number({
          description:
            "With sessionId: the seq of the oldest message already seen; the page returns messages older than it.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = isRecord(params) ? params : {};
      try {
        if (!projectPath) {
          return {
            content: [
              {
                type: "text",
                text: "This session has no project path, so other sessions are not reachable from it.",
              },
            ],
            details: { error: "no-project" },
          };
        }
        const sessionId =
          typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        const messageId =
          typeof input.messageId === "string" ? input.messageId.trim() : "";
        if (sessionId && messageId) {
          const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
          const window = (await host.call("session.readMessage", {
            sessionId,
            messageId,
            offset,
            maxChars: RECALL_READ_DEFAULT_CHARS,
            projectPath,
          })) as MessageTextWindow;
          const end = window.nextOffset;
          const header =
            `[${window.index}] ${window.role} ${window.createdAt} (id: ${window.messageId}) ` +
            `characters ${window.offset}–${end} of ${window.totalChars}`;
          const next = window.hasMore
            ? `\n\n[more of this message remains: call ${RECALL_PROJECT_TOOL_NAME} again with sessionId "${sessionId}", messageId "${window.messageId}" and offset ${end}]`
            : "";
          return {
            content: [{ type: "text", text: `${header}\n\n${window.text}${next}` }],
            details: { sessionId, messageId: window.messageId },
          };
        }
        if (sessionId) {
          const limit = Math.min(
            RECALL_PROJECT_READ_MAX,
            Math.max(1, Math.floor(Number(input.limit) || RECALL_PROJECT_READ_DEFAULT)),
          );
          const beforeSeq = Number.isFinite(Number(input.beforeSeq))
            ? Math.floor(Number(input.beforeSeq))
            : undefined;
          const window = (await host.call("session.readProject", {
            sessionId,
            projectPath,
            limit,
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          })) as {
            sessionId: string;
            sessionTitle: string;
            total: number;
            hasMore: boolean;
            messages: Array<{
              id: string;
              seq: number;
              role: string;
              text: string;
              createdAt: string;
              toolName?: string;
              truncated?: boolean;
            }>;
          };
          const messages = Array.isArray(window.messages) ? window.messages : [];
          if (messages.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session "${sessionId}" has no messages visible through this project.`,
                },
              ],
              details: { sessionId, messages: 0 },
            };
          }
          const body = messages
            .map(
              (message) =>
                `[seq ${message.seq}] ${message.role} ${message.createdAt} (id: ${message.id})` +
                `${message.toolName ? ` ${message.toolName}` : ""}` +
                `${message.truncated ? " [truncated row; read it by id]" : ""}\n${message.text}`,
            )
            .join("\n\n");
          let text =
            `Session "${window.sessionTitle}" (${window.sessionId}) — ${messages.length} of ${window.total} messages, oldest first.\n\n${body}`;
          if (window.hasMore) {
            const oldest = messages[0];
            text += `\n\nOlder messages remain: call ${RECALL_PROJECT_TOOL_NAME} again with the same sessionId and beforeSeq=${oldest.seq}.`;
          }
          if (text.length > RECALL_MAX_OUTPUT_CHARS) {
            text = `${text.slice(0, RECALL_MAX_OUTPUT_CHARS)}\n[${RECALL_PROJECT_TOOL_NAME} output truncated]`;
          }
          return {
            content: [{ type: "text", text }],
            details: {
              sessionId,
              messages: messages.length,
              total: window.total,
              hasMore: window.hasMore,
            },
          };
        }
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) {
          return {
            content: [
              {
                type: "text",
                text: "Provide `query` (text to search for) or `sessionId` (read one session back).",
              },
            ],
            details: { error: "missing-query" },
          };
        }
        const limit = Math.min(
          RECALL_MAX_MATCHES,
          Math.max(1, Math.floor(Number(input.limit) || RECALL_DEFAULT_MATCHES)),
        );
        const answer = (await host.call("search.query", {
          query,
          limit,
          projectPath,
        })) as {
          hits?: Array<{
            sessionId: string;
            sessionTitle: string;
            messageId: string;
            role: string;
            snippet: string;
            createdAt: string;
          }>;
        };
        const hits = Array.isArray(answer.hits) ? answer.hits : [];
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No session of this project contains every word of "${query}".\n\n` +
                  "Sessions surface once, on their best-matching row, so try the words as they were written (an identifier, an error string, a short phrase).",
              },
            ],
            details: { sessions: 0 },
          };
        }
        const lines = hits.map(
          (hit) =>
            `${hit.sessionTitle || hit.sessionId} (sessionId: ${hit.sessionId})\n` +
            `  best match: [${hit.role} ${hit.createdAt}] (id: ${hit.messageId})\n  ${hit.snippet}`,
        );
        let text = `${hits.length} session(s) of this project match, best first.\n\n${lines.join("\n\n")}`;
        text += `\n\nRead one back with ${RECALL_PROJECT_TOOL_NAME} and its sessionId.`;
        if (text.length > RECALL_MAX_OUTPUT_CHARS) {
          text = `${text.slice(0, RECALL_MAX_OUTPUT_CHARS)}\n[${RECALL_PROJECT_TOOL_NAME} output truncated]`;
        }
        return {
          content: [{ type: "text", text }],
          details: { sessions: hits.length },
        };
      } catch (error) {
        const message = hostMessage(error);
        return {
          content: [{ type: "text", text: `recall_project failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  } as AgentTool;
}
