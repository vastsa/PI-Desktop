import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  english,
  chinese,
  brandLogo,
  icons,
  sidebar,
  app,
  chatSurface,
  composer,
  styles,
  mascotLogo,
] = await Promise.all([
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../src/components/BrandLogo.tsx"),
    read("../src/components/icons.tsx"),
    read("../src/components/Sidebar.tsx"),
    read("../src/App.tsx"),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/Composer.tsx"),
    loadStyles(),
    read("../src/components/HomeMascotLogo.tsx"),
  ]);

test("renderer surfaces the PI-Desktop brand instead of the Codex shell brand", () => {
  assert.match(english, /shellName:\s*"PI-Desktop"/);
  assert.match(chinese, /shellName:\s*"PI-Desktop"/);
  assert.match(english, /placeholder:\s*"Ask PI-Desktop to help with anything"/);
  assert.match(chinese, /placeholder:\s*"让 PI-Desktop 帮你做任何事"/);
  assert.doesNotMatch(english, /shellName:\s*"Codex"/);
  assert.doesNotMatch(chinese, /shellName:\s*"Codex"/);
  // Codex remains a supported external import source, not the app identity.
  assert.match(english, /importSourceCodex:\s*"Codex"/);
  assert.match(chinese, /importSourceCodex:\s*"Codex"/);
});

test("app chrome uses the shared brand asset without branding the composer input", async () => {
  // Renderer-sized brand marks, not the 1024px electron-builder installer icons.
  assert.match(brandLogo, /import brandLogoUrlLight from\s*"\.\.\/assets\/brand\/logo-light\.png"/);
  assert.match(brandLogo, /import brandLogoUrlDark from\s*"\.\.\/assets\/brand\/logo-dark\.png"/);
  assert.doesNotMatch(brandLogo, /\.\.\/\.\.\/build\//);
  assert.match(brandLogo, /export function BrandLogo/);
  assert.match(brandLogo, /src=\{.*brandLogoUrl/);
  assert.match(icons, /export const IconNewSession/);
  assert.doesNotMatch(icons, /IconCodexHome|IconCompose|IconPiMark|IconPiHome/);
  await access(new URL("../src/assets/home-mascot-dark.gif", import.meta.url));
  await access(new URL("../src/assets/home-mascot-light.gif", import.meta.url));
  await access(new URL("../src/assets/home-mascot-still-dark.png", import.meta.url));
  await access(new URL("../src/assets/home-mascot-still-light.png", import.meta.url));
  await assert.rejects(
    () => access(new URL("../src/assets/home-mascot-groups.png", import.meta.url)),
  );
  assert.match(chatSurface, /<HomeMascotLogo \/>/);
  assert.match(mascotLogo, /import mascotMotionDarkUrl from\s*"\.\.\/assets\/home-mascot-dark\.gif"/);
  assert.match(mascotLogo, /import mascotMotionLightUrl from\s*"\.\.\/assets\/home-mascot-light\.gif"/);
  assert.match(mascotLogo, /import mascotStillDarkUrl from\s*"\.\.\/assets\/home-mascot-still-dark\.png"/);
  assert.match(mascotLogo, /import mascotStillLightUrl from\s*"\.\.\/assets\/home-mascot-still-light\.png"/);
  assert.match(mascotLogo, /className="home-mascot-logo"/);
  assert.match(mascotLogo, /aria-hidden="true"/);
  assert.match(mascotLogo, /className="home-mascot-motion home-mascot-dark"/);
  assert.match(mascotLogo, /className="home-mascot-motion home-mascot-light"/);
  assert.match(mascotLogo, /className="home-mascot-still home-mascot-dark"/);
  assert.match(mascotLogo, /className="home-mascot-still home-mascot-light"/);
  assert.doesNotMatch(mascotLogo, /<svg/);
  assert.doesNotMatch(
    mascotLogo,
    /home-mascot-groups\.png|home-mascot-orbit|Math\.random\(\)|setTimeout|backgroundPosition|onMouseEnter|onMouseLeave|useState|useEffect|matchMedia/,
  );
  assert.doesNotMatch(chatSurface, /<BrandLogo/);
  assert.match(styles, /\.empty-hero-icon\s*\{[\s\S]*?height:\s*100px;[\s\S]*?width:\s*100px;/);
  assert.match(
    styles,
    /\.home-mascot-logo\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100px;[\s\S]*?height:\s*100px;/,
  );
  assert.match(
    styles,
    /:root:not\(\[data-theme="light"\]\) \.home-mascot-logo \.home-mascot-motion\.home-mascot-dark/,
  );
  assert.match(
    styles,
    /:root\[data-theme="light"\] \.home-mascot-logo \.home-mascot-motion\.home-mascot-light/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.home-mascot-still\.home-mascot-dark,[\s\S]*?\.home-mascot-still\.home-mascot-light[\s\S]*?display:\s*block;/,
  );
  assert.doesNotMatch(styles, /@keyframes home-mascot-orbit|@keyframes home-mascot-breathe|@keyframes home-mascot-blink/);
  assert.doesNotMatch(styles, /background-size:\s*5000px 100px|image-rendering:\s*pixelated/);
  assert.doesNotMatch(composer, /<BrandLogo/);
  assert.doesNotMatch(composer, /composer-thread-mark/);
  assert.doesNotMatch(styles, /\.composer-thread-mark/);
  assert.doesNotMatch(styles, /\.composer-input-wrap\s*\{[^}]*\bgap:/s);
  assert.doesNotMatch(composer, /infinity-mark|∞/);
  assert.match(sidebar, /<BrandLogo\s+size=\{20\}/);
  assert.match(sidebar, /IconNewSession/);
  assert.match(app, /<IconNewSession\s+size=\{13\}/);
  assert.doesNotMatch(sidebar, /IconCompose|IconPiMark|IconPiHome/);
});
