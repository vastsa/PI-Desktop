import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  raceWithTimeout,
  UPDATE_CHECK_TIMEOUT_CODE,
} = await import("../electron/main/update-timeout.ts");

test("raceWithTimeout settles without cancelling the slower work", async () => {
  let finished = false;
  const slow = new Promise((resolve) => {
    setTimeout(() => {
      finished = true;
      resolve("late");
    }, 40);
  });
  await assert.rejects(raceWithTimeout(slow, 5, "update check"), (error) => {
    assert.equal(error.code, UPDATE_CHECK_TIMEOUT_CODE);
    assert.match(error.message, /update check timed out/);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, true);
});
