import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The module imports its siblings the bundler way (`./tool-display`).
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  buildDiffLines,
  buildToolPresentation,
  hasToolDetails,
  langForPath,
  runOutcome,
  toolResultChips,
  toolResultPayload,
} = await import("../src/lib/tool-presentation.ts");

/** A host tool result as pi-ai delivers it: structured details plus text echo. */
function envelope(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

const roles = (blocks) => blocks.map((block) => block.role);
const byRole = (blocks, role) => blocks.find((block) => block.role === role);

test("unwraps the pi-ai envelope exactly once", () => {
  const details = { path: "a.ts", content: "line\n", root: "workspace" };
  assert.deepEqual(toolResultPayload({ toolResult: envelope(details) }), details);
  // No details: the joined content text is the payload, not the wrapper.
  assert.equal(
    toolResultPayload({
      toolResult: { content: [{ type: "text", text: "plain" }] },
    }),
    "plain",
  );
  // Imported sessions store the result as a plain string.
  assert.equal(toolResultPayload({ toolResult: "raw output" }), "raw output");
  // Nothing but the plain-text mirror.
  assert.equal(toolResultPayload({ content: "mirror" }), "mirror");
  assert.equal(toolResultPayload({}), undefined);
});

test("Read renders file content as code with a path-derived language", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Read",
      toolArgs: { path: "src/App.tsx" },
      toolResult: envelope({
        path: "src/App.tsx",
        root: "workspace",
        content: "export const App = () => null;\n",
        truncated: false,
      }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["content"]);
  const content = blocks[0];
  assert.equal(content.kind, "code");
  assert.equal(content.lang, "tsx");
  assert.equal(content.highlight, true);
  assert.equal(content.text, "export const App = () => null;\n");
});

test("Write shows the written content and a size chip", () => {
  const message = {
    toolName: "Write",
    toolArgs: { path: "notes.md", content: "# Title\n" },
    toolResult: envelope({ path: "notes.md", root: "workspace", bytes: 2048 }),
  };
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["written"]);
  assert.equal(blocks[0].lang, "md");
  assert.deepEqual(toolResultChips(message), [
    { role: "size", text: "2.0 KB" },
  ]);
});

test("Edit diffs the replacement only when no review card owns it", () => {
  const args = {
    path: "src/main.ts",
    old_string: "const a = 1;\nconst b = 2;",
    new_string: "const a = 1;\nconst b = 3;",
  };
  const scratch = buildToolPresentation({
    toolName: "Edit",
    toolArgs: args,
    toolResult: envelope({ path: "src/main.ts", root: "scratch", replacements: 1 }),
  });
  const diff = byRole(scratch, "diff");
  assert.ok(diff, "scratch edits render their own diff");
  assert.deepEqual(
    diff.lines.map((line) => `${line.type}:${line.text}`),
    ["context:const a = 1;", "del:const b = 2;", "add:const b = 3;"],
  );
  assert.equal(diff.hidden, 0);
  assert.equal(diff.copy, " const a = 1;\n-const b = 2;\n+const b = 3;");

  // A workspace edit with a review snapshot: ReviewChangeCard owns the diff.
  const reviewed = buildToolPresentation({
    role: "tool",
    toolName: "Edit",
    toolStatus: "success",
    toolArgs: args,
    toolResult: envelope({
      path: "src/main.ts",
      root: "workspace",
      replacements: 1,
      review: {
        version: 1,
        snapshotId: "snap-1",
        messageId: "msg-1",
        path: "src/main.ts",
        status: "modified",
        operation: "edit",
        state: "active",
        additions: 1,
        deletions: 1,
        hunks: [],
      },
    }),
  });
  assert.equal(byRole(reviewed, "diff"), undefined);
});

test("Bash keeps its channels apart and leaves the command to the head", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { command: "pnpm test" },
    toolResult: envelope({
      exitCode: 1,
      stdout: "3 passing\n",
      stderr: "1 failing\n",
      truncated: true,
    }),
  };
  // The row's head prints the command and copies it, so the body opens on the
  // output instead of repeating it (D226).
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["stdout", "stderr"]);
  assert.equal(byRole(blocks, "stderr").tone, "error");
  assert.equal(byRole(blocks, "stdout").tone, undefined);
  assert.deepEqual(toolResultChips(message), [
    { role: "exit", count: 1 },
    { role: "truncated" },
  ]);
  // A permission card has no head of its own, so it still shows the command.
  const asked = buildToolPresentation(message);
  assert.deepEqual(roles(asked), ["command", "stdout", "stderr"]);
  assert.equal(byRole(asked, "command").lang, "bash");
});

test("the run outcome comes from the exit code, not from the call's status", () => {
  const run = (details, toolStatus) =>
    runOutcome({
      toolName: "Bash",
      toolArgs: { command: "pnpm test" },
      ...(details === null ? {} : { toolResult: envelope(details) }),
      ...(toolStatus ? { toolStatus } : {}),
    });
  // The row must not read as done just because the call carrying it came back.
  assert.equal(run({ exitCode: 1, stdout: "", stderr: "boom" }, "success"), "failed");
  assert.equal(run({ exitCode: 0, stdout: "ok\n" }, "success"), "ok");
  // A killed shell reports no code at all; the host counts that as a failure.
  assert.equal(run({ exitCode: null, stdout: "" }, "success"), "failed");
  assert.equal(run({ exitCode: 0 }, "running"), "running");
  assert.equal(run({ exitCode: 0 }, "denied"), "denied");
  // Tools that report no exit code fall back to the call's own status.
  assert.equal(run({ ok: true }, "success"), "ok");
  assert.equal(run({ ok: false }, "error"), "failed");
  // Nothing known: the row says nothing rather than claiming success.
  assert.equal(run(null), "unknown");
});

test("a command that prints nothing does not fall back to its arguments", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { command: "true", description: "check the exit code" },
    toolResult: envelope({ exitCode: 0, stdout: "", stderr: "" }),
  };
  // Withholding the command must not hand the body an `input` block that
  // prints the same command back as an argument.
  assert.deepEqual(roles(buildToolPresentation(message, { hideSummaryArg: true })), []);
  assert.deepEqual(roles(buildToolPresentation(message)), ["command"]);
});

test("a clean run omits empty channels and the exit chip", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { command: "true" },
    toolResult: envelope({ exitCode: 0, stdout: "", stderr: "" }),
  };
  assert.deepEqual(roles(buildToolPresentation(message)), ["command"]);
  assert.deepEqual(toolResultChips(message), []);
});

test("Glob lists files and Grep groups hits by path", () => {
  const glob = {
    toolName: "Glob",
    toolArgs: { pattern: "src/**/*.ts" },
    toolResult: envelope({ matches: ["src/a.ts", "src/b.ts"], count: 2 }),
  };
  const globBlocks = buildToolPresentation(glob, { hideSummaryArg: true });
  assert.deepEqual(roles(globBlocks), ["files"]);
  assert.deepEqual(globBlocks[0].paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(toolResultChips(glob), [{ role: "files", count: 2 }]);

  const grep = {
    toolName: "Grep",
    toolArgs: { pattern: "TODO" },
    toolResult: envelope({
      matches: [
        { path: "src/a.ts", line: 4, text: "// TODO one" },
        { path: "src/a.ts", line: 9, text: "// TODO two" },
        { path: "src/b.ts", line: 1, text: "// TODO three" },
      ],
      count: 3,
    }),
  };
  const grepBlocks = buildToolPresentation(grep, { hideSummaryArg: true });
  assert.deepEqual(roles(grepBlocks), ["matches"]);
  assert.deepEqual(
    grepBlocks[0].groups.map((group) => [group.path, group.lines.length]),
    [
      ["src/a.ts", 2],
      ["src/b.ts", 1],
    ],
  );
  assert.deepEqual(toolResultChips(grep), [{ role: "matches", count: 3 }]);
});

test("Grep's other output modes and host notices stay readable", () => {
  // outputMode: "filesWithMatches" answers with paths, not hits.
  const paths = {
    toolName: "Grep",
    toolArgs: { pattern: "TODO", outputMode: "filesWithMatches" },
    toolResult: envelope({
      files: ["src/a.ts", "src/b.ts"],
      count: 7,
      truncated: false,
    }),
  };
  const pathBlocks = buildToolPresentation(paths, { hideSummaryArg: true });
  assert.deepEqual(roles(pathBlocks), ["files"]);
  assert.deepEqual(pathBlocks[0].paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(toolResultChips(paths), [{ role: "matches", count: 7 }]);

  // outputMode: "count" answers with per-file totals.
  const counted = {
    toolName: "Grep",
    toolArgs: { pattern: "TODO", outputMode: "count" },
    toolResult: envelope({
      counts: [
        { path: "src/a.ts", count: 2 },
        { path: "src/b.ts", count: 5 },
      ],
      count: 7,
      truncated: false,
    }),
  };
  const countBlocks = buildToolPresentation(counted, { hideSummaryArg: true });
  assert.deepEqual(roles(countBlocks), ["matches"]);
  assert.deepEqual(countBlocks[0].rows, [
    { label: "src/a.ts", value: "2" },
    { label: "src/b.ts", value: "5" },
  ]);

  // A scoping notice qualifies the block it follows and is not error-hued.
  const noticed = buildToolPresentation(
    {
      toolName: "Glob",
      toolArgs: { pattern: "src/**" },
      toolResult: envelope({
        matches: ["src/a.ts"],
        count: 1,
        truncated: true,
        notice: "more files match; raise limit or narrow pattern/path",
      }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(noticed), ["files", "notice"]);
  assert.equal(noticed[1].kind, "note");
  assert.match(noticed[1].text, /raise limit/);
});

test("a paginated Read window keeps its content, size and notice", () => {
  const message = {
    toolName: "Read",
    toolArgs: { path: "big.txt", offset: 200, limit: 2 },
    toolResult: envelope({
      path: "big.txt",
      root: "workspace",
      content: "line 201\nline 202",
      truncated: true,
      offset: 200,
      lineCount: 2,
      fileBytes: 2048,
      totalLines: 900,
      notice: "showing lines 201-202 of 900",
    }),
  };
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["content", "notice"]);
  assert.equal(blocks[0].text, "line 201\nline 202");
  assert.deepEqual(toolResultChips(message), [
    { role: "size", text: "2.0 KB" },
    { role: "truncated" },
  ]);
});

test("a failed tool leads with the error note and keeps the arguments", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Read",
      toolStatus: "error",
      toolArgs: { path: "missing.ts", limit: 20 },
      toolResult: envelope({ error: "no such file", code: "ENOENT" }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["error", "input"]);
  assert.deepEqual(blocks[0], {
    kind: "note",
    role: "error",
    text: "no such file",
    code: "ENOENT",
  });
  // The path is already the row summary; only the rest is repeated.
  assert.deepEqual(blocks[1].rows, [{ label: "limit", value: "20" }]);
});

test("unknown plugin payloads degrade to fields and labeled blocks, not a blob", () => {
  const blocks = buildToolPresentation({
    toolName: "plugin_issue_tracker_create",
    toolArgs: { title: "Bug" },
    toolResult: envelope({
      id: 41,
      url: "https://example.test/41",
      ok: true,
      body: "line one\nline two",
      nested: { retries: 2 },
    }),
  });
  const fields = byRole(blocks, "details");
  assert.equal(fields.kind, "fields");
  assert.deepEqual(fields.rows, [
    { label: "id", value: "41" },
    { label: "url", value: "https://example.test/41" },
    { label: "ok", value: "true" },
  ]);
  const labeled = blocks.filter((block) => block.label);
  assert.deepEqual(
    labeled.map((block) => [block.label, block.kind, block.lang]),
    [
      ["body", "code", ""],
      ["nested", "code", "json"],
    ],
  );
  // Opaque tools still show what they were called with.
  assert.deepEqual(byRole(blocks, "input").rows, [
    { label: "title", value: "Bug" },
  ]);
});

test("a string result becomes a single output block", () => {
  const blocks = buildToolPresentation({
    toolName: "Skill",
    toolArgs: { skill: "review" },
    toolResult: "loaded review skill",
  });
  const output = byRole(blocks, "output");
  assert.equal(output.kind, "code");
  assert.equal(output.text, "loaded review skill");
  assert.equal(output.highlight, false);
});

test("no known-tool block ever contains pretty-printed JSON of its payload", () => {
  const messages = [
    {
      toolName: "Read",
      toolArgs: { path: "a.ts" },
      toolResult: envelope({ path: "a.ts", content: "x\n", root: "workspace" }),
    },
    {
      toolName: "Bash",
      toolArgs: { command: "ls" },
      toolResult: envelope({ exitCode: 0, stdout: "a\nb\n", stderr: "" }),
    },
    {
      toolName: "Grep",
      toolArgs: { pattern: "x" },
      toolResult: envelope({ matches: [{ path: "a.ts", line: 1, text: "x" }], count: 1 }),
    },
  ];
  for (const message of messages) {
    for (const block of buildToolPresentation(message, { hideSummaryArg: true })) {
      if (block.kind !== "code") continue;
      assert.notEqual(block.lang, "json", `${message.toolName} fell back to JSON`);
      assert.ok(
        !block.text.includes('"content"') && !block.text.includes('"exitCode"'),
        `${message.toolName} leaked the raw payload into a block`,
      );
    }
  }
});

test("lists and diffs report what they hid instead of dropping it", () => {
  const paths = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
  const blocks = buildToolPresentation({
    toolName: "Glob",
    toolArgs: { pattern: "src/**" },
    toolResult: envelope({ matches: paths, count: paths.length }),
  });
  assert.equal(blocks[0].paths.length, 200);
  assert.equal(blocks[0].hidden, 50);

  const oldLines = Array.from({ length: 250 }, (_, i) => `old ${i}`).join("\n");
  const newLines = Array.from({ length: 250 }, (_, i) => `new ${i}`).join("\n");
  const diff = buildToolPresentation({
    toolName: "Edit",
    toolArgs: { path: "big.txt", old_string: oldLines, new_string: newLines },
    toolResult: envelope({ path: "big.txt", root: "scratch", replacements: 1 }),
  })[0];
  assert.equal(diff.lines.length, 400);
  assert.equal(diff.hidden, 100);
  // The copy payload keeps every line, so nothing is lost on copy.
  assert.equal(diff.copy.split("\n").length, 500);
});

test("huge payloads skip syntax highlighting", () => {
  const blocks = buildToolPresentation({
    toolName: "Read",
    toolArgs: { path: "huge.ts" },
    toolResult: envelope({
      path: "huge.ts",
      root: "workspace",
      content: "a".repeat(100_001),
    }),
  });
  assert.equal(blocks[0].highlight, false);
});

test("scratch root is badged so the sandboxed target is visible", () => {
  assert.deepEqual(
    toolResultChips({
      toolName: "Edit",
      toolResult: envelope({ path: "t.txt", root: "scratch", replacements: 2 }),
    }),
    [{ role: "replacements", count: 2 }, { role: "scratch" }],
  );
});

test("hasToolDetails only reports rows that can actually expand", () => {
  assert.equal(hasToolDetails({}), false);
  assert.equal(hasToolDetails({ toolArgs: {} }), false);
  assert.equal(hasToolDetails({ toolResult: envelope({}) }), false);
  assert.equal(hasToolDetails({ toolArgs: { path: "a.ts" } }), true);
  assert.equal(hasToolDetails({ toolResult: "text" }), true);
  assert.equal(hasToolDetails({ content: "mirror" }), true);
});

test("language tags come from the file name, not the payload", () => {
  assert.equal(langForPath("src/App.tsx"), "tsx");
  assert.equal(langForPath("crates/host/src/main.rs"), "rs");
  assert.equal(langForPath("Dockerfile"), "dockerfile");
  assert.equal(langForPath("Makefile"), "makefile");
  assert.equal(langForPath("LICENSE"), "");
  assert.equal(langForPath(null), "");
});

test("diff trims shared context down to the replacement", () => {
  // Identical text carries no add/del line, so the row renders no diff at all.
  assert.ok(
    buildDiffLines("same", "same").every((line) => line.type === "context"),
  );
  assert.deepEqual(
    buildDiffLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne").map((l) => l.type),
    ["context", "context", "del", "add", "context", "context"],
  );
  assert.equal(
    buildToolPresentation({
      toolName: "Edit",
      toolArgs: { path: "a.ts", old_string: "same", new_string: "same" },
      toolResult: envelope({ path: "a.ts", root: "scratch", replacements: 0 }),
    }).some((block) => block.kind === "diff"),
    false,
  );
});

test("a delegation reads as brief in, report out, counters last", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Task",
      toolArgs: {
        agent: "code-reviewer",
        description: "Review the store",
        task: "Read app-store.ts and report dead branches.",
      },
      toolResult: envelope({
        agent: "code-reviewer",
        status: "completed",
        turns: 3,
        toolCalls: 5,
      }),
    },
    { hideSummaryArg: true },
  );

  assert.deepEqual(roles(blocks), ["input", "output", "details"]);
  const brief = byRole(blocks, "input");
  assert.equal(brief.label, "task");
  assert.equal(brief.text, "Read app-store.ts and report dead branches.");
  // The report is the envelope text, not the JSON mirror of the counters.
  assert.equal(
    byRole(blocks, "output").text,
    JSON.stringify({
      agent: "code-reviewer",
      status: "completed",
      turns: 3,
      toolCalls: 5,
    }),
  );
  // `agent` already labels the row, so the footer only carries the counters.
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "status", value: "completed" },
    { label: "turns", value: "3" },
    { label: "toolCalls", value: "5" },
  ]);
});

test("a delegation whose rows are nested does not print the report twice", () => {
  const message = {
    toolName: "Task",
    toolArgs: { agent: "code-reviewer", task: "Review the store" },
    toolResult: {
      content: [{ type: "text", text: "Two dead branches." }],
      details: { agent: "code-reviewer", status: "completed", turns: 2 },
    },
  };

  assert.equal(
    byRole(buildToolPresentation(message), "output").text,
    "Two dead branches.",
  );
  // The delegate's own answer row already shows that text one level in.
  assert.equal(
    byRole(buildToolPresentation(message, { hideDelegateReport: true }), "output"),
    undefined,
  );
});

test("a failed delegation shows the error, not an empty report", () => {
  const blocks = buildToolPresentation({
    toolName: "Task",
    toolArgs: { agent: "ghost", task: "Do the thing" },
    toolStatus: "error",
    toolResult: {
      content: [{ type: "text", text: "unknown agent: ghost" }],
      details: { error: "unknown agent: ghost" },
    },
  });

  assert.equal(byRole(blocks, "output").text, "unknown agent: ghost");
  // `error` is not a counter: the report above already says it.
  assert.equal(byRole(blocks, "details"), undefined);
});

test("a lifecycle row's body is a named roster, not raw JSON (D268)", () => {
  const blocks = buildToolPresentation({
    toolName: "TaskWait",
    toolArgs: { delegationIds: ["d1", "d2"] },
    toolResult: {
      content: [{ type: "text", text: "## explorer (d1) — completed\nFound it." }],
      details: {
        delegations: [
          {
            delegationId: "d1",
            agent: "explorer",
            status: "completed",
            startedAt: 1000,
            completedAt: 4000,
            turns: 6,
          },
          { delegationId: "d2", agent: "fixer", status: "running" },
        ],
      },
    },
  });

  // The joined reports lead, then one readable line per subagent.
  assert.deepEqual(roles(blocks), ["notice", "details"]);
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "explorer", value: "completed · 3s · 6 turns" },
    { label: "fixer", value: "running" },
  ]);
  // A lifecycle row has no brief of its own, so the ids it was called with do
  // not come back as an argument block.
  assert.equal(
    blocks.some((block) => block.role === "input"),
    false,
  );
});

test("TaskStop renders its `stopped` roster the same way", () => {
  const blocks = buildToolPresentation({
    toolName: "TaskStop",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "Stopped 1 subagent." }],
      details: {
        stopped: [
          { delegationId: "s1", agent: "test-runner", status: "stopped" },
        ],
      },
    },
  });
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "test-runner", value: "stopped" },
  ]);
});
