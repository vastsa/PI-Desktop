import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { canSubmitOAuthPrompt } = await import("../src/lib/oauth-login-prompt.ts");

const prompt = (type) => ({ promptId: "prompt-1", type, message: "Answer" });

test("optional text prompts can submit an empty answer", () => {
  assert.equal(canSubmitOAuthPrompt(prompt("text"), ""), true);
  assert.equal(canSubmitOAuthPrompt(prompt("text"), "   "), true);
});

test("required OAuth inputs still need a non-empty answer", () => {
  for (const type of ["secret", "manual_code"]) {
    assert.equal(canSubmitOAuthPrompt(prompt(type), ""), false);
    assert.equal(canSubmitOAuthPrompt(prompt(type), "   "), false);
    assert.equal(canSubmitOAuthPrompt(prompt(type), "value"), true);
  }
  assert.equal(canSubmitOAuthPrompt(prompt("select"), "value"), false);
  assert.equal(canSubmitOAuthPrompt(null, "value"), false);
});
