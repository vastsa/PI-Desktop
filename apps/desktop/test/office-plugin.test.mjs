import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = "resources/plugins/pi.office";
const read = (file) => readFileSync(`${root}/${file}`, "utf8");

const manifest = JSON.parse(read("manifest.json"));
const view = read("views/index.html");
const bridge = read("views/bridge-shim.js");
const main = read("main.js");
const editorBundle = read("views/assets/index-CiXp5RFk.js");

test("bundled Office is a browser-only DOCX plugin without chat selection UI", () => {
  assert.equal(manifest.id, "pi.office");
  assert.deepEqual(manifest.permissions, ["ui.view"]);
  assert.equal(manifest.net, undefined);
  assert.match(view, /connect-src 'none'/);
  assert.match(view, /bridge-shim\.js/);
  assert.match(view, /office-toolbar-navigation\.js/);
  assert.doesNotMatch(view, /selection-actions\.js/);
  assert.doesNotMatch(view, /require\(|ipcRenderer/);
  assert.doesNotMatch(bridge, /composer\.addSelection|composer\.appendDraft/);
  assert.doesNotMatch(bridge, /require\(|ipcRenderer/);
  assert.match(main, /office\.read/);
  assert.match(main, /office\.save/);
  assert.match(main, /office\.checkConflict/);
  assert.match(main, /atomicWrite/);
});

test("bundled Office keeps its generated editor assets and attribution", () => {
  assert.equal(existsSync(`${root}/views/assets/index-CiXp5RFk.js`), true);
  assert.equal(existsSync(`${root}/views/assets/index-JQsJMU5H.css`), true);
  assert.equal(existsSync(`${root}/FONTS-README.md`), true);
  assert.equal(existsSync(`${root}/LICENSE-OFL.txt`), true);
  assert.equal(existsSync(`${root}/LICENSE-UNICODE.txt`), true);
});

test("bundled Office allows zooming down to 25 percent", () => {
  assert.match(editorBundle, /Math\.max\(25/);
  assert.match(editorBundle, /min:25,max:200/);
  assert.doesNotMatch(editorBundle, /min:50,max:200/);
});
