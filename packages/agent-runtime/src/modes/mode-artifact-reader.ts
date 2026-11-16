/**
 * Reads a run artifact for a prompt inject (ADR mode-definitions) through the
 * Host `Read` tool path, so the same workspace containment, sensitive-path
 * denial and permission evaluation apply as when the model reads the file.
 */
import { randomUUID } from "node:crypto";
import type { RuntimeHost } from "../host-client.js";
import { artifactTextFromRead, type ModeArtifactRead, type ModeArtifactReader } from "./stage-brief.js";

/** Host lines read for one inject; the 32 KiB inject cap applies afterwards. */
const INJECT_READ_LINES = 2_000;

type HostToolResult = { ok?: unknown; content?: unknown; errorCode?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.content === "string") return content.content;
  return undefined;
}

export type ModeArtifactReaderContext = {
  host: RuntimeHost;
  sessionId: string;
  turnId: () => string | undefined;
  mode: () => string;
};

export function createHostModeArtifactReader(context: ModeArtifactReaderContext): ModeArtifactReader {
  return async (path: string): Promise<ModeArtifactRead> => {
    let result: HostToolResult;
    try {
      result = await context.host.call<HostToolResult>("tools.execute", {
        sessionId: context.sessionId,
        turnId: context.turnId(),
        toolCallId: `mode-inject-${randomUUID()}`,
        toolName: "Read",
        args: { path, limit: INJECT_READ_LINES },
        mode: context.mode(),
      });
    } catch {
      // The inject degrades to a notice that names the path; the model can
      // still Read the file itself and see the real error.
      return { status: "unavailable" };
    }
    if (!isRecord(result)) return { status: "unavailable" };
    if (result.ok !== true) {
      return result.errorCode === "FILE_NOT_FOUND" ? { status: "missing" } : { status: "unavailable" };
    }
    const text = readContent(result.content);
    if (text === undefined) return { status: "unavailable" };
    // The Host bounds the Read window; the 32 KiB inject cap is applied when
    // the inject is rendered.
    return { status: "ok", text: artifactTextFromRead(text) };
  };
}
