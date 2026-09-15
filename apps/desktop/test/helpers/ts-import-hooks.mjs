/**
 * Module hooks that let `node --test` import main-process TypeScript directly.
 *
 * Node strips the types itself, but the sources use bundler-style relative
 * imports: extensionless specifiers (`./plugin-mcp`) and `.js` specifiers that
 * only exist as `.ts` on disk. ESM resolution rejects both, so the exact
 * specifier is tried first and the TypeScript sibling second — a real `.js`
 * or `.mjs` file still wins, and nothing that already resolved changes.
 *
 * Register with:
 *   register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
 */
export async function resolve(specifier, context, next) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return next(specifier, context);
  }
  try {
    return await next(specifier, context);
  } catch (error) {
    const typescript = specifier.endsWith(".js")
      ? `${specifier.slice(0, -".js".length)}.ts`
      : /\.[a-z]+$/i.test(specifier)
        ? null
        : `${specifier}.ts`;
    if (typescript === null) throw error;
    return next(typescript, context);
  }
}
