import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readRoot = (path) =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("provider failures stay in the transcript as structured assistant messages", async () => {
  const [runtime, store, main] = await Promise.all([
    readRoot("packages/agent-runtime/src/runtime.ts"),
    read("src/stores/app-store.ts"),
    read("electron/main/index.ts"),
  ]);

  assert.match(runtime, /error:\s*classifiedError,\s*isError:\s*true/);
  assert.match(runtime, /m\.status === "error" \|\| m\.isError \|\| m\.error/);
  assert.match(store, /!event\.message\.error/);
  assert.match(store, /assistantErrorMessage\(event\.error\)/);
  assert.match(main, /failed && empty && !event\.message\.error/);
});

test("assistant error messages expose readable provider details and one Continue action", async () => {
  const transcript = await read("src/components/ChatTranscript.tsx");
  const component = transcript.slice(
    transcript.indexOf("function AssistantErrorMessage"),
    transcript.indexOf("const TOOL_ACTION_KEYS"),
  );

  assert.match(component, /function AssistantErrorMessage/);
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /error\.message/);
  assert.match(component, /message\.providerId/);
  assert.match(component, /message\.modelId/);
  assert.match(component, /copyErrorDetails/);
  assert.doesNotMatch(component, /retryLastPrompt/);
  assert.doesNotMatch(component, /error\.retriable/);
  assert.doesNotMatch(component, /errors\.action\.retry/);
  assert.match(component, /errors\.action\.continue/);
  assert.match(component, /chat\.continueCurrentTaskPrompt/);
  assert.match(component, /setSettingsTab\("agent"\)/);
});
