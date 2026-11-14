import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const sheet = await readFile(new URL("../src/components/plugins/PluginSettingsSheet.tsx", import.meta.url), "utf8");
const helpers = sheet.slice(sheet.indexOf("function initialValue("), sheet.indexOf("export function PluginSettingsSheet("));
const assignment = sheet.match(/payload\[setting\.key\] = [^\n]+;/)[0];
const source = stripTypeScriptTypes(helpers) + `
export { initialValue, serializeJson };
export function submit(draft) {
  const setting = { key: "json" };
  const payload = { json: draft };
  ${assignment}
  return payload.json;
}
`;
const { initialValue, serializeJson, submit } = await import("data:text/javascript," + encodeURIComponent(source));

for (const value of ["hello", "42", "true", "null", "", null, false, 42, ["a"], { mode: "auto" }]) {
  test(`JSON setting retains ${JSON.stringify(value)} across open/save/reset`, () => {
    const setting = { key: "json", type: "json", value, default: value };
    const opened = initialValue(setting);
    assert.deepEqual(submit(opened), value, "an untouched save must preserve the stored JSON value and type");
    const displayed = typeof opened === "string" ? opened : serializeJson(opened);
    assert.equal(displayed, JSON.stringify(value, null, 2), "the textarea must contain valid JSON text");
    const reset = initialValue({ ...setting, value: undefined });
    assert.deepEqual(submit(reset), value, "reset must preserve the declared default's type");
    assert.deepEqual(submit(initialValue({ ...setting, value: submit(JSON.stringify(value)) })), value,
      "an edited value must survive save, reopen and another untouched save");
  });
}

test("JSON settings without a stored value or default start as an empty object", () => {
  assert.deepEqual(submit(initialValue({ key: "json", type: "json" })), {});
});

test("editing JSON still rejects malformed text and accepts objects and arrays", () => {
  assert.throws(() => submit("{broken"), SyntaxError);
  assert.deepEqual(submit('{"rules": ["a"]}'), { rules: ["a"] });
  assert.deepEqual(submit('["b"]'), ["b"]);
});

test("other setting types retain their original initial values", () => {
  for (const [type, value] of [["string", "hello"], ["number", 42], ["boolean", false]]) {
    assert.equal(initialValue({ type, value }), value);
  }
});
