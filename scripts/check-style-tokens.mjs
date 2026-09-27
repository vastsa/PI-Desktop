#!/usr/bin/env node
/**
 * Style token guard: forbids raw typography/radius literals in the desktop
 * renderer. All values must come from the token scales defined in the
 * `@theme` block of styles/tokens.css (see docs/spec/04-ux/07-ui-design-system.md).
 *
 * Checked:
 *  - CSS: font-size / font-weight / line-height / letter-spacing /
 *    border-radius values must be var(...) based (token definitions on
 *    `--custom-property` lines are exempt).
 *  - TSX: arbitrary-value utilities text-[...], rounded-[...], leading-[...],
 *    tracking-[...], font-[...] are forbidden.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "apps/desktop/src");

const CSS_PROPS = /^\s*(font-size|font-weight|line-height|letter-spacing|border-radius)\s*:\s*([^;]+);?/;
const TSX_ARBITRARY = /\b(?:text|rounded|leading|tracking|font)-\[[^\]]+\]/g;
const ALLOWED_BARE = new Set(["0", "!important", "inherit", "initial", "unset", "normal", "none"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(css|tsx)$/.test(e.name) ? [p] : [];
  });
}

function stripVars(value) {
  let prev;
  do {
    prev = value;
    value = value.replace(/var\([^()]*\)/g, " ");
  } while (value !== prev);
  return value;
}

const violations = [];

for (const file of walk(srcDir)) {
  const rel = relative(root, file);
  const lines = readFileSync(file, "utf8").split("\n");
  // `@font-face` descriptors describe the font file (weight ranges, etc.),
  // not UI typography, so they are exempt from the token scale.
  let inFontFace = 0;
  lines.forEach((line, i) => {
    if (file.endsWith(".css")) {
      if (/^\s*--/.test(line)) return; // token definition
      if (/@font-face\s*\{/.test(line)) inFontFace += 1;
      if (inFontFace > 0) {
        if (/\}/.test(line)) inFontFace -= 1;
        return;
      }
      const m = line.match(CSS_PROPS);
      if (!m) return;
      const rest = stripVars(m[2]).trim();
      const bad = rest.split(/\s+/).filter((t) => t && !ALLOWED_BARE.has(t));
      if (bad.length) {
        violations.push(`${rel}:${i + 1} raw ${m[1]} value "${m[2].trim()}" — use a token var`);
      }
    } else {
      for (const hit of line.match(TSX_ARBITRARY) ?? []) {
        violations.push(`${rel}:${i + 1} arbitrary utility "${hit}" — use a token utility class`);
      }
    }
  });
}

if (violations.length) {
  console.error("Style token violations:\n" + violations.map((v) => `  ${v}`).join("\n"));
  console.error(`\n${violations.length} violation(s). Use the scales in styles/tokens.css @theme.`);
  process.exit(1);
}
console.log("style tokens OK");
