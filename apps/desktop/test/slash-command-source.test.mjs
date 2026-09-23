/**
 * Issue #795 ①: a slash command must never be degraded into prompt text.
 *
 * The composer resolves a typed `/name` against the merged command source
 * (builtin + plugin + extension + skill + template) at send time. When that IPC
 * read fails the old code returned `null`, which the submit path read as "not a
 * command" — so `/compact` was sent to the model as ordinary text and the model
 * acted on it as an instruction. These tests lock the three outcomes apart.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const load = (relative) =>
  import(pathToFileURL(join(here, relative)).href);

const { resolveComposerCommand } = await load("../src/hooks/use-composer-autocomplete.ts");
const { parseSlashSubmission, resolveSlashDispatch } = await load(
  "../src/features/chat/composer/slash-dispatch.ts",
);
const { api } = await load("../src/lib/api.ts");
const { useAppStore } = await load("../src/stores/app-store.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/** Run `body` with `api.composerCommands` replaced, restoring it afterwards. */
async function withCommandSource(replacement, body) {
  const original = api.composerCommands;
  api.composerCommands = replacement;
  try {
    return await body();
  } finally {
    api.composerCommands = original;
  }
}

/** Point the store at a fresh workspace so the module-level TTL cache misses. */
function useWorkspace(path) {
  useAppStore.setState({ workspace: { path } });
}

test("an unreadable command source refuses the submission instead of sending it", async () => {
  useWorkspace("/pi-795-source-unavailable");
  await withCommandSource(
    async () => {
      throw new Error("composer/commands unavailable");
    },
    async () => {
      const resolution = await resolveComposerCommand("compact");
      assert.equal(
        resolution.status,
        "unavailable",
        "a failed source read is not an unknown command",
      );
      assert.equal(resolution.error.message, "composer/commands unavailable");

      const decision = resolveSlashDispatch(parseSlashSubmission("/compact"), resolution);
      assert.equal(decision.action, "blocked");
      assert.equal(decision.error, resolution.error);
    },
  );
});

test("a failed source read keeps every slash submission retriable", async () => {
  useWorkspace("/pi-795-source-retry");
  let attempts = 0;
  await withCommandSource(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("sidecar RPC timeout: composer.commands");
      return {
        commands: [
          { name: "compact", kind: "builtin", title: "Compact", id: "builtin.agent.compact" },
        ],
      };
    },
    async () => {
      // The failed attempt must leave the cache cold, so the retry re-reads.
      assert.equal((await resolveComposerCommand("compact")).status, "unavailable");
      const retried = await resolveComposerCommand("compact");
      assert.equal(retried.status, "resolved");
      assert.equal(retried.command.id, "builtin.agent.compact");
      assert.equal(attempts, 2);
    },
  );
});

test("an unknown alias and a template still travel as prompt text", async () => {
  useWorkspace("/pi-795-unknown");
  await withCommandSource(
    async () => ({
      commands: [
        { name: "review", kind: "skill", title: "Review", id: "skill.review" },
        { name: "plan", kind: "template", title: "Plan" },
      ],
    }),
    async () => {
      const unknown = await resolveComposerCommand("not-a-command");
      assert.equal(unknown.status, "unknown");
      assert.equal(
        resolveSlashDispatch(parseSlashSubmission("/not-a-command hello"), unknown).action,
        "prompt",
      );

      const template = await resolveComposerCommand("plan");
      assert.equal(template.status, "resolved");
      assert.equal(
        resolveSlashDispatch(parseSlashSubmission("/plan a release"), template).action,
        "prompt",
        "a prompt template is text, not a control command",
      );
    },
  );
});

test("a warm source keeps dispatching a builtin through a source blip", async () => {
  useWorkspace("/pi-795-warm");
  let calls = 0;
  await withCommandSource(
    async () => {
      calls += 1;
      return {
        commands: [
          { name: "compact", kind: "builtin", title: "Compact", id: "builtin.agent.compact" },
        ],
      };
    },
    async () => {
      const resolution = await resolveComposerCommand("compact");
      assert.equal(resolution.status, "resolved");
      const decision = resolveSlashDispatch(parseSlashSubmission("/compact now"), resolution);
      assert.equal(decision.action, "dispatch");
      assert.equal(decision.command.id, "builtin.agent.compact");
      assert.equal(decision.body, "now");
      assert.equal(calls, 1, "the first resolution fetches the source");

      await withCommandSource(
        async () => {
          throw new Error("composer/commands unavailable");
        },
        async () => {
          assert.equal((await resolveComposerCommand("compact")).status, "resolved");
          assert.equal(calls, 1, "a warm cache must not re-fetch per submission");
        },
      );
    },
  );
});

test("plain text and a bare slash stay on the prompt path", () => {
  assert.equal(parseSlashSubmission("hello"), null);
  assert.equal(parseSlashSubmission(""), null);
  assert.equal(parseSlashSubmission("/"), null);
  assert.deepEqual(parseSlashSubmission("/compact"), { name: "compact", body: "" });
  assert.deepEqual(parseSlashSubmission("/plan a release  "), {
    name: "plan",
    body: "a release",
  });
  assert.equal(resolveSlashDispatch(null, null).action, "prompt");
});

test("the submit path proves the blocked branch precedes the prompt path", async () => {
  const submit = await read(
    "../src/features/chat/composer/hooks/useComposerSubmit.ts",
  );
  assert.match(
    submit,
    /import \{[\s\S]*?parseSlashSubmission,[\s\S]*?resolveSlashDispatch,[\s\S]*?\} from "\.\.\/slash-dispatch";/,
  );
  assert.match(
    submit,
    /dispatch\.action === "blocked"[\s\S]*?showToast\(t\("chat\.slashCommandSourceUnavailable"\)[\s\S]*?return;[\s\S]*?if \(dispatch\.action === "dispatch"\)/,
  );
  const blocked = submit.indexOf('dispatch.action === "blocked"');
  const promptPath = submit.indexOf("if (!steering && !modelReady)");
  assert.ok(
    blocked > -1 && promptPath > blocked,
    "the refusal must return before the send path is reached",
  );
  assert.doesNotMatch(
    submit,
    /serializedContent\.startsWith\("\/"\)/,
    "slash detection belongs to parseSlashSubmission",
  );
});

test("the shipped locales carry the refusal copy", async () => {
  const [en, zhCN] = await Promise.all([
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);
  assert.match(en, /slashCommandSourceUnavailable:\s*"[^"]+"/);
  assert.match(zhCN, /slashCommandSourceUnavailable:\s*"[^"]+"/);
});
