import assert from "node:assert/strict";
import test from "node:test";

import {
  messageHasTranscriptContent,
  vendorAccountOmitsSessionModel,
} from "../src/lib/chat-launch-error.ts";

const oauth = (models) => [{ id: "chatgpt", authKind: "oauth", models }];

test("a launch error with no assistant text still counts as a transcript", () => {
  assert.equal(
    messageHasTranscriptContent({
      role: "assistant",
      content: "",
      error: { code: "MODEL_NOT_CONFIGURED", message: "missing" },
    }),
    true,
  );
  assert.equal(
    messageHasTranscriptContent({ role: "assistant", content: "   " }),
    false,
  );
  assert.equal(
    messageHasTranscriptContent({ role: "user", content: "hello" }),
    true,
  );
});

test("an empty vendor chat names a model the account did not return", () => {
  const session = { providerId: "chatgpt", modelId: "gpt-6-luna" };
  assert.equal(
    vendorAccountOmitsSessionModel(session, oauth([{ id: "gpt-5.6-luna" }])),
    true,
  );
  assert.equal(
    vendorAccountOmitsSessionModel(session, oauth([{ id: "openai/gpt-6-luna" }])),
    false,
  );
  assert.equal(vendorAccountOmitsSessionModel(session, oauth([])), false);
  assert.equal(
    vendorAccountOmitsSessionModel(session, [
      { id: "chatgpt", authKind: "api_key", models: [{ id: "gpt-5.6-luna" }] },
    ]),
    false,
  );
});

test("the chat surface shows that omission instead of an empty page", async () => {
  const { readFile } = await import("node:fs/promises");
  const surface = await readFile(
    new URL("../src/components/ChatSurface.tsx", import.meta.url),
    "utf8",
  );
  assert.match(surface, /messageHasTranscriptContent\(message\)/);
  assert.match(surface, /vendorAccountOmitsSessionModel\(/);
  assert.match(surface, /activeSession\.modelId/);
  assert.match(surface, /noticeError \?/);
});
