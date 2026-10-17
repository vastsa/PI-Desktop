import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const questions = [
  {
    question: "Which **deployment** target?",
    options: ["Web", "Desktop"],
  },
  {
    question: "Which platforms should be supported?",
    options: ["macOS", "Windows", "Linux"],
    multiSelect: true,
  },
  {
    question: "Should beta updates be enabled?",
    options: ["Yes", "No"],
  },
];

const message = {
  id: "asktool-history-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-09T00:00:00.000Z",
  status: "complete",
  toolName: "asktool",
  toolCallId: "asktool-call-1",
  toolStatus: "success",
  toolArgs: { questions },
  toolResult: {
    content: [
      {
        type: "text",
        text: [
          "Which **deployment** target?：Desktop",
          "Which platforms should be supported?：macOS、Linux",
          "Should beta updates be enabled?：",
        ].join("\n---\n"),
      },
    ],
    details: { questions, answers: [["Desktop"], ["macOS", "Linux"], null] },
  },
};

test("completed asktool transcript rows show a readable Q&A summary", async (t) => {
  const ssr = await slotSsr(t, {
    translationOverrides: {
      askTool: {
        historyTitle: "Questions and answers",
        answerLabel: "Answer",
        skipped: "Skipped",
      },
    },
  });
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");

  const row = ssr.render(createElement(ToolRow, { message }));
  assert.match(row, /Which \*\*deployment\*\* target\?/);
  assert.doesNotMatch(row, /questions|options/);

  const blocks = buildToolPresentation(message);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "asktool");
  assert.deepEqual(blocks[0].questions[1].answers, ["macOS", "Linux"]);
  assert.equal(blocks[0].questions[2].answers, null);
  const details = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  assert.match(details, /tool-asktool-results/);
  assert.match(details, /Questions and answers/);
  assert.match(details, /Which <strong>deployment<\/strong> target\?/);
  assert.match(details, /Which platforms should be supported\?/);
  assert.match(details, /Should beta updates be enabled\?/);
  assert.equal((details.match(/class="tool-asktool-answer-value"/g) ?? []).length, 3);
  assert.match(details, /Answer/);
  assert.match(details, /Desktop/);
  assert.match(details, /Skipped/);
  assert.match(details, /tool-asktool-skipped/);
  assert.doesNotMatch(details, /"answers"|"questions"|<pre/);
});

test("asktool rows retain generic output when structured history is unavailable", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const legacy = buildToolPresentation({
    ...message,
    toolResult: "Which deployment target?：Desktop",
  });
  assert.ok(legacy.some((block) => block.kind === "code" && block.role === "output"));
  assert.ok(legacy.some((block) => block.role === "input"));

  const malformed = buildToolPresentation({
    ...message,
    toolResult: {
      content: [{ type: "text", text: "invalid" }],
      details: { questions: "invalid", answers: [] },
    },
  });
  assert.ok(malformed.length > 0);
  assert.notEqual(malformed[0].kind, "asktool");
});
