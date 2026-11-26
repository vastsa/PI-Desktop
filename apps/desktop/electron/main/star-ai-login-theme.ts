import { nativeTheme, type BrowserWindow } from "electron";
import styles from "./star-ai-login.css?raw";
import { STARAI_ORIGIN } from "./star-ai-session";

const tokens = {
  bg: "--ds-bg-primary", panel: "--ds-bg-secondary", field: "--ds-tile-hover",
  text: "--ds-text-primary", muted: "--ds-text-secondary", border: "--ds-border-default",
  accent: "--ds-accent", "accent-hover": "--ds-accent-hover", error: "--ds-error", focus: "--ds-focus",
};

// Read colors only from our own renderer. Rasterizing a pixel resolves CSS variables,
// color-mix and contributed themes into plain sRGB values usable by the native window.
export async function readStarAiLoginTheme(parent: BrowserWindow | null) {
  let scheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  let colors: Record<string, string> = {};
  if (parent && !parent.isDestroyed() && !parent.webContents.isDestroyed()) {
    try {
      const result = await parent.webContents.executeJavaScript(`(() => {
        const root = document.documentElement;
        const style = getComputedStyle(root);
        const ctx = document.createElement("canvas").getContext("2d", {willReadFrequently:true});
        const colors = {};
        for (const [name, token] of Object.entries(${JSON.stringify(tokens)})) {
          const raw = style.getPropertyValue(token).trim();
          if (!raw || !CSS.supports("color", raw)) continue;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = raw;
          ctx.fillRect(0, 0, 1, 1);
          const bytes = ctx.getImageData(0, 0, 1, 1).data;
          colors[name] = "#" + Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
        }
        return {scheme: root.dataset.theme, colors};
      })()`);
      if (result?.scheme === "dark" || result?.scheme === "light") scheme = result.scheme;
      colors = Object.fromEntries(Object.keys(tokens).flatMap((name) => {
        const value = result?.colors?.[name];
        return typeof value === "string" && /^#[0-9a-f]{8}$/i.test(value) ? [[name, value]] : [];
      }));
    } catch { /* A closing parent can no longer provide its palette. */ }
  }
  const background = colors.bg?.slice(0, 7) ?? (scheme === "dark" ? "#181818" : "#ffffff");
  const declarations = Object.entries(colors).map(([name, value]) => `--login-${name}:${value};`).join("");
  return { background, css: `${styles}\n:root { --login-scheme: ${scheme}; color-scheme: ${scheme} !important; ${declarations} }` };
}

export function attachStarAiLoginTheme(win: BrowserWindow, parent: BrowserWindow | null, initial: Awaited<ReturnType<typeof readStarAiLoginTheme>>) {
  let palette = initial;
  let ready = false;
  let painted = false;
  let generation = 0;
  let styleKey: string | undefined;
  const wc = win.webContents;
  const show = () => { if (ready && painted && !win.isDestroyed() && !win.isVisible()) win.show(); };
  async function paint() {
    const revision = ++generation;
    try {
      if (new URL(wc.getURL()).origin !== STARAI_ORIGIN) return;
      const previous = styleKey;
      const key = await wc.insertCSS(palette.css, { cssOrigin: "user" });
      if (revision !== generation) { await wc.removeInsertedCSS(key); return; }
      styleKey = key;
      if (previous) await wc.removeInsertedCSS(previous);
    } catch { /* Navigation may destroy the document while its stylesheet is being applied. */ }
    finally { if (revision === generation) { painted = true; show(); } }
  }
  const update = async () => {
    palette = await readStarAiLoginTheme(parent);
    if (win.isDestroyed()) return;
    win.setBackgroundColor(palette.background);
    await paint();
  };
  win.once("ready-to-show", () => { ready = true; show(); });
  wc.on("dom-ready", () => { styleKey = undefined; void paint(); });
  nativeTheme.on("updated", update);
  win.once("closed", () => { ++generation; nativeTheme.off("updated", update); });
}
