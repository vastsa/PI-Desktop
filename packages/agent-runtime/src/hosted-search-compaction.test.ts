import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { LocalRequestError } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, HostedSearchContent, Message, Model } from "@earendil-works/pi-ai";
import {
  estimateContextTokens as estimateProviderContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import { hostedSearchReplayProjection } from "@earendil-works/pi-ai/utils/hosted-search";

/**
 * Compaction hosted-search contract tests.
 *
 * pi-coding-agent and pi-agent-core both carry their own compaction token
 * estimators. These tests pin the bounded completion of that contract:
 *
 * - standard provider roles (system/user/assistant/toolResult) are delegated to
 *   the pi-ai estimators, so native hosted search replay buffers grow the
 *   estimate exactly like the provider request path does;
 * - the usage anchor is the shared pi-ai rule (a newer prefix timestamp
 *   invalidates older assistant usage) and the anchored payload is not counted
 *   twice;
 * - an optional target model scopes the hosted search projection, so a model
 *   switch cannot overcount replay blocks the target would drop;
 * - internal session roles (custom/bashExecution/branchSummary/compactionSummary)
 *   keep their local adapters and the text/thinking/toolCall/image baselines do
 *   not move;
 * - serializeConversation keeps each hosted search block's raw wire projection
 *   exactly once, without pretending the search was a tool call;
 * - malformed hosted search history fails explicitly instead of being dropped.
 *
 * The modules under test are the installed packages: the test resolves them from
 * its own module graph (createRequire for the manifest, ESM resolution for the
 * module entry) and needs no test-infrastructure shim. The scratch stage loader
 * (compaction-stage-loader.mjs) only redirects those same files to the *-complete
 * pnpm patch edit dirs, so the assertions can run before patch-commit.
 */

const require = createRequire(import.meta.url);

/** Resolve a specifier with the ESM resolver and normalize it to a file URL. */
function esmResolve(specifier: string): string {
  const resolved = (import.meta as ImportMeta & { resolve(specifier: string): string }).resolve(specifier);
  return resolved.startsWith("file:") ? resolved : pathToFileURL(resolved).href;
}

/**
 * Resolve the install root of an installed @earendil-works package.
 *
 * pi-agent-core exports "./package.json", so createRequire can read the
 * manifest. pi-ai and pi-coding-agent export neither "./package.json" nor a
 * CommonJS entry (their "." entry only carries the "import" condition), so their
 * root is derived from the module entry resolved by the ESM resolver instead.
 */
function packageRoot(packageName: string): string {
  try {
    return realpathSync(require.resolve(`${packageName}/package.json`).replace(/[\\/]package\.json$/, ""));
  } catch {
    const entry = fileURLToPath(esmResolve(packageName));
    const marker = entry.lastIndexOf("/dist/");
    if (marker < 0) throw new Error(`cannot locate the dist root of ${packageName}`);
    return realpathSync(entry.slice(0, marker));
  }
}

const load = async <T>(packageName: string, distRelativePath: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(join(packageRoot(packageName), distRelativePath)).href)) as
    unknown as T;

interface CompactionContextUsage {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

/** Token estimators shared by both compaction implementations. */
interface CompactionEstimation {
  estimateTokens(message: Message, model?: Model<Api>): number;
  estimateContextTokens(messages: Message[], model?: Model<Api>): CompactionContextUsage;
}

/** Summarization serializer shared by both compaction implementations. */
interface CompactionSerialization {
  serializeConversation(messages: Message[]): string;
}

/** Selective collapse cutoff helper exported by the pi-agent-core pico3 harness. */
interface Pico3Collapse {
  chooseThrough(entries: { id: string; model?: Message[] }[], keepRecent: number, model?: Model<Api>): string | undefined;
}
const CORE = "@earendil-works/pi-agent-core";
const CODING = "@earendil-works/pi-coding-agent";

const coreEstimation = await load<CompactionEstimation>(CORE, "dist/harness/compaction/compaction.js");
const coreSerialization = await load<CompactionSerialization>(CORE, "dist/harness/compaction/utils.js");
const codingEstimation = await load<CompactionEstimation>(CODING, "dist/core/compaction/compaction.js");
const codingSerialization = await load<CompactionSerialization>(CODING, "dist/core/compaction/utils.js");
/** pico3 collapse cutoff helper; its `model` argument scopes hosted search projections. */
const coreCollapse = await load<Pico3Collapse>(CORE, "dist/harness/pico3/kinds/collapse.js");

const estimators = [
  ["pi-agent-core", coreEstimation],
  ["pi-coding-agent", codingEstimation],
] as const;
const serializers = [
  ["pi-agent-core", coreSerialization],
  ["pi-coding-agent", codingSerialization],
] as const;

/** A generic small test model; tests must not depend on any concrete vendor. */
function targetModel<TApi extends Api>(api: TApi, id = "test-model"): Model<TApi> {
  return {
    id,
    name: "test",
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function assistant(
  content: AssistantMessage["content"],
  api: Api = "anthropic-messages",
  tokens = 0,
  timestamp = 2,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    model: "test-model",
    timestamp,
    stopReason: "stop",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const IMAGE: { type: "image"; data: string; mimeType: string } = {
  type: "image",
  data: "AAAA",
  mimeType: "image/png",
};

/** One provider-native hosted search exchange; `size` grows the replay payload. */
function hostedSearch(size = 1, api: Api = "anthropic-messages"): HostedSearchContent[] {
  return api === "anthropic-messages"
    ? [
        { type: "hostedSearch", phase: "server_tool_use", blockId: "srv_1", name: "web_search", input: { query: "q" } },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srv_1",
          wire: {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [{ type: "web_search_result", encrypted_content: "x".repeat(size) }],
          },
        },
      ]
    : [
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_1",
          wire: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x".repeat(size) } },
        },
      ];
}

describe("compaction hosted search estimation", () => {
  it("grows the estimate when hosted search replay content grows", () => {
    const small = assistant(hostedSearch(1));
    const large = assistant(hostedSearch(4000));
    expect(estimateMessageTokens(large) - estimateMessageTokens(small)).toBeGreaterThan(990);
    for (const [label, estimator] of estimators) {
      // Both native estimators now delegate to the shared provider estimator.
      expect(estimator.estimateTokens(small), label).toBe(estimateMessageTokens(small));
      expect(estimator.estimateTokens(large), label).toBe(estimateMessageTokens(large));
      expect(estimator.estimateTokens(large) - estimator.estimateTokens(small), label).toBeGreaterThan(990);
      expect(estimator.estimateContextTokens([large]), label).toEqual(estimateProviderContextTokens([large]));
    }
  });

  it("delegates standard provider roles, including image blocks, to pi-ai", () => {
    const text = "a".repeat(4000);
    const user: Message = { role: "user", content: text, timestamp: 1 };
    const system: Message = { role: "system", content: text, timestamp: 1 };
    const toolResult: Message = {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 3,
    };
    const imageUser: Message = { role: "user", content: [IMAGE], timestamp: 1 };
    const textAndImageUser: Message = { role: "user", content: [{ type: "text", text: "a".repeat(400) }, IMAGE], timestamp: 1 };
    const imageToolResult: Message = { ...toolResult, content: [IMAGE] };
    const baselines: [string, Message, number][] = [
      ["user text", user, 1000],
      ["system text", system, 1000],
      ["toolResult text", toolResult, 1000],
      ["user image", imageUser, 1200],
      ["user text+image", textAndImageUser, 1300],
      ["toolResult image", imageToolResult, 1200],
    ];
    for (const [label, estimator] of estimators) {
      for (const [role, message, tokens] of baselines) {
        expect(estimator.estimateTokens(message), `${label} ${role}`).toBe(tokens);
        expect(estimator.estimateTokens(message), `${label} ${role} pi-ai parity`).toBe(estimateMessageTokens(message));
      }
    }
  });

  it("anchors usage on the shared pi-ai rule for zero, valid and prefix-invalidated usage", () => {
    const zeroUsage = assistant(hostedSearch(400), "anthropic-messages", 0);
    const valid = assistant(hostedSearch(400), "anthropic-messages", 123);
    const newerPrefix: Message = { role: "user", content: "injected prefix", timestamp: 10 };
    const tail = assistant(hostedSearch(200), "anthropic-messages", 0, 20);
    const failed = { ...assistant(hostedSearch(400), "anthropic-messages", 500), stopReason: "error" as const };
    for (const [label, estimator] of estimators) {
      expect(estimator.estimateContextTokens([zeroUsage]), label).toEqual(estimateProviderContextTokens([zeroUsage]));
      expect(estimator.estimateContextTokens([zeroUsage]).lastUsageIndex, label).toBeNull();

      expect(estimator.estimateContextTokens([valid]), label).toEqual({
        tokens: 123,
        usageTokens: 123,
        trailingTokens: 0,
        lastUsageIndex: 0,
      });

      // A newer prefix invalidates the older assistant usage instead of scanning backwards.
      expect(estimator.estimateContextTokens([newerPrefix, valid]).lastUsageIndex, label).toBeNull();
      expect(estimator.estimateContextTokens([newerPrefix, valid]), label).toEqual(
        estimateProviderContextTokens([newerPrefix, valid]),
      );

      // Aborted/error responses never become the usage anchor.
      expect(estimator.estimateContextTokens([failed]).lastUsageIndex, label).toBeNull();
      expect(estimator.estimateContextTokens([failed]), label).toEqual(estimateProviderContextTokens([failed]));

      expect(estimator.estimateContextTokens([valid, tail]), label).toEqual(estimateProviderContextTokens([valid, tail]));
      expect(estimator.estimateContextTokens([valid, tail]).tokens, label).toBe(123 + estimateMessageTokens(tail));
      expect(estimator.estimateContextTokens([valid, tail]).lastUsageIndex, label).toBe(0);
    }
  });

  it("does not count the anchored message replay payload twice", () => {
    const valid = assistant(hostedSearch(4000), "anthropic-messages", 123);
    // The payload would be visible if it were charged on top of the usage anchor.
    expect(estimateMessageTokens(valid)).toBeGreaterThan(1000);
    for (const [label, estimator] of estimators) {
      const estimate = estimator.estimateContextTokens([valid]);
      expect(estimate.tokens, label).toBe(123);
      expect(estimate.usageTokens, label).toBe(123);
      expect(estimate.trailingTokens, label).toBe(0);
    }
  });

  it("keeps internal session roles on their local adapters", () => {
    const internal: [string, unknown, number][] = [
      ["custom", { role: "custom", content: "12345" }, 2],
      ["custom text+image", { role: "custom", content: [{ type: "text", text: "12345" }, IMAGE] }, 1202],
      ["bashExecution", { role: "bashExecution", command: "1234", output: "5678" }, 2],
      ["branchSummary", { role: "branchSummary", summary: "12345" }, 2],
      ["compactionSummary", { role: "compactionSummary", summary: "12345" }, 2],
    ];
    for (const [label, estimator] of estimators) {
      for (const [role, message, tokens] of internal) {
        expect(estimator.estimateTokens(message as Message), `${label} ${role}`).toBe(tokens);
      }
    }
  });

  it("rejects an unsupported message role explicitly in both packages", () => {
    // Both estimators must fail the same way instead of silently returning 0.
    const unsupported = { role: "notice", content: "hello", timestamp: 1 } as unknown as Message;
    for (const [label, estimator] of estimators) {
      expect(() => estimator.estimateTokens(unsupported), label).toThrow(LocalRequestError);
      expect(() => estimator.estimateTokens(unsupported), `${label} code`).toThrowError(
        expect.objectContaining({ code: "LOCAL_REQUEST_ERROR", phase: "context-validation" }),
      );
      expect(() => estimator.estimateContextTokens([unsupported]), `${label} context`).toThrow(LocalRequestError);
    }
  });

  it("keeps the text/thinking/toolCall baseline", () => {
    const toolCall = { type: "toolCall" as const, id: "t", name: "run", arguments: { a: 1 } };
    const textTool = assistant([
      { type: "text", text: "12345678" },
      { type: "thinking", thinking: "1234" },
      toolCall,
    ]);
    const expected = Math.ceil((8 + 4 + (toolCall.name.length + JSON.stringify(toolCall.arguments).length)) / 4);
    expect(expected).toBe(6);
    for (const [label, estimator] of estimators) {
      expect(estimator.estimateTokens(textTool), label).toBe(expected);
      expect(estimator.estimateTokens(textTool), `${label} pi-ai parity`).toBe(estimateMessageTokens(textTool));
    }
  });

  it("fails explicitly on malformed hosted search history", () => {
    const emptyBlockId = assistant([
      { type: "hostedSearch", phase: "server_tool_use", blockId: "", name: "web_search", input: { query: "q" } },
    ]);
    const missingResultContent = assistant([
      {
        type: "hostedSearch",
        phase: "web_search_tool_result",
        blockId: "srv_1",
        wire: { type: "web_search_tool_result", tool_use_id: "srv_1" },
      },
    ]);
    const unknownPhase = assistant([
      { type: "hostedSearch", phase: "web_search_pending", blockId: "srv_1" } as unknown as HostedSearchContent,
    ]);
    const invalidTimestamp = assistant(hostedSearch(1), "anthropic-messages", 5, Number.NaN);
    const infiniteTimestamp = assistant(hostedSearch(1), "anthropic-messages", 5, Number.POSITIVE_INFINITY);
    for (const [label, estimator] of estimators) {
      for (const [case_, message] of [
        ["empty block id", emptyBlockId],
        ["unknown phase", unknownPhase],
      ] as const) {
        expect(() => estimator.estimateTokens(message), `${label} ${case_}`).toThrow(LocalRequestError);
      }
      const contextCases: [string, Message[]][] = [
        ["missing result content", [missingResultContent]],
        ["invalid timestamp", [invalidTimestamp]],
        ["infinite timestamp", [infiniteTimestamp]],
      ];
      for (const [case_, messages] of contextCases) {
        expect(() => estimator.estimateContextTokens(messages), `${label} ${case_}`).toThrow(LocalRequestError);
        expect(() => estimator.estimateContextTokens(messages), `${label} ${case_} code`).toThrowError(
          expect.objectContaining({ code: "LOCAL_REQUEST_ERROR", phase: "context-validation" }),
        );
      }
      // The same history with a valid zero-usage response still resolves.
      expect(() => estimator.estimateContextTokens([assistant(hostedSearch(1), "anthropic-messages", 0)]), label).not.toThrow();
    }
  });
});

describe("compaction hosted search target model", () => {
  const anthropicTarget = targetModel("anthropic-messages");
  const responsesTarget = targetModel("openai-responses");
  const anthropicSearch = assistant(hostedSearch(4000));
  const responsesSearch = assistant(hostedSearch(4000, "openai-responses"), "openai-responses");

  it("counts replay blocks for the same target in both modules", () => {
    for (const [label, estimator] of estimators) {
      expect(estimator.estimateTokens(anthropicSearch, anthropicTarget), label).toBe(
        estimateMessageTokens(anthropicSearch, anthropicTarget),
      );
      expect(estimator.estimateTokens(responsesSearch, responsesTarget), label).toBe(
        estimateMessageTokens(responsesSearch, responsesTarget),
      );
      expect(estimator.estimateTokens(anthropicSearch, anthropicTarget), label).toBeGreaterThan(900);
      expect(estimator.estimateTokens(responsesSearch, responsesTarget), label).toBeGreaterThan(900);
    }
  });

  it("drops replay blocks the switched target would not carry", () => {
    for (const [label, estimator] of estimators) {
      // Anthropic server tool blocks are not replayed to an openai-responses target.
      expect(estimator.estimateTokens(anthropicSearch, responsesTarget), label).toBe(0);
      expect(estimator.estimateTokens(anthropicSearch, responsesTarget), label).toBe(
        estimateMessageTokens(anthropicSearch, responsesTarget),
      );
      // Responses web_search_call blocks are not replayed to an anthropic-messages target.
      expect(estimator.estimateTokens(responsesSearch, anthropicTarget), label).toBe(0);
      expect(estimator.estimateTokens(responsesSearch, anthropicTarget), label).toBe(
        estimateMessageTokens(responsesSearch, anthropicTarget),
      );
      // A responses replay survives only for the model that produced it.
      const otherResponses = { ...responsesTarget, id: "other-model" };
      expect(estimator.estimateTokens(responsesSearch, otherResponses), label).toBe(
        estimateMessageTokens(responsesSearch, otherResponses),
      );
      const otherAnthropic = { ...anthropicTarget, id: "other-model" };
      expect(estimator.estimateTokens(anthropicSearch, otherAnthropic), label).toBe(
        estimateMessageTokens(anthropicSearch, otherAnthropic),
      );
    }
  });

  it("stays conservative when the caller has no target model", () => {
    for (const [label, estimator] of estimators) {
      // With partial model facts every replay block is charged rather than assumed away.
      expect(estimator.estimateTokens(anthropicSearch), label).toBe(estimateMessageTokens(anthropicSearch));
      expect(estimator.estimateTokens(responsesSearch), label).toBe(estimateMessageTokens(responsesSearch));
      expect(estimator.estimateTokens(anthropicSearch), label).toBeGreaterThan(
        estimator.estimateTokens(anthropicSearch, responsesTarget),
      );
      expect(estimator.estimateContextTokens([anthropicSearch]), label).toEqual(
        estimateProviderContextTokens([anthropicSearch]),
      );
    }
  });

  it("keeps the usage anchor when a target model is provided", () => {
    const valid = assistant(hostedSearch(400), "openai-responses", 123);
    const tail = assistant(hostedSearch(200, "openai-responses"), "openai-responses", 0, 20);
    for (const [label, estimator] of estimators) {
      const estimate = estimator.estimateContextTokens([valid, tail], responsesTarget);
      expect(estimate.lastUsageIndex, label).toBe(0);
      expect(estimate.tokens, label).toBe(123 + estimateMessageTokens(tail, responsesTarget));
      expect(estimate, label).toEqual(estimateProviderContextTokens([valid, tail], responsesTarget));
    }
  });
});

describe("pico3 collapse cutoff model scoping", () => {
  const anthropicTarget = targetModel("anthropic-messages");
  const responsesTarget = targetModel("openai-responses");
  // One small user exchange followed by an assistant exchange whose hosted search
  // replay buffer exists only for the anthropic target.
  const entries = [
    { id: "u1", model: [{ role: "user", content: "abc", timestamp: 1 } as Message] },
    { id: "a1", model: [assistant(hostedSearch(4000))] },
  ];
  const keepRecent = 100;

  it("threads the resolved target model into the cutoff estimate", () => {
    // Without a target every replay block is charged, so the assistant exchange does
    // not fit the retention budget and the cutoff stops before it.
    expect(coreCollapse.chooseThrough(entries, keepRecent)).toBe("u1");
    // Same api: the replay buffer still counts, so the cutoff does not move.
    expect(coreCollapse.chooseThrough(entries, keepRecent, anthropicTarget)).toBe("u1");
    // Switched target: the anthropic buffer is not replayed, the whole history fits
    // and there is nothing to collapse.
    expect(coreCollapse.chooseThrough(entries, keepRecent, responsesTarget)).toBeUndefined();
    // The target model is the only input that changes the outcome.
    expect(estimateMessageTokens(entries[1].model[0], responsesTarget)).toBe(0);
    expect(estimateMessageTokens(entries[1].model[0], anthropicTarget)).toBeGreaterThan(900);
  });
});

describe("serializeConversation hosted search projection", () => {
  const wired = hostedSearch(8);
  const mixed = assistant([
    { type: "text", text: "answer text" },
    ...wired,
    { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
  ]);

  for (const [label, serializer] of serializers) {
    it(`${label}: keeps each hosted search wire block exactly once`, () => {
      const out = serializer.serializeConversation([mixed]);
      expect(out.split("[Assistant hosted search]:").length - 1).toBe(1);
      for (const block of wired) {
        const projection = hostedSearchReplayProjection(block);
        expect(projection).toBeDefined();
        expect(out.split(JSON.stringify(projection)).length - 1).toBe(1);
      }
      // The search pair shares srv_1: each block carries it exactly once.
      expect(out.split('"srv_1"').length - 1).toBe(2);
      expect(out).toContain("[Assistant]: answer text");
      expect(out).toContain("read(");
      // The search block stays data: no fabricated tool call and no internal type leak.
      expect(out).not.toContain("web_search(");
      expect(out).not.toContain('"hostedSearch"');
    });

    it(`${label}: keeps a nameless search result exactly once`, () => {
      const nameless: HostedSearchContent = {
        type: "hostedSearch",
        phase: "web_search_tool_result",
        blockId: "srv_9",
        wire: {
          type: "web_search_tool_result",
          tool_use_id: "srv_9",
          content: [{ type: "web_search_result", encrypted_content: "opaque-result", title: "Result" }],
        },
      };
      const out = serializer.serializeConversation([assistant([nameless])]);
      const projection = hostedSearchReplayProjection(nameless);
      expect(projection).toBeDefined();
      expect(out.split("[Assistant hosted search]:").length - 1).toBe(1);
      expect(out.split(JSON.stringify(projection)).length - 1).toBe(1);
      expect(out.split("srv_9").length - 1).toBe(1);
      expect(out).toContain("opaque-result");
      expect(out).not.toContain("undefined(");
      expect(out).not.toContain("web_search(");
    });

    it(`${label}: keeps the full projection of a large replay buffer`, () => {
      const large = assistant(hostedSearch(5000));
      const out = serializer.serializeConversation([large]);
      expect(out).toContain("x".repeat(5000));
      for (const block of large.content) {
        if (block.type !== "hostedSearch") continue;
        const projection = hostedSearchReplayProjection(block);
        expect(projection).toBeDefined();
        expect(out.split(JSON.stringify(projection)).length - 1).toBe(1);
      }
    });

    it(`${label}: fails explicitly on a malformed search block`, () => {
      const malformed = assistant([
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srv_1",
          wire: { type: "web_search_tool_result", tool_use_id: "srv_1" },
        },
      ]);
      expect(() => serializer.serializeConversation([malformed])).toThrow(LocalRequestError);
    });
  }

  it("keeps legacy text-only conversations byte-identical", () => {
    const legacy = [
      { role: "user" as const, content: "hello", timestamp: 1 },
      assistant([{ type: "text", text: "hi" }, { type: "toolCall", id: "t", name: "run", arguments: { a: 1 } }]),
      { role: "toolResult" as const, toolCallId: "t", toolName: "run", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
    ];
    const expected =
      "[User]: hello\n\n" +
      "[Assistant]: hi\n\n" +
      '[Assistant tool calls]: run(a=1)\n\n' +
      "[Tool result]: done";
    for (const [label, serializer] of serializers) {
      expect(serializer.serializeConversation(legacy as Message[]), label).toBe(expected);
    }
  });
});
