import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
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

test("a large file with an oversized first line still yields its real title", async () => {
  await withArchive(
    [
      [
        "oversized-first-line.jsonl",
        [
          JSON.stringify({
            timestamp: "2026-05-01T00:00:00Z",
            type: "session_meta",
            payload: {
              id: "oversized-1",
              cwd: "/repo/oversized",
              timestamp: "2026-05-01T00:00:00Z",
            },
            padding: "x".repeat(1_048_576),
          }),
          responseItem("user", "首行很长但标题仍应保留", "2026-05-01T00:00:01Z"),
          fillBytes(
            CODEX_SCAN_FULL_PARSE_MAX_BYTES + 512 * 1024,
            JSON.stringify({
              type: "response_item",
              payload: { type: "function_call_output", output: "padding" },
            }),
          ),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.externalId, "oversized-1");
      assert.equal(s.title, "首行很长但标题仍应保留");
      assert.equal(s.createdAt, iso("2026-05-01T00:00:00Z"));
    },
  );
});

test("sampled updatedAt uses top-level timestamps only", async () => {
  await withArchive(
    [
      [
        "nested-timestamp.jsonl",
        [
          metaLine("nested-1", "/repo/nested", "2026-06-01T00:00:00Z"),
          responseItem("user", "只应使用顶层时间戳", "2026-06-01T00:00:01Z"),
          fillBytes(
            CODEX_SCAN_FULL_PARSE_MAX_BYTES + 512 * 1024,
            JSON.stringify({
              type: "response_item",
              payload: { type: "function_call_output", output: "padding" },
            }),
          ),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
              metadata: { timestamp: "2099-01-01T00:00:00Z" },
            },
          }),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.updatedAt, iso("2026-06-01T00:00:01Z"));
    },
  );
});

test("newer IDE-context synthetic prefixes fall through to the first real user message", async () => {
  // #265: 214/777 real sessions (27.5%) titled "# Context from my IDE setup:
  // ## Active file …" because only the original AGENTS.md prefix was filtered.
  const idePrefixes = [
    "# Context from my IDE setup:  ## Active file: App.tsx",
    "# In app browser: - The user has the in-app browser open.",
    "# Files mentioned by the user:  ## notes.md",
    "# Diff comments:  ## Comment 1 File: src/a.ts",
    "# Selected text:  ## Selection 1",
    "# Review findings:  ## Finding 1",
  ];
  for (const [index, prefix] of idePrefixes.entries()) {
    await withArchive(
      [
        [
          `ide-${index}.jsonl`,
          [
            metaLine(`ide-${index}`, "/repo/ide", "2026-05-01T00:00:00Z"),
            responseItem("user", prefix, "2026-05-01T00:00:01Z"),
            responseItem("user", "帮我看看这个报错", "2026-05-01T00:00:02Z"),
          ].join("\n"),
        ],
      ],
      async (dir) => {
        const [s] = await scanCodexSessions(dir);
        assert.equal(s.title, "帮我看看这个报错", `prefix: ${prefix}`);
      },
    );
  }
});

test("real markdown first messages survive even when they start with #", async () => {
  // A blanket "#" rule would erase genuinely user-pasted prompts (#265).
  await withArchive(
    [
      [
        "role.jsonl",
        [
          metaLine("role-1", "/repo/role", "2026-05-02T00:00:00Z"),
          responseItem("user", "# Role: 资深 Java 后端开发工程师\n\n## Profile", "2026-05-02T00:00:01Z"),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.match(s.title, /^# Role: 资深 Java 后端开发工程师/);
    },
  );
});

test("corrupt stored timestamps fall back to the file mtime, not the import time", async () => {
  await withArchive(
    [
      [
        "corrupt.jsonl",
        [
          metaLine("corrupt-1", "/repo/corrupt", "1e309"),
          responseItem("user", "时间戳坏掉的会话", "not-a-date"),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      // Pin the file's mtime so the expected fallback is deterministic.
      const filePath = join(dir, "corrupt.jsonl");
      const mtime = new Date("2024-05-01T08:00:00Z");
      await utimes(filePath, mtime, mtime);
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.createdAt, iso(mtime));
      assert.equal(s.updatedAt, iso(mtime));
    },
  );
});

test("the sampled path also falls back to the file mtime", async () => {
  await withArchive(
    [
      [
        "big-corrupt.jsonl",
        [
          metaLine("big-corrupt-1", "/repo/big-corrupt", "not-a-date"),
          responseItem("user", "大文件坏时间戳", "1e309"),
          fillBytes(
            CODEX_SCAN_FULL_PARSE_MAX_BYTES + 512 * 1024,
            JSON.stringify({
              type: "response_item",
              payload: { type: "function_call_output", call_id: "c1", output: "pad" },
            }),
          ),
        ].join("\n"),
      ],
    ],
    async (dir) => {
      const filePath = join(dir, "big-corrupt.jsonl");
      const mtime = new Date("2024-06-01T09:30:00Z");
      await utimes(filePath, mtime, mtime);
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.createdAt, iso(mtime));
      assert.equal(s.updatedAt, iso(mtime));
    },
  );
});
