import assert from "node:assert/strict";
import test from "node:test";

import {
  appendComposerBlock,
  resolveComposerSmartStop,
} from "../src/lib/composer-smart-stop.ts";

const message = (role, content = "", thinking) => ({ role, content, thinking });
const draft = {
  text: "inspect these",
  fileReferences: [
    { path: "src/one/index.ts", name: "index.ts" },
    { path: "/tmp/session scratch/index.ts", name: "index.ts" },
  ],
};

test("composer blocks append without changing the existing draft", () => {
  assert.equal(appendComposerBlock("Keep this", "> quote"), "Keep this\n\n> quote");
  assert.equal(appendComposerBlock("Keep this\n", "> quote"), "Keep this\n\n> quote");
  assert.equal(appendComposerBlock("Keep this\n\n", "> quote"), "Keep this\n\n> quote");
  assert.equal(appendComposerBlock("", "> quote"), "> quote");
});

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
