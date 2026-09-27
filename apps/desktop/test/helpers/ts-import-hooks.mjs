/**
 * Module hooks that let `node --test` import main-process TypeScript directly.
 *
 * Node strips the types itself, but the sources use bundler-style extensionless
 * relative imports (`./plugin-mcp`), which ESM resolution rejects. Retrying the
 * specifier with a `.ts` extension is enough to load them without a build step.
 *
 * Register with:
 *   register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Not a TypeScript sibling; fall through to the default resolution.
    }
  }
  return next(specifier, context);
}
