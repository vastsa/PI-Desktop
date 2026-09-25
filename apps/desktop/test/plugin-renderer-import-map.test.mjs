import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The shared-React import map (`docs/plugin-plan/slot-contract.html` §1): the
 * bare specifiers a plugin module imports resolve to shims over the host's
 * own React, so hooks and context work across the two. The shims are the
 * generated sources, evaluated as modules; only the document and the blob
 * store are faked.
 */
const { RENDERER_HOST_KEY, installRendererImportMap, resetRendererImportMap } = await import(
  "../src/plugins/renderer-host/import-map.ts"
);

function fakeDocument(t) {
  const scripts = [];
  const blobs = new Map();
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    createObjectURL: URL.createObjectURL,
  };
  globalThis.document = {
    createElement: (tag) => ({ tag }),
    head: { appendChild: (node) => scripts.push(node) },
  };
  URL.createObjectURL = (blob) => {
    const url = `blob:shim-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  resetRendererImportMap();
  t.after(() => {
    if (saved.document) Object.defineProperty(globalThis, "document", saved.document);
    else delete globalThis.document;
    URL.createObjectURL = saved.createObjectURL;
    delete globalThis[RENDERER_HOST_KEY];
    resetRendererImportMap();
  });
  return { scripts, blobs };
}

/** The shim behind `url`, evaluated as the module a plugin would import. */
async function evaluate(blobs, url) {
  const source = await blobs.get(url).text();
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("react, react-dom and react-dom/client resolve to the host's own modules", async (t) => {
  const { scripts, blobs } = fakeDocument(t);
  installRendererImportMap();

  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].type, "importmap");
  const { imports } = JSON.parse(scripts[0].textContent);
  assert.deepEqual(Object.keys(imports), ["react", "react-dom", "react-dom/client"]);

  const expected = { react: React, "react-dom": ReactDom, "react-dom/client": ReactDomClient };
  for (const [specifier, host] of Object.entries(expected)) {
    const shim = await evaluate(blobs, imports[specifier]);
    // Node's CommonJS interop adds a `module.exports` key, which no import
    // can name; everything else a plugin can import is the host's binding.
    const names = Object.keys(host).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    assert.ok(names.includes("default"), `${specifier} has a default export`);
    for (const name of names) assert.equal(shim[name], host[name], `${specifier}.${name}`);
  }
});

test("the map is installed once per document", (t) => {
  const { scripts } = fakeDocument(t);
  installRendererImportMap();
  installRendererImportMap();
  assert.equal(scripts.length, 1);
});

test("the page lets the shims and plugin modules load", () => {
  // A script-src without blob: blocks every plugin module at load (seen live
  // as PLUGIN_SLOT_LOAD_FAILED after a CSP security error).
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scriptSrc = html.match(/script-src([^;]*);/)?.[1] ?? "";
  assert.match(scriptSrc, /\bblob:/);
  assert.match(scriptSrc, /\bplugin-renderer:/);
});
