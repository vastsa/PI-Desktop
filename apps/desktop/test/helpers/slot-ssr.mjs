import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Slot outlets rendered through Vite SSR with the production modules: the
 * app-wide slot registry, its React glue and the host components that mount
 * the slots. Registrations go into the registry instance those modules read,
 * and every one made through `register` is disposed when the test ends.
 *
 * Server rendering runs no effects: what a test sees is the first frame of a
 * mount, before any measuring, timer or listener. Behavior that needs those
 * is covered at the logic layer or in the Electron E2E.
 */
export async function slotSsr(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  // `useThemeMode` reads the theme off the document during render.
  globalThis.document = { documentElement: { dataset: {} } };
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    globalThis.document = originalDocument;
    await server.close();
  });

  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const load = (path) => server.ssrLoadModule(path);
  const { slotRegistry } = await load("/src/plugins/renderer-slots/registry.ts");
  const { SlotSessionProvider } = await load("/src/plugins/renderer-slots/use-slots.tsx");

  return {
    load,
    registry: slotRegistry,
    /** Register as `pluginId` would through `pi.slots.register`. */
    register(pluginId, registration, ownTools = []) {
      const dispose = slotRegistry.register(pluginId, registration, ownTools);
      disposers.push(dispose);
      return dispose;
    },
    /** Dispose every registration made so far. */
    clear() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    /**
     * Markup of `element` inside the providers the transcript gives it;
     * `sessionId: null` leaves the session provider out.
     */
    render(element, { sessionId = "session-1" } = {}) {
      const inSession =
        sessionId === null ? element : createElement(SlotSessionProvider, { sessionId }, element);
      return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, inSession));
    },
  };
}

/**
 * A slot component that renders the props it was given as JSON, so a test
 * reads the exact projection off the markup.
 */
export function propsProbe(label) {
  return function Probe(props) {
    return createElement("output", { "data-probe": label }, JSON.stringify(props));
  };
}

/** The JSON each probe with `label` rendered, in document order. */
export function probed(html, label) {
  return [...html.matchAll(/<output data-probe="([^"]*)">([^<]*)<\/output>/g)]
    .filter((match) => match[1] === label)
    .map((match) => parseProbe(match[2]));
}

/** The props a probe rendered, from the escaped text of its `<output>`. */
export function parseProbe(text) {
  return JSON.parse(unescapeHtml(text));
}

/** `html` with every probe emptied, so a test can compare the host markup. */
export function withoutProbeProps(html) {
  return html.replaceAll(/(<output data-probe="[^"]*">)[^<]*(<\/output>)/g, "$1$2");
}

/** `[pluginId, slot]` of every slot mount in `html`, in document order. */
export function slotMounts(html) {
  return [...html.matchAll(/data-pi-plugin="([^"]*)" data-pi-slot="([^"]*)"/g)].map((match) => [
    match[1],
    match[2],
  ]);
}

function unescapeHtml(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
