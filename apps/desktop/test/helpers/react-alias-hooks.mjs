/**
 * Resolve hook: route "react" imports to the minimal hook runtime so a hook
 * module can be driven under `node --test` without a renderer.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "react") {
    return {
      url: new URL("./react-hook-stub.mjs", import.meta.url).href,
      format: "module",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
