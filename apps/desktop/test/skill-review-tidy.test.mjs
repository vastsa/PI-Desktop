import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSkillReviewService } = await import("../electron/main/skill-review-service.ts");

const WRITE_DECISION = {
  decision: "update",
  reason: "the turn taught a flag that mattered",
  ops: [
    {
      action: "create",
      name: "npm-script",
      content: "---\nname: npm-script\ndescription: Use when adding a script.\n---\n## When to Use\n…\n",
    },
  ],
};

const SKIP_DECISION = { decision: "skip", reason: "one-off", ops: [] };

function harness({ decision = WRITE_DECISION, tidy, tidyThrows = false } = {}) {
  const calls = [];
  const logs = [];
  const host = {
    call: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "skills.list":
          return { skills: [] };
        case "skills.read":
          return { skill: null, body: null };
        case "skills.create":
          return { skill: { id: "npm-script", name: "npm-script" } };
        case "skills.tidy":
          if (tidyThrows) throw new Error("disk on fire");
          return tidy ?? { report: { references_removed: ["npm-script/references/x.md"], bytes_freed: 42 } };
        default:
          return {};
      }
    },
  };

  const review = createSkillReviewService({
    host: () => host,
    logger: { app: (category, level, event, data) => logs.push({ category, level, event, data }) },
    settings: async () => ({ defaultProviderId: "p", defaultModelId: "m" }),
    session: async () => ({
      projectPath: "/tmp/workspace",
      providerId: "p",
      modelId: "m",
      messages: [
        { role: "user", content: "add a npm script for the build" },
        { role: "assistant", content: "added it" },
      ],
    }),
    resolveLaunch: async () => ({
      providerId: "p",
      sidecarParams: {
        provider: { authKind: "api_key", baseUrl: "http://127.0.0.1:1", model: "m" },
        thinkingLevel: "off",
      },
    }),
    vendorOAuth: { resolveAuth: async () => "" },
    complete: async () => ({ text: JSON.stringify(decision) }),
    now: () => 1_000_000,
  });

  const run = () =>
    review.run({ sessionId: "session-1", usedTools: true, toolCallCount: 5, mode: "agent" });
  return { run, calls, logs };
}

test("a review that wrote consolidates the library", async () => {
  const { run, calls, logs } = harness();
  const applied = await run();

  assert.equal(applied, 1, "one op was applied");
  const methods = calls.map((call) => call.method);
  assert.ok(methods.includes("skills.create"), "the review still writes through skills.*");
  assert.ok(methods.includes("skills.tidy"), "the pass runs right after a write");

  const tidy = logs.find((entry) => entry.event === "skill library tidied");
  assert.ok(tidy, "the tidy is observable, not silent");
  assert.deepEqual(tidy.data.data, { removed: 1, bytesFreed: 42 });
});

test("a tidy that fails never undoes a review that succeeded", async () => {
  const { run, logs } = harness({ tidyThrows: true });
  const applied = await run();

  assert.equal(applied, 1, "the review's own work stands");
  const failed = logs.find((entry) => entry.event === "skill tidy failed");
  assert.ok(failed);
  assert.equal(failed.level, "warn");
});

test("a review that wrote nothing leaves the library alone", async () => {
  const { run, calls } = harness({ decision: SKIP_DECISION });
  const applied = await run();

  assert.equal(applied, 0);
  assert.ok(
    !calls.some((call) => call.method === "skills.tidy"),
    "nothing was added, so there is nothing to consolidate",
  );
});

test("the pass asks for the conservative default policy", async () => {
  const { run, calls } = harness({
    tidy: { report: { references_removed: ["npm-script/references/x.md"], bytes_freed: 42, dry_run: true } },
  });
  await run();

  const request = calls.find((call) => call.method === "skills.tidy");
  assert.ok(request, "the pass is asked for the conservative default, not a dry run");
  assert.deepEqual(request.params, {});
});
