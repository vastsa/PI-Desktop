/**
 * The one React the host renderer and every plugin renderer module share.
 *
 * A plugin that brought its own React would break hooks and context in the
 * first component that mixed the two, and the failure looks like a plugin bug
 * rather than a duplicate module. The host therefore answers the bare
 * specifiers `react`, `react-dom` and `react-dom/client` from here, through a
 * document import map pointing at generated blob modules.
 *
 * The shims are generated from the live namespaces rather than a hand-written
 * list, so a hook the host can use is a hook a plugin can import; there is no
 * second surface to keep in step.
 */
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as React from "react";

/** Where the generated shims read their modules from. Not a plugin API. */
export const RENDERER_HOST_KEY = "__PI_RENDERER_HOST__";

type RendererHostModules = {
  react: typeof React;
  reactDom: typeof ReactDom;
  reactDomClient: typeof ReactDomClient;
};

export const REACT_IMPORT_MAP: Readonly<Record<string, keyof RendererHostModules>> = {
  react: "react",
  "react-dom": "reactDom",
  "react-dom/client": "reactDomClient",
};

let installed = false;

/**
 * A module that re-exports the host's namespace. One `export const x = host.x`
 * per key is what makes this work without a bundler: a bare `export *` has
 * nothing to point at, because the host's copy lives in a closure, not at a URL.
 */
function shimSource(key: keyof RendererHostModules, namespace: Record<string, unknown>): string {
  const lines = [`const host = globalThis.${RENDERER_HOST_KEY}[${JSON.stringify(key)}];`];
  if ("default" in namespace) lines.push("export default host.default;");
  for (const name of Object.keys(namespace)) {
    if (name === "default") continue;
    // Only legal binding names; React's namespace has nothing else, and a key
    // that is not one would fail the whole module rather than quietly vanish.
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    lines.push(`export const ${name} = host[${JSON.stringify(name)}];`);
  }
  return lines.join("\n");
}

function blobModuleUrl(modules: RendererHostModules, key: keyof RendererHostModules): string {
  const namespace = modules[key] as unknown as Record<string, unknown>;
  return URL.createObjectURL(
    new Blob([shimSource(key, namespace)], { type: "text/javascript" }),
  );
}

/**
 * Publish the host's React and map the three bare specifiers onto it. Called
 * once, before the first plugin module is evaluated — a plugin imported first
 * would otherwise fail to resolve `react` at all.
 */
export function installRendererImportMap(): void {
  if (installed) return;
  installed = true;
  const modules: RendererHostModules = {
    react: React,
    reactDom: ReactDom,
    reactDomClient: ReactDomClient,
  };
  (globalThis as Record<string, unknown>)[RENDERER_HOST_KEY] = modules;
  const imports: Record<string, string> = {};
  for (const [specifier, key] of Object.entries(REACT_IMPORT_MAP)) {
    imports[specifier] = blobModuleUrl(modules, key);
  }
  const script = document.createElement("script");
  script.type = "importmap";
  script.textContent = JSON.stringify({ imports });
  document.head.appendChild(script);
}

/** Test seam: allow a second install in a fresh document. */
export function resetRendererImportMap(): void {
  installed = false;
}
