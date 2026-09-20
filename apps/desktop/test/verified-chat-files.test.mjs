import assert from "node:assert/strict";
import test from "node:test";
import { splitChatText } from "../src/lib/chat-links.ts";
import {
  chatFileCandidates,
  createChatFileVerificationQueue,
  verifiedChatSegments,
  verifyChatFiles,
} from "../src/lib/verified-chat-files.ts";

const ROOT = "/Users/dev/project";
const ISSUE_PROSE = "使用llama.cpp，给我迁移步骤，只读。";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("dotted prose stays text until a lookup confirms the file", () => {
  const segments = splitChatText(ISSUE_PROSE, ROOT);
  assert.deepEqual(
    segments
      .filter((segment) => segment.kind === "target" && segment.target.kind === "file")
      .map((segment) => segment.target.path),
    ["使用llama.cpp"],
  );
  assert.deepEqual(chatFileCandidates(segments), ["使用llama.cpp"]);

  const pending = verifiedChatSegments(segments, new Set());
  assert.ok(pending.every((segment) => segment.kind === "text"));
  assert.equal(pending.map((segment) => segment.text).join(""), ISSUE_PROSE);

  const confirmed = verifiedChatSegments(segments, new Set(["使用llama.cpp"]));
  assert.equal(
    confirmed.find((segment) => segment.kind === "target")?.target.path,
    "使用llama.cpp",
  );
});

test("explicit @ refs and URLs skip speculative lookup", () => {
  const segments = splitChatText(
    "Open @src/App.tsx and https://example.com now.",
    ROOT,
  );
  assert.deepEqual(chatFileCandidates(segments), []);
  const pending = verifiedChatSegments(segments, new Set());
  assert.deepEqual(
    pending
      .filter((segment) => segment.kind === "target")
      .map((segment) => segment.target),
    [
      { kind: "file", path: "src/App.tsx" },
      { kind: "url", url: "https://example.com" },
    ],
  );
});

test("structured attachment refs keep their chip without a lookup", () => {
  const segments = splitChatText("see App.tsx please", ROOT);
  const trusted = new Set(["App.tsx"]);
  assert.deepEqual(chatFileCandidates(segments, trusted), []);
  assert.ok(
    verifiedChatSegments(segments, trusted).some(
      (segment) => segment.kind === "target" && segment.target.path === "App.tsx",
    ),
  );
});

test("candidate lookup is unique and capped at 32", () => {
  const text = Array.from({ length: 40 }, (_, index) => `file${index}.ts`).join(" ");
  const segments = splitChatText(text, ROOT);
  const paths = chatFileCandidates(segments);
  assert.equal(paths.length, 32);
  assert.equal(paths[0], "file0.ts");
  assert.equal(paths[31], "file31.ts");
  assert.equal(chatFileCandidates(splitChatText("a.ts and a.ts again", ROOT)).length, 1);
});

test("verifyChatFiles keeps hits, skips misses, and survives a thrown lookup", async () => {
  const errors = [];
  const verified = await verifyChatFiles(
    ["hit.ts", "miss.ts", "boom.ts", "after.ts"],
    async (path) => {
      if (path === "boom.ts") throw new Error("lookup failed");
      return path === "hit.ts" || path === "after.ts";
    },
    new AbortController().signal,
    () => errors.push("lookup"),
  );
  assert.deepEqual([...verified], ["hit.ts", "after.ts"]);
  assert.deepEqual(errors, ["lookup"]);
});

test("verifyChatFiles drops in-flight hits after abort and does not warn", async () => {
  const controller = new AbortController();
  const errors = [];
  const verified = await verifyChatFiles(
    ["a.ts", "b.ts"],
    async (path) => {
      if (path === "a.ts") {
        controller.abort();
        throw new Error("cancelled");
      }
      return true;
    },
    controller.signal,
    () => errors.push("lookup"),
  );
  assert.deepEqual([...verified], []);
  assert.deepEqual(errors, []);
});

test("the shared queue caps concurrency and aborts work still waiting", async () => {
  const queue = createChatFileVerificationQueue();
  const gate = deferred();
  let running = 0;
  let peak = 0;
  const blockers = Array.from({ length: 4 }, () =>
    queue(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return true;
    }, new AbortController().signal),
  );

  let started = false;
  const waiting = new AbortController();
  const queued = queue(async () => {
    started = true;
    return true;
  }, waiting.signal);
  waiting.abort();
  assert.equal(await queued, false);
  assert.equal(started, false);

  gate.resolve();
  assert.deepEqual(await Promise.all(blockers), [true, true, true, true]);
  assert.equal(peak, 4);
});
