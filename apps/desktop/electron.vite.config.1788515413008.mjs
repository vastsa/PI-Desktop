// electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
var __electron_vite_injected_dirname = "/Users/lan/Project/AI/PI-Desktop/apps/desktop";
function tightenCsp() {
  return {
    name: "pi-tighten-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(" 'unsafe-eval'", "").replace(
        /connect-src [^;]*;/,
        "connect-src 'self';"
      );
    }
  };
}
function dropLegacyFontFallbacks() {
  return {
    name: "pi-drop-legacy-font-fallbacks",
    apply: "build",
    // Must run before Vite rewrites url() into asset references, otherwise the
    // .woff/.ttf files are already registered for emission.
    enforce: "pre",
    transform(code, id) {
      if (!/\.css(?:\?.*)?$/.test(id)) return null;
      const stripped = code.replace(
        /,\s*url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
        ""
      );
      return stripped === code ? null : { code: stripped, map: null };
    }
  };
}
var electron_vite_config_default = defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Bundle JS workspace packages into Main. Only runtime modules that
        // must resolve from the packaged node_modules stay external.
        external: ["electron-updater"],
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/main/index.ts"),
          // Forked per plugin by PluginRuntime (ADR 0008); must stay a
          // standalone entry so utilityProcess can point at a real file.
          "plugin-host-process": resolve(__electron_vite_injected_dirname, "electron/main/plugin-host-process.mjs")
        }
      }
    }
  },
  preload: {
    // The preload must be a fully bundled CJS file so it can run in a
    // sandboxed renderer without Node module resolution.
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/preload/index.ts"),
          "plugin-panel": resolve(__electron_vite_injected_dirname, "electron/preload/plugin-panel.ts")
        },
        output: {
          format: "cjs",
          // Main window preload stays .cjs; plugin panels use .js as referenced by panel host.
          entryFileNames: (chunk) => chunk.name === "plugin-panel" ? "[name].js" : "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: ".",
    build: {
      // electron-vite's renderer preset hard-defaults minify to false, unlike
      // plain Vite. Enabling esbuild minification roughly halves the emitted
      // renderer chunks with no behavior change.
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "index.html")
        }
      }
    },
    plugins: [react(), tailwindcss(), tightenCsp(), dropLegacyFontFallbacks()],
    resolve: {
      alias: {
        "@renderer": resolve("src"),
        // Always read locale source so new keys work without a stale packages/*/dist.
        "@pi-desktop/i18n": resolve(__electron_vite_injected_dirname, "../../packages/i18n/src/index.ts")
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
