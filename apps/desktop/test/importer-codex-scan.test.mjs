import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { dirname, join as joinPath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(joinPath(here, "helpers/ts-import-hooks.mjs")));
const { CODEX_SCAN_FULL_PARSE_MAX_BYTES, scanCodexSessions } = await import(
  "../electron/main/importers/codex.ts"
);

const iso = (value) => new Date(value).toISOString();

async function withArchive(cases, run) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-codex-scan-"));
  try {
    const dir = join(root, "sessions");
    await mkdir(dir, { recursive: true });
    for (const [name, content] of cases) {
      const target = join(dir, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return await run(dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const metaLine = (id, cwd, timestamp) =>
  JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: { id, cwd, timestamp },
  });

const responseItem = (role, text, timestamp) =>
  JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });

const fillBytes = (target, line) => {
  const one = `${line}\n`;
  const repeats = Math.max(1, Math.ceil(target / one.length));
  return one.repeat(repeats).slice(0, Math.max(target, one.length));
};

test("small archives keep the exact full-parse semantics", async () => {
  await withArchive(
    [
      [
        "2026/01/rollout-a.jsonl",
        [
          metaLine("abc-1", "/repo/ink", "2026-01-01T00:00:00Z"),
          responseItem("user", "# AGENTS.md\nrules", "2026-01-01T00:00:01Z"),
          responseItem("user", "画一只虾", "2026-01-01T00:00:02Z"),
          responseItem("assistant", "好的", "2026-01-01T00:00:03Z"),
          "not json at all\n",
          "\n",
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const summaries = await scanCodexSessions(dir);
      assert.equal(summaries.length, 1);
      const s = summaries[0];
      assert.equal(s.source, "codex");
      assert.equal(s.externalId, "abc-1");
      assert.equal(s.title, "画一只虾");
      assert.equal(s.projectPath, "/repo/ink");
      assert.equal(s.createdAt, iso("2026-01-01T00:00:00Z"));
      assert.equal(s.updatedAt, iso("2026-01-01T00:00:03Z"));
      // meta + malformed + empty lines are not items; the rest are.
      assert.equal(s.messageCount, 3);
      assert.equal(typeof s.filePath, "string");
    },
  );
});

test("old-format headers and item counts are preserved", async () => {
  await withArchive(
    [
      [
        "old.jsonl",
        [
          JSON.stringify({
            id: "old-1",
            timestamp: "2026-02-01T00:00:00Z",
            cwd: "/repo/old",
          }),
          JSON.stringify({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "题款位置怎么定" }],
            timestamp: "2026-02-01T00:00:05Z",
          }),
          JSON.stringify({
            type: "function_call",
            call_id: "c1",
            name: "read",
            arguments: "{}",
            timestamp: "2026-02-01T00:00:06Z",
          }),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.externalId, "old-1");
      assert.equal(s.title, "题款位置怎么定");
      assert.equal(s.messageCount, 2);
      assert.equal(s.updatedAt, iso("2026-02-01T00:00:06Z"));
    },
  );
});

test("files without a real user message are skipped", async () => {
  await withArchive(
    [
      [
        "synthetic.jsonl",
        [
          metaLine("synth-1", "/repo", "2026-01-01T00:00:00Z"),
          responseItem("user", "<environment>linux</environment>", "2026-01-01T00:00:01Z"),
          responseItem("assistant", "hi", "2026-01-01T00:00:02Z"),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      assert.deepEqual(await scanCodexSessions(dir), []);
    },
  );
});

test("large files are sampled: messageCount is null, title and timestamps survive", async () => {
  assert.ok(CODEX_SCAN_FULL_PARSE_MAX_BYTES > 0);
  await withArchive(
    [
      [
        "big.jsonl",
        [
          metaLine("big-1", "/repo/big", "2026-03-01T00:00:00Z"),
          responseItem("user", "从这张图开始", "2026-03-01T00:00:01Z"),
          // Padding pushes the file over the full-parse threshold; the last
          // timestamp lives in the tail the same way real archives end.
          fillBytes(
            CODEX_SCAN_FULL_PARSE_MAX_BYTES + 512 * 1024,
            JSON.stringify({
              timestamp: "2026-03-01T00:01:00Z",
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: "c9",
                output: "x".repeat(64),
              },
            }),
          ),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.externalId, "big-1");
      assert.equal(s.title, "从这张图开始");
      assert.equal(s.createdAt, iso("2026-03-01T00:00:00Z"));
      assert.equal(s.updatedAt, iso("2026-03-01T00:01:00Z"));
      assert.equal(s.messageCount, null);
    },
  );
});

test("a large file whose real user message sits beyond the head is still found", async () => {
  await withArchive(
    [
      [
        "deep.jsonl",
        [
          metaLine("deep-1", "/repo/deep", "2026-04-01T00:00:00Z"),
          // More than CODEX_SCAN_HEAD_BYTES of synthetic-ish items first.
          fillBytes(
            CODEX_SCAN_FULL_PARSE_MAX_BYTES,
            responseItem("assistant", "padding", "2026-04-01T00:00:30Z"),
          ),
          responseItem("user", "深处的真实消息", "2026-04-01T00:01:00Z"),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.externalId, "deep-1");
      assert.equal(s.title, "深处的真实消息");
      assert.equal(s.updatedAt, iso("2026-04-01T00:01:00Z"));
    },
  );
});
