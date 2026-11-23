import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
// The dialog module imports `dialog` from Electron; these tests only exercise
// the pure option and answer mapping, so a stub is enough.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === "electron") {
        return { url: "data:text/javascript,export const dialog = {};", shortCircuit: true };
      }
      return next(specifier, context);
    }
  `)}`,
);
const { desktopConsentAnswerFromResponse, desktopConsentDialogOptions } = await import(
  "../electron/main/plugin-desktop-consent.ts"
);

const request = (offerSession) => ({
  pluginId: "demo",
  pluginName: "Demo",
  operation: "agent/askTool/resolve",
  description: "Answer an Agent question.",
  args: [],
  ...(offerSession === undefined ? {} : { offerSession }),
});

test("only an offered operation gets Allow until quit", () => {
  assert.deepEqual(desktopConsentDialogOptions(request(true), "en").buttons, [
    "Deny",
    "Allow once",
    "Allow until quit",
  ]);
  for (const offer of [false, undefined]) {
    const options = desktopConsentDialogOptions(request(offer), "en");
    assert.deepEqual(options.buttons, ["Deny", "Allow once"]);
    assert.equal(options.cancelId, 0);
    assert.equal(options.defaultId, 0);
  }
});

test("dialog responses map to answers; anything unexpected is a refusal", () => {
  assert.equal(desktopConsentAnswerFromResponse(0, true), "deny");
  assert.equal(desktopConsentAnswerFromResponse(1, true), "once");
  assert.equal(desktopConsentAnswerFromResponse(2, true), "session");
  assert.equal(desktopConsentAnswerFromResponse(2, false), "deny");
  assert.equal(desktopConsentAnswerFromResponse(-1, true), "deny");
});
