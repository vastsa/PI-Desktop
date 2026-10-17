import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Copy the complete split ESM bundle, then check its graph without running it. */
export async function copyAgentRuntimeBundle(source, destination) {
  const bundle = resolve(destination);
  try {
    for (const name of ["sidecar.js", "package.json"]) {
      if (!statSync(join(source, name)).isFile()) throw new Error(`${name} is not a file`);
    }
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (manifest?.type !== "module") throw new Error('package.json must declare "type": "module"');

    rmSync(bundle, { recursive: true, force: true });
    cpSync(source, bundle, { recursive: true, dereference: true });
    // Reuse the build-time parser: static imports, re-exports and literal dynamic
    // imports all need to resolve inside the copied tree, not the build workspace.
    // This output is discarded; the shipped bytes remain the original bundle.
    await build({
      entryPoints: [join(bundle, "sidecar.js")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
      plugins: [{
        name: "self-contained-agent-runtime",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (isBuiltin(args.path)) return { path: args.path, external: true };
            if (args.kind !== "entry-point" && !args.path.startsWith("./") && !args.path.startsWith("../")) {
              throw new Error(`Unbundled dependency: ${args.path}`);
            }
            const path = resolve(args.resolveDir, args.path);
            const local = relative(bundle, path);
            if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
              throw new Error(`Module outside agent-runtime bundle: ${path}`);
            }
            if (!statSync(path).isFile()) throw new Error(`Module is not a file: ${path}`);
            return { path };
          });
        },
      }],
    });
  } catch (error) {
    throw new Error(`agent-runtime bundle missing or incomplete: ${source}: ${error.message}`, { cause: error });
  }
}
