import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  MAX_MUTATION_MESSAGES,
  SESSION_WRITE_GRANTS,
  describeSessionWriteProblem,
  resolveSessionScope,
} = await import("../electron/main/plugin-session-access.ts");

const granted = (...names) => new Set(names);
const message = (overrides = {}) => ({
  role: "user",
  content: "hello",
  createdAt: "2026-01-01T00:00:01Z",
  ...overrides,
});

test("a session verb needs its own grant and .all wins over .own", () => {
  assert.equal(resolveSessionScope(granted(), "read"), null);
  assert.equal(resolveSessionScope(granted("session.read.own"), "read"), "own");
  assert.equal(resolveSessionScope(granted("session.read.all"), "read"), "all");
  // Declaring both never narrows the answer, and never widens `.own` by accident.
  assert.equal(
    resolveSessionScope(granted("session.read.own", "session.read.all"), "read"),
    "all",
  );
});

test("one verb's grant never lends reach to another", () => {
  const permissions = granted("session.read.all");
  assert.equal(resolveSessionScope(permissions, "read"), "all");
  assert.equal(resolveSessionScope(permissions, "update"), null);
  assert.equal(resolveSessionScope(permissions, "delete"), null);
  // `session.autoTitle` is the narrow title path and implies no session scope.
  assert.equal(resolveSessionScope(granted("session.autoTitle"), "read"), null);
});

test("message-level writes name their grant and have no .own form", () => {
  assert.deepEqual(SESSION_WRITE_GRANTS, {
    appendMessage: "session.update.all",
    replaceMessages: "session.update.all",
    deleteMessage: "session.delete.all",
    truncateFrom: "session.delete.all",
  });
  assert.equal(resolveSessionScope(granted("session.update.own"), "update"), "own");
  // `.own` never satisfies a message write: the gateway asks for the exact name.
  assert.ok(!Object.values(SESSION_WRITE_GRANTS).includes("session.update.own"));
});

test("an acceptable message-level payload passes every shape", () => {
  assert.equal(
    describeSessionWriteProblem(
      { sessionId: "s1", message: message({ id: "m1" }) },
      "message",
    ),
    null,
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", messages: [message()] }, "messages"),
    null,
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", messageId: "m1" }, "messageId"),
    null,
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", keepCount: 0 }, "truncate"),
    null,
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", fromMessageId: "m2" }, "truncate"),
    null,
  );
});

test("the session id is required before anything else is considered", () => {
  for (const sessionId of [undefined, null, "", "   ", 7, "x".repeat(129)]) {
    const problem = describeSessionWriteProblem({ sessionId, messageId: "m1" }, "messageId");
    assert.equal(problem?.code, "INVALID_PARAMS");
    assert.match(problem?.message ?? "", /sessionId/);
  }
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1" }, "messageId")?.code,
    "INVALID_PARAMS",
  );
});

test("message rows are bounded like the importer bounds them", () => {
  assert.equal(
    describeSessionWriteProblem(
      { sessionId: "s1", message: message({ role: "system" }) },
      "message",
    )?.code,
    "INVALID_PARAMS",
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", message: message({ content: 7 }) }, "message")
      ?.code,
    "INVALID_PARAMS",
  );
  assert.equal(
    describeSessionWriteProblem(
      { sessionId: "s1", message: message({ content: "x".repeat(512 * 1024 + 1) }) },
      "message",
    )?.code,
    "LIMIT_EXCEEDED",
  );
  assert.equal(
    describeSessionWriteProblem(
      { sessionId: "s1", message: message({ createdAt: "yesterday" }) },
      "message",
    )?.code,
    "INVALID_PARAMS",
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", message: message({ id: "" }) }, "message")
      ?.code,
    "INVALID_PARAMS",
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", message: undefined }, "message")?.code,
    "INVALID_PARAMS",
  );
});

test("a message array is capped at the host ceiling", () => {
  const tooMany = Array.from({ length: MAX_MUTATION_MESSAGES + 1 }, () => message());
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", messages: tooMany }, "messages")?.code,
    "LIMIT_EXCEEDED",
  );
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", messages: "nope" }, "messages")?.message,
    "messages must be an array",
  );
});

test("truncate needs exactly one bound and a sane count", () => {
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1" }, "truncate")?.message,
    "fromMessageId or keepCount is required",
  );
  for (const keepCount of [-1, 1.5, "3", null]) {
    const problem = describeSessionWriteProblem({ sessionId: "s1", keepCount }, "truncate");
    if (keepCount === null) {
      // `null` is not a bound either: the field is absent or an integer.
      assert.equal(problem?.message, "keepCount must be a non-negative integer");
    } else {
      assert.equal(problem?.message, "keepCount must be a non-negative integer");
    }
  }
  assert.equal(
    describeSessionWriteProblem({ sessionId: "s1", fromMessageId: 5 }, "truncate")?.message,
    "fromMessageId must be a string",
  );
});
