import assert from "node:assert/strict";
import test from "node:test";

import { resolveComposerSmartStop } from "../src/lib/composer-smart-stop.ts";

const message = (role, content = "", thinking) => ({ role, content, thinking });
const draft = {
  text: "inspect these",
  fileReferences: [
    { path: "src/one/index.ts", name: "index.ts" },
    { path: "/tmp/session scratch/index.ts", name: "index.ts" },
  ],
};

test("unanswered stop restores the structured draft and removes its user row", () => {
  const previous = message("assistant", "previous answer");
  const sent = message(
    "user",
    'inspect these\n@src/one/index.ts @"/tmp/session scratch/index.ts"',
  );
  const result = resolveComposerSmartStop(
    [previous, sent],
    { messageCountBeforeSend: 1, draft },
  );

  assert.deepEqual(result, { kind: "restore", kept: [previous], draft });
});

test("a stop before user-message projection still restores only the new draft", () => {
  const messages = [message("user", "older prompt"), message("assistant", "done")];
  const result = resolveComposerSmartStop(messages, {
    messageCountBeforeSend: messages.length,
    draft,
  });

  assert.deepEqual(result, { kind: "restore", kept: messages, draft });
});

test("assistant text, thinking, or a tool row prevents draft restoration", () => {
  const prefix = [message("user", "new prompt")];
  for (const reply of [
    message("assistant", "partial"),
    message("assistant", "", "thinking"),
    message("tool", ""),
  ]) {
    assert.deepEqual(
      resolveComposerSmartStop([...prefix, reply], {
        messageCountBeforeSend: 0,
        draft,
      }),
      { kind: "settle" },
    );
  }
});

test("legacy sends without a snapshot keep the text-only fallback", () => {
  assert.deepEqual(resolveComposerSmartStop([message("user", "plain prompt")]), {
    kind: "restore",
    kept: [],
    draft: { text: "plain prompt", fileReferences: [] },
  });
});

test("a rewritten turn restores what the user typed, not the model's prompt", () => {
  // Issue: stopping a turn that was resent by edit has no local snapshot, so
  // the fallback reads the transcript row. That row's `content` is what the
  // MODEL was given — for a template, a Skill or an `@agent` mention that is
  // the expanded prompt, not the words in the box. The user's text is in
  // `command`, and restoring `content` typed a model instruction into their
  // composer for them to send again.
  const typed = "@explorer 查一下临时会话的实现逻辑";
  const rewritten =
    'Call the `Task` tool with the agent below before answering this request. …\n' +
    'Agent: "explorer"\n\n' +
    "查一下临时会话的实现逻辑";
  const result = resolveComposerSmartStop([
    { ...message("user", rewritten), command: typed },
  ]);

  assert.equal(result.kind, "restore");
  assert.equal(result.draft.text, typed);
  assert.doesNotMatch(result.draft.text, /Call the `Task` tool/);
});

test("a rewritten template turn restores the typed form too", () => {
  // Same defect, older trigger: a `/template` expansion has the same shape,
  // so the fallback must not read `content` for any rewritten turn.
  const result = resolveComposerSmartStop([
    { ...message("user", "expanded body the model saw"), command: "/ship the docs" },
  ]);
  assert.equal(result.draft.text, "/ship the docs");
});

test("an unrewritten turn still restores its content", () => {
  // `command` is absent on an ordinary prompt, so the fallback must keep
  // using `content` there — otherwise the feature regresses for plain text.
  const result = resolveComposerSmartStop([message("user", "plain question")]);
  assert.equal(result.draft.text, "plain question");
});
