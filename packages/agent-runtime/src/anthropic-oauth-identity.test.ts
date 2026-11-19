import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";

const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never;

function modelAt(baseUrl: string) {
  return {
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<"anthropic-messages">;
}

/** Parses `claude-cli/<major>.<minor>.<patch>` into one comparable number. */
function claudeCliVersion(userAgent: string | undefined): number {
  const match = /^claude-cli\/(\d+)\.(\d+)\.(\d+)$/u.exec(userAgent ?? "");
  expect(match, `unexpected user-agent ${userAgent}`).not.toBeNull();
  const [major, minor, patch] = match!.slice(1).map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

describe("Anthropic OAuth request identity", () => {
  // Claude Pro/Max models such as claude-fable-5-2 reject older Claude Code
  // identities with HTTP 400 `claude_code_version_too_old` (needs >= 2.1.290).
  it("identifies as a Claude Code release that subscription-only models accept", async () => {
    const requests: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      requests.push(req.headers);
      req.resume();
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await streamSimple(modelAt(`http://127.0.0.1:${port}`), context, {
        apiKey: "sk-ant-oat01-fixture",
        maxRetries: 0,
      }).result();
      expect(result.stopReason).toBe("error");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]["x-app"]).toBe("cli");
    expect(claudeCliVersion(requests[0]["user-agent"])).toBeGreaterThanOrEqual(2_001_290);
  });
});
