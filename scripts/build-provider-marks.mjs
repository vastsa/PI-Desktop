#!/usr/bin/env node
/**
 * Regenerate the provider brand-mark components from the vendored SVG set.
 *
 * The marks are authored as plain `.svg` under `apps/desktop/src/assets/models`
 * (see UPSTREAM.md for the source and refresh procedure) and consumed as React
 * components, so this script is mechanical: it reads each file, keeps the
 * artwork, and emits a component whose paths inherit `currentColor`.
 *
 * Why components rather than asset URLs: a CSS mask cannot paint a mark from a
 * bundled asset when the bundler inlines that asset as a `data:` URL, and the
 * inline threshold is a build detail the artwork must not depend on. Rendering
 * the paths directly also removes the mask CSS and every `img-src`/CSP question,
 * and makes a mark monochrome by construction.
 *
 * Run from the repo root:  node scripts/build-provider-marks.mjs
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS_DIR = join(ROOT, "apps", "desktop", "src", "assets", "models");
const OUTPUT = join(ROOT, "apps", "desktop", "src", "lib", "provider-marks.tsx");

/** Sibling catalog keys of one vendor; both resolve to the same artwork. */
const ALIASES = {
  openai: ["openai-codex"],
  anthropic: [],
  google: ["google-vertex"],
  xai: [],
  meta: ["meta-llama"],
  mistral: [],
  deepseek: ["deepseek-ai"],
  "alibaba-cn": ["dashscope"],
  zhipuai: [],
  // Xiaomi publishes the same mimo models from one key per billing region, so
  // all four resolve to the one artwork.
  xiaomi: ["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
  "moonshotai-cn": ["moonshotai"],
  "minimax-cn": ["minimax"],
  volcengine: ["doubao"],
  openrouter: [],
  groq: [],
  togetherai: ["together"],
};

const toComponentName = (key) =>
  `Mark${key.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase())}`;

const svgFiles = (await readdir(ASSETS_DIR)).filter((name) => name.endsWith(".svg")).sort();

const components = [];
const tableEntries = [];


for (const file of svgFiles) {
  const key = file.slice(0, -".svg".length);
  const body = await readFile(join(ASSETS_DIR, file), "utf8");

  // The artwork is a set of shapes on a viewBox; width/height/xmlns are
  // presentation the component supplies itself.
  const viewBox = /viewBox="([^"]+)"/.exec(body)?.[1];
  if (!viewBox) throw new Error(`${file} has no viewBox; cannot scale it as an icon`);
  const shapes = [...body.matchAll(/<(path|circle|rect|ellipse|polygon|polyline|g)\b[^>]*\/?>/g)]
    .map((match) => match[0])
    .join("\n      ");
  if (!shapes) throw new Error(`${file} carries no drawable shapes`);
  // Every vendored mark must stay monochrome, or a mark would render as a
  // colored logo and break the row's single visual weight.
  for (const fill of [...body.matchAll(/fill="([^"]*)"/g)].map((m) => m[1])) {
    if (fill !== "currentColor" && fill !== "none") {
      throw new Error(`${file} paints with "${fill}"; marks must be currentColor paths`);
    }
  }

  const name = toComponentName(key);
  components.push(
    [
      `/** ${key} — vendored from models.dev, see assets/models/UPSTREAM.md. */`,
      `function ${name}({ size = 16, ...props }: MarkProps) {`,
      "  return (",
      "    <svg",
      "      width={size}",
      "      height={size}",
      `      viewBox="${viewBox}"`,
      '      aria-hidden="true"',
      '      focusable="false"',
      "      {...props}",
      "    >",
      `      ${shapes}`,
      "    </svg>",
      "  );",
      "}",
    ].join("\n"),
  );
  for (const alias of [key, ...(ALIASES[key] ?? [])]) {
    tableEntries.push(`  "${alias}": ${name},`);
  }
}

const header = [
  "/**",
  " * GENERATED FILE — do not edit by hand.",
  " *",
  " * Run node scripts/build-provider-marks.mjs after changing anything under",
  " * src/assets/models. The SVG files there are the source of truth.",
  " *",
  " * Provider brand marks for the Composer model list. Keyed by the models.dev",
  " * provider key that denotes a vendor — a row's own catalogVendorKey when",
  " * present, else the provider's catalogProviderKey — so a mark is chosen by a",
  " * resolved catalog identity and never by a user-editable display name.",
  " *",
  " * Several catalog keys are the same vendor: models.dev publishes moonshotai",
  " * and moonshotai-cn as separate rows, and the vendor resolver lands on",
  " * either depending on which spelling a publisher kept in its id. They share one",
  " * artwork because a mark names the vendor, not a catalogue entry.",
  " *",
  " * The marks are monochrome currentColor paths, so each follows the theme text",
  " * color and every vendor carries the same visual weight. An unknown key has no",
  " * entry here — the caller shows the shared generic mark instead, so no row is",
  " * ever left without an identity.",
  " */",
  'import type { ReactElement, SVGProps } from "react";',
  "",
  "export type MarkProps = SVGProps<SVGSVGElement> & { size?: number };",
  "",
].join("\n");

const footer = [
  "",
  "const PROVIDER_MARKS: Readonly<Record<string, (props: MarkProps) => ReactElement>> = {",
  tableEntries.join("\n"),
  "};",
  "",
  "/** Every catalog key a mark exists for, aliases included. */",
  "export const bundledProviderMarkKeys: readonly string[] = Object.keys(PROVIDER_MARKS);",
  "",
  "/**",
  " * Mark for a vendor catalog key, or undefined when none is vendored. An",
  ' * absent key means "unknown vendor", never "broken": the caller falls back to',
  " * the shared generic mark.",
  " */",
  "export function providerMark(",
  "  catalogProviderKey: string | undefined,",
  "): ((props: MarkProps) => ReactElement) | undefined {",
  "  if (!catalogProviderKey) return undefined;",
  "  return PROVIDER_MARKS[catalogProviderKey];",
  "}",
  "",
].join("\n");

const output = `${header}\n${components.join("\n\n")}\n${footer}`;

await writeFile(OUTPUT, output);
console.log(
  `wrote ${svgFiles.length} marks (${tableEntries.length} keys) to apps/desktop/src/lib/provider-marks.tsx`,
);
