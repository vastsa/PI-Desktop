/**
 * Compile the view's Tailwind stylesheet.
 *
 * Tailwind v4 has no standalone CLI in this repository, so the official
 * `@tailwindcss/node` compiler is driven directly. Its `build()` takes the
 * candidate class names to emit, not file paths, so this script scans the view
 * sources first and hands the result over — the same two steps the CLI takes.
 *
 * Run from this directory: `node scripts/build-css.mjs`.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Resolve the compiler from the repository root: a plugin folder has no
 * `node_modules` of its own, and packaging must never require an install here.
 */
function loadCompiler() {
  const candidates = [
    "@tailwindcss/node",
    join(process.cwd(), "node_modules/@tailwindcss/node/dist/index.js"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next resolution path.
    }
  }
  throw new Error(
    "Tailwind's compiler is unavailable: run this from the PI-Desktop repository checkout.",
  );
}

/**
 * Candidate class names in a source file.
 *
 * A whole-file whitespace split is what the Tailwind CLI effectively does when
 * it scans a file: any token may be a candidate, and the compiler discards what
 * is not a utility. Splitting on quotes instead would break on JSX, where a
 * class list sits inside an attribute and quotes nest.
 */
function candidatesIn(source) {
  const found = new Set();
  for (const raw of source.split(/\s+/)) {
    // Strip the syntax around a class list: quotes, JSX braces, punctuation.
    const word = raw.replace(/^[^\w[]+|[^\w\-:/.[\]%]+$/g, "");
    if (!word || word.length > 200) continue;
    // A path, a URL, or an identifier is not a class name.
    if (word.includes("://") || word.includes("/") && word.startsWith(".")) continue;
    found.add(word);
  }
  return found;
}

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const viewDir = join(pluginRoot, "src/view");

const { compile } = loadCompiler();

const input = await readFile(join(viewDir, "styles.css"), "utf8");
const compiler = await compile(input, {
  base: viewDir,
  onDependency() {
    // One stylesheet; nothing to watch.
  },
});

const candidates = new Set();
for (const entry of await readdir(viewDir)) {
  if (!/\.(jsx?|tsx?|html)$/.test(entry)) continue;
  const source = await readFile(join(viewDir, entry), "utf8");
  for (const candidate of candidatesIn(source)) candidates.add(candidate);
}

const css = compiler.build([...candidates]);
if (!css.includes("@layer utilities")) {
  throw new Error("the compiled stylesheet has no utilities layer");
}

const output = join(pluginRoot, "dist/view.css");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, css, "utf8");
console.log(`dist/view.css  ${(css.length / 1024).toFixed(1)} KB  (${candidates.size} candidates)`);
