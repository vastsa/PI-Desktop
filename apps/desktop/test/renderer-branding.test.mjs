import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("app chrome uses the shared brand asset without branding the composer input", () => {
  // Renderer-sized brand marks, not the 1024px electron-builder installer icons.
  assert.match(brandLogo, /import brandLogoUrlLight from\s*"\.\.\/assets\/brand\/logo-light\.png"/);
  assert.match(brandLogo, /import brandLogoUrlDark from\s*"\.\.\/assets\/brand\/logo-dark\.png"/);
  assert.doesNotMatch(brandLogo, /\.\.\/\.\.\/build\//);
  assert.match(brandLogo, /export function BrandLogo/);
  assert.match(brandLogo, /src=\{.*brandLogoUrl/);
  assert.match(icons, /export const IconNewSession/);
  assert.doesNotMatch(icons, /IconCodexHome|IconCompose|IconPiMark|IconPiHome/);
  assert.match(chatSurface, /<HomeMascotLogo \/>/);
  assert.match(mascotLogo, /home-mascot-groups\.png/);
  assert.match(mascotLogo, /Math\.random\(\)/);
  assert.match(mascotLogo, /useState\(\(\) => chooseMascotGroupIndex\(\)\)/);
  assert.match(mascotLogo, /useState\(0\)/);
  assert.match(mascotLogo, /setTimeout/);
  assert.match(mascotLogo, /chooseMascotGroupIndex\(current\)/);
  assert.match(mascotLogo, /index !== previousIndex/);
  assert.match(mascotLogo, /FRAME_DURATION_MS = 160/);
  assert.match(mascotLogo, /randomDuration\(GROUP_PAUSE_MIN_MS, GROUP_PAUSE_MAX_MS\)/);
  assert.match(mascotLogo, /randomDuration\(STATIC_GROUP_PAUSE_MIN_MS, STATIC_GROUP_PAUSE_MAX_MS\)/);
  assert.match(mascotLogo, /const isLastFrame/);
  assert.match(mascotLogo, /useState\(false\)/);
  assert.match(mascotLogo, /isHovered\s*\?\s*FRAME_DURATION_MS/);
  assert.match(mascotLogo, /onMouseEnter=\{\(\) => setIsHovered\(true\)\}/);
  assert.match(mascotLogo, /onMouseLeave=\{\(\) => setIsHovered\(false\)\}/);
  assert.match(mascotLogo, /backgroundPosition: `-\$\{frame\}px 0`/);
  assert.match(mascotLogo, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.equal((mascotLogo.match(/startFrame:/g) ?? []).length, 9);
  assert.equal((mascotLogo.match(/frameCount:/g) ?? []).length, 9);
  assert.match(mascotLogo, /startFrame:\s*44,\s*frameCount:\s*6/);
  assert.doesNotMatch(chatSurface, /<BrandLogo/);
  assert.match(styles, /\.empty-hero-icon\s*\{[\s\S]*?height:\s*100px;[\s\S]*?width:\s*100px;/);
  assert.match(
    styles,
    /\.home-mascot-logo\s*\{[\s\S]*?background-repeat:\s*no-repeat;[\s\S]*?background-size:\s*5000px 100px;[\s\S]*?image-rendering:\s*pixelated;/,
  );
  assert.doesNotMatch(styles, /@keyframes home-mascot-group/);
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
