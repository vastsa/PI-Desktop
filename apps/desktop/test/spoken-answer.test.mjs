import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// A spoken answer may only select among the options the question itself
// offered, and only with the question's own labels. These checks run the real
// module the Live work bridge uses.
test("a spoken answer can only select the question's own options", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const {
    MAX_ASK_OPTION_CHARS,
    MAX_ASK_QUESTION_CHARS,
    MAX_SPOKEN_QUESTION_BYTES,
    buildSpokenAnswers,
    spokenQuestion,
    toPendingQuestion,
  } = await server.ssrLoadModule("/electron/main/live-voice/spoken-answer.ts");

  const questions = [
    { question: "Which version should ship?", options: [{ label: "0.16.0-beta.1" }, "0.15.11-beta.1"] },
    { question: "How far should it go?", options: [{ label: "push main + tag" }, { label: "local only" }] },
  ];

  await t.test("the read-out is bounded, flattened and keeps the question's own options", () => {
    const pending = toPendingQuestion({ questions: [
      { question: `  Which\nversion  should ship?  `, options: ["a", { label: "b" }] },
      { question: "Multi?", options: ["x", "y"], multiSelect: true },
    ] });
    assert.deepEqual(pending, {
      questions: [
        { question: "Which version should ship?", options: ["a", "b"], multiSelect: false },
        { question: "Multi?", options: ["x", "y"], multiSelect: true },
      ],
    });
    const long = toPendingQuestion({ questions: [{
      question: "q".repeat(500),
      options: ["o".repeat(400)],
    }] });
    assert.equal(long.questions[0].question.length, MAX_ASK_QUESTION_CHARS);
    assert.equal(long.questions[0].options[0].length, MAX_ASK_OPTION_CHARS);
    assert.equal(toPendingQuestion(null), null);
    assert.equal(toPendingQuestion({ questions: [] }), null);
    assert.equal(toPendingQuestion({ questions: Array.from({ length: 9 }, () => ({ question: "q", options: ["a"] })) }), null);
  });

  await t.test("answers are matched against the question, never invented", () => {
    assert.deepEqual(buildSpokenAnswers(questions, [
      { questionIndex: 0, options: ["0.16.0-beta.1"] },
      { questionIndex: 1, options: ["push main + tag"] },
    ]), [["0.16.0-beta.1"], ["push main + tag"]]);
    // A label the question never offered.
    assert.equal(buildSpokenAnswers(questions, [
      { questionIndex: 0, options: ["0.99.0"] },
      { questionIndex: 1, options: ["push main + tag"] },
    ]), null);
    // A partial answer would silently skip the rest.
    assert.equal(buildSpokenAnswers(questions, [{ questionIndex: 0, options: ["0.16.0-beta.1"] }]), null);
    // Two answers for the same question.
    assert.equal(buildSpokenAnswers(questions, [
      { questionIndex: 0, options: ["0.16.0-beta.1"] },
      { questionIndex: 1, options: ["local only"] },
      { questionIndex: 1, options: ["push main + tag"] },
    ]), null);
    // Several labels only where the question allows several.
    assert.equal(buildSpokenAnswers(questions, [
      { questionIndex: 0, options: ["0.16.0-beta.1", "0.15.11-beta.1"] },
      { questionIndex: 1, options: ["local only"] },
    ]), null);
    assert.deepEqual(buildSpokenAnswers(
      [{ question: "Multi?", options: ["x", "y"], multiSelect: true }],
      [{ questionIndex: 0, options: ["x", "y"] }],
    ), [["x", "y"]]);
    assert.equal(buildSpokenAnswers([], []), null);
  });

  await t.test("the provider is told what to read out and what it may answer with", () => {
    const text = spokenQuestion({ questions: [
      { question: "Which version should ship?", options: ["0.16.0-beta.1", "local only"], multiSelect: false },
    ] });
    assert.match(text, /delegate_to_work_session/);
    assert.match(text, /Which version should ship\?/);
    assert.match(text, /- 0\.16\.0-beta\.1/);
    assert.match(text, /- local only/);
    assert.match(text, /never invents one/);
    assert.match(text, /not approval for a permission, Plan, or Goal request/);
    assert.match(spokenQuestion({ questions: [{ question: "Multi?", options: ["x"], multiSelect: true }] }), /choose one or more/);
    assert.equal(spokenQuestion({ questions: [] }), null);
    assert.equal(spokenQuestion(undefined), null);

    const long = spokenQuestion({ questions: Array.from({ length: 8 }, (_, index) => ({
      question: `question ${index} ${"q".repeat(280)}`,
      options: Array.from({ length: 8 }, () => "o".repeat(110)),
      multiSelect: false,
    })) });
    assert.ok(new TextEncoder().encode(long).byteLength <= MAX_SPOKEN_QUESTION_BYTES, "stays inside the delivery budget");
    assert.match(long, /delegate_to_work_session/);
    // Truncated on question boundaries: never a half-written question.
    assert.doesNotMatch(long, /question 7/);
  });
});
