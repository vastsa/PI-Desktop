import assert from "node:assert/strict";
import test from "node:test";
import { createQuitConfirmation, hasRunningQuitTasks } from "../electron/main/bootstrap/quit-confirmation.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("idle quits without prompting; running tasks require consent", async () => {
  for (const running of [false, true]) {
    for (const consent of [false, true]) {
      let prompts = 0;
      let exits = 0;
      const quit = createQuitConfirmation({
        hasRunningTasks: async () => running,
        confirm: async () => { prompts++; return consent; },
        accept: () => { exits++; },
        onError: assert.fail,
      });
      await quit();
      assert.equal(prompts, Number(running));
      assert.equal(exits, Number(!running || consent));
    }
  }
});

test("repeated quit cannot bypass an open confirmation; cancel permits retry", async () => {
  const dialog = deferred();
  let prompts = 0;
  let exits = 0;
  const quit = createQuitConfirmation({
    hasRunningTasks: async () => true,
    confirm: () => { prompts++; return dialog.promise; },
    accept: () => { exits++; },
    onError: assert.fail,
  });
  const first = quit();
  await Promise.resolve();
  await quit();
  assert.equal(prompts, 1);
  assert.equal(exits, 0);
  dialog.resolve(false);
  await first;
  await quit();
  assert.equal(prompts, 2);
  assert.equal(exits, 0);
});

test("dialog errors do not authorize quitting and release the pending guard", async () => {
  let errors = 0;
  const quit = createQuitConfirmation({
    hasRunningTasks: async () => true,
    confirm: async () => { throw new Error("dialog unavailable"); },
    accept: assert.fail,
    onError: () => { errors++; },
  });
  await quit();
  await quit();
  assert.equal(errors, 2);
});

test("global turns and native runtime activity prompt; saved sessions do not", async () => {
  assert.equal(await hasRunningQuitTasks(new Map([["background", "turn"]]), assert.fail), true);
  assert.equal(await hasRunningQuitTasks(new Map(), async () => ({ sessions: [{ capabilities: { canStop: true } }] })), true);
  assert.equal(await hasRunningQuitTasks(new Map(), async () => ({ sessions: [{ capabilities: { canStop: false } }, {}] })), false);
});

test("a turn starting during native status IO still requires confirmation", async () => {
  const turns = new Map();
  const response = deferred();
  const result = hasRunningQuitTasks(turns, () => response.promise);
  turns.set("new-turn", "id");
  response.resolve({ sessions: [] });
  assert.equal(await result, true);
});
