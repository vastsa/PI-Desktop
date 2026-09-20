import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { applyMessageUpdate } from "@pi-desktop/shared";
import { createStreamCoalescer } from "./stream-coalescer.js";

function assistant(content: string, thinking = ""): UiMessage {
  return {
    id: "m1",
    role: "assistant",
    content,
    ...(thinking ? { thinking } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "streaming",
  };
}

function update(content: string, deltaText: string, thinking = "", deltaThinking = ""): AgentEventEnvelope {
  return {
    sessionId: "bench",
    ts: 1,
    event: {
      type: "message_update",
      message: assistant(content, thinking),
      ...(deltaText ? { deltaText } : {}),
      ...(deltaThinking ? { deltaThinking } : {}),
    },
  };
}

function naiveSnapshotBytes(totalChars: number, chunk: number): number {
  let bytes = 0;
  for (let size = chunk; size <= totalChars; size += chunk) bytes += size;
  return bytes;
}

describe("streaming payload benchmark", () => {
  it("keeps serialized bytes linear in output length, not in snapshot sums", () => {
    const chunk = 8;
    const sizes = [1_000, 10_000, 50_000] as const;
    const ratios: number[] = [];

    for (const total of sizes) {
      const emitted: AgentEventEnvelope[] = [];
      const coalescer = createStreamCoalescer((envelope) => emitted.push(envelope), {
        intervalMs: 16,
        schedule: (flush) => {
          flush();
          return () => {};
        },
      });
      let text = "";
      for (let offset = 0; offset < total; offset += chunk) {
        const piece = "abcdefgh".slice(0, Math.min(chunk, total - offset));
        text += piece;
        coalescer.push(update(text, piece));
      }
      coalescer.flush();
      const serialized = emitted.reduce(
        (sum, envelope) => sum + JSON.stringify(envelope).length,
        0,
      );
      const naive = naiveSnapshotBytes(total, chunk);
      expect(serialized).toBeLessThan(naive / 20);
      expect(serialized / total).toBeLessThan(40);
      const reconstructed = emitted.reduce<UiMessage | undefined>(
        (message, envelope) =>
          envelope.event.type === "message_update"
            ? applyMessageUpdate(message, envelope.event)
            : message,
        assistant(""),
      );
      expect(reconstructed?.content.length).toBe(total);
      ratios.push(serialized / total);
      coalescer.dispose();
    }

    expect(ratios[2]!).toBeLessThan(ratios[0]! * 2);
  });

  it("does not grow per-update CPU with accumulated length on the wire path", () => {
    const chunk = 4;
    const run = (total: number) => {
      const coalescer = createStreamCoalescer(() => {}, {
        intervalMs: 16,
        schedule: (flush) => {
          flush();
          return () => {};
        },
      });
      const started = performance.now();
      let text = "";
      for (let offset = 0; offset < total; offset += chunk) {
        const piece = "abcd".slice(0, Math.min(chunk, total - offset));
        text += piece;
        coalescer.push(update(text, piece));
      }
      coalescer.flush();
      const elapsed = performance.now() - started;
      coalescer.dispose();
      return { elapsed, stats: coalescer.stats() };
    };

    run(4_000);
    const small = run(4_000);
    const large = run(40_000);
    expect(large.stats.emittedPayloadChars).toBe(40_000);
    expect(small.stats.emittedPayloadChars).toBe(4_000);
    // Wire work is per-chunk. A 10× longer stream may take more total time,
    // but not quadratically more. The 120ms floor absorbs shared-runner
    // jitter when the small sample is only a couple of milliseconds.
    expect(large.elapsed).toBeLessThan(Math.max(120, small.elapsed * 25));
  });
});
