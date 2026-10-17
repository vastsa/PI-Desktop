/**
 * Issue #1543: the first `/` of a session must not wait for a cold host read.
 *
 * The composer reads the merged command source on the keystroke, so a fresh
 * launch opened an empty (or late) menu until the host answered. The pre-warm
 * seeds the same TTL cache while the app starts; these tests lock its retry,
 * coalescing, cancel, ceiling and failure behaviour.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const load = (relative) => import(pathToFileURL(join(here, relative)).href);

const { api } = await load("../src/lib/api.ts");
const {
  fetchComposerCommands,
  prewarmComposerCommands,
  readComposerCommandsCache,
  resetComposerCommandCache,
} = await load("../src/lib/composer-command-source.ts");

const COMMANDS = [
  { name: "compact", kind: "builtin", title: "Compact", id: "builtin.agent.compact" },
];

/** Let the pending promise callbacks of the pre-warm run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

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

test.afterEach(() => resetComposerCommandCache());

test("the pre-warm seeds the cache before the user types a slash", async () => {
  await withCommandSource(
    async () => ({ commands: COMMANDS }),
    async () => {
      const cancel = prewarmComposerCommands("/pi-1543-warm");
      await flush();
      cancel();

      const cached = readComposerCommandsCache("/pi-1543-warm");
      assert.ok(cached, "the pre-warm must leave a warm cache");
      assert.equal(cached[0].id, "builtin.agent.compact");

      let reads = 0;
      await withCommandSource(
        async () => {
          reads += 1;
          return { commands: [] };
        },
        async () => {
          const commands = await fetchComposerCommands("/pi-1543-warm");
          assert.equal(commands[0].id, "builtin.agent.compact");
          assert.equal(reads, 0, "a warm cache must not re-read the host");
        },
      );
    },
  );
});

test("the cache is keyed by workspace and expires on the TTL", async () => {
  await withCommandSource(
    async () => ({ commands: COMMANDS }),
    async () => {
      const cancel = prewarmComposerCommands("/pi-1543-ttl");
      await flush();
      cancel();

      const now = Date.now();
      assert.ok(readComposerCommandsCache("/pi-1543-ttl", now));
      assert.equal(
        readComposerCommandsCache("/pi-1543-ttl", now + 10_001),
        null,
        "a lapsed window reads as cold",
      );
      assert.equal(
        readComposerCommandsCache("/pi-1543-other", now),
        null,
        "another workspace never reuses the list",
      );
    },
  );
});

test("a pre-warm retries while the host is still booting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  await withCommandSource(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HOST_UNAVAILABLE");
      return { commands: COMMANDS };
    },
    async () => {
      const cancel = prewarmComposerCommands("/pi-1543-boot");
      await flush();
      assert.equal(attempts, 1);
      assert.equal(
        readComposerCommandsCache("/pi-1543-boot"),
        null,
        "a failed read must stay cold so the menu retries",
      );

      t.mock.timers.tick(2_000);
      await flush();
      assert.equal(attempts, 2, "the pre-warm retries after the host answers");
      assert.ok(readComposerCommandsCache("/pi-1543-boot"), "the retry seeds the cache");
      cancel();
    },
  );
});

test("the pre-warm gives up after its attempt ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  await withCommandSource(
    async () => {
      attempts += 1;
      throw new Error("HOST_UNAVAILABLE");
    },
    async () => {
      const cancel = prewarmComposerCommands("/pi-1543-ceiling");
      await flush();
      for (let round = 0; round < 15; round += 1) {
        t.mock.timers.tick(2_000);
        await flush();
      }
      assert.equal(attempts, 11, "one initial attempt plus ten retries");
      cancel();
    },
  );
});

test("cancelling the pre-warm stops the retry loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  await withCommandSource(
    async () => {
      attempts += 1;
      throw new Error("HOST_UNAVAILABLE");
    },
    async () => {
      const cancel = prewarmComposerCommands("/pi-1543-cancel");
      await flush();
      cancel();

      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(attempts, 1, "a cancelled pre-warm must stop retrying");
    },
  );
});

test("a slash typed during the pre-warm shares its host read", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withCommandSource(
    async () => {
      reads += 1;
      await gate;
      return { commands: COMMANDS };
    },
    async () => {
      const cancel = prewarmComposerCommands("/pi-1543-share");
      const typed = fetchComposerCommands("/pi-1543-share");
      release();

      const commands = await typed;
      assert.equal(reads, 1, "the pre-warm and the typed slash share one read");
      assert.equal(commands[0].id, "builtin.agent.compact");
      cancel();
    },
  );
});

test("the composer hook wires the pre-warm and leaves the cache to the source module", async () => {
  const source = await readFile(
    new URL("../src/hooks/use-composer-autocomplete.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /prewarmComposerCommands\(workspaceKey\)/,
    "the hook must seed the source while the app starts",
  );
  assert.doesNotMatch(
    source,
    /\bcommandsCache\b/,
    "the `/` source cache belongs to lib/composer-command-source",
  );
});

test("a late answer never replaces a fresher workspace entry", async () => {
  const pending = [];
  await withCommandSource(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
    async () => {
      const previous = fetchComposerCommands("/pi-1543-previous");
      const current = fetchComposerCommands("/pi-1543-current");
      assert.equal(pending.length, 2, "each workspace reads on its own");

      pending[1]({ commands: COMMANDS });
      await current;
      assert.ok(
        readComposerCommandsCache("/pi-1543-current"),
        "the current workspace is warm",
      );

      pending[0]({ commands: [] });
      await previous;
      assert.ok(
        readComposerCommandsCache("/pi-1543-current"),
        "a late answer for the previous workspace must not re-cold the current one",
      );
    },
  );
});

test("an older read does not clear the newer in-flight read for the same key", async () => {
  const pending = [];
  await withCommandSource(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    async () => {
      const stale = fetchComposerCommands("/pi-1543-repeat");
      const elsewhere = fetchComposerCommands("/pi-1543-elsewhere");
      const current = fetchComposerCommands("/pi-1543-repeat");
      assert.equal(pending.length, 3);

      pending[0].reject(new Error("HOST_UNAVAILABLE"));
      await stale.catch(() => undefined);

      const shared = fetchComposerCommands("/pi-1543-repeat");
      assert.equal(
        pending.length,
        3,
        "the newer read for that key stays the shared one",
      );

      pending[2].resolve({ commands: COMMANDS });
      await Promise.all([current, shared]);
      assert.ok(readComposerCommandsCache("/pi-1543-repeat"));
      pending[1].resolve({ commands: [] });
      await elsewhere;
    },
  );
});
