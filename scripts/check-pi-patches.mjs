import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetVersion = "1.0.1";
const entries = [
  {
    name: "@earendil-works/pi-agent-core",
    patch: `patches/@earendil-works__pi-agent-core@${targetVersion}.patch`,
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-agent-core",
    markers: ["hosted_search_update", "localRequestErrorDetails"],
  },
  {
    name: "@earendil-works/pi-ai",
    patch: `patches/@earendil-works__pi-ai@${targetVersion}.patch`,
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-ai",
    markers: ["hostedSearch", "withLocalRequestErrors", "AnthropicOAuthTokenError", "Retry-After"],
  },
  {
    name: "@earendil-works/pi-coding-agent",
    patch: `patches/@earendil-works__pi-coding-agent@${targetVersion}.patch`,
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent",
    markers: ["hostedSearchReplayProjection", "estimateProjectedContextTokens"],
  },
];
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
// Proof chain that pnpm installed the patched instance: the root lockfile's
// patchedDependencies section maps `name@version` to a 64-hex patch hash, and
// the virtual-store lockfile embeds that hash in the installed snapshot's
// `version: <v>(patch_hash=<hash>)` line. realpath-based matching cannot work
// on Windows, where pnpm shortens `.pnpm` directory names (long-path limit)
// and the literal `patch_hash=` segment disappears from resolved paths
// (#1361).
const virtualStoreLockfile = readFileSync(join(root, "node_modules/.pnpm/lock.yaml"), "utf8");

for (const entry of entries) {
  if (!existsSync(join(root, entry.patch))) throw new Error(`Missing patch: ${entry.patch}`);
  const patchText = readFileSync(join(root, entry.patch), "utf8");
  if (/diff --git a\/[^\n]*package-lock\.json/.test(patchText)) {
    throw new Error(`${entry.patch} must not change unrelated upstream package-lock.json files`);
  }
  for (const marker of entry.markers) {
    if (!patchText.includes(marker)) throw new Error(`${entry.patch} is missing audited behavior marker ${marker}`);
  }
  const workspaceMapping = `'${entry.name}@${targetVersion}': ${entry.patch}`;
  if (!workspace.includes(workspaceMapping)) throw new Error(`pnpm-workspace.yaml does not map ${entry.name} to ${entry.patch}`);
  const packagePath = join(root, entry.packagePath);
  const resolved = realpathSync(packagePath);
  // The installed manifest pins the exact patched version; the hash itself
  // comes from the root lockfile's patchedDependencies entry and must be
  // embedded in the installed virtual-store snapshot (#1361).
  const installedVersion = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8")).version;
  if (installedVersion !== targetVersion) {
    throw new Error(`${entry.packagePath} resolves to ${entry.name}@${installedVersion}, expected ${targetVersion}`);
  }
  const declaredHash = lockfile.match(
    new RegExp(`'?${entry.name}@${targetVersion}'?:[ \\t]*([a-f0-9]{64})`),
  )?.[1];
  if (!declaredHash) {
    throw new Error(`pnpm-lock.yaml has no patchedDependencies hash for ${entry.name}@${targetVersion}`);
  }
  if (!virtualStoreLockfile.includes(`(patch_hash=${declaredHash}`)) {
    throw new Error(`${entry.name}@${targetVersion} installed patch hash is absent from pnpm-lock.yaml`);
  }
}

const piAiPatch = readFileSync(join(root, entries[1].patch), "utf8");
const patchedDeepseekCatalogLine = piAiPatch
  .split("\n")
  .find((line) => line.startsWith('+{"openai-completions":') && line.includes('"chat:deepseek-flash"'));
if (!patchedDeepseekCatalogLine) {
  throw new Error("Pi AI patch is missing its DeepSeek Flash transcript-capability record");
}
const patchedDeepseekCatalog = JSON.parse(patchedDeepseekCatalogLine.slice(1));
if (
  patchedDeepseekCatalog["openai-completions"]?.["chat:deepseek-flash"]?.baseUrl !== "https://api.deepseek.com" ||
  patchedDeepseekCatalog["openai-completions"]?.["chat:deepseek-flash"]?.compat?.supportsMidConvoSystemMessages !== true
) {
  throw new Error("Pi AI patch must scope mid-conversation system support to the published DeepSeek Flash endpoint");
}
for (const declarationPath of [
  "dist/index.d.ts",
  "dist/types.d.ts",
  "dist/utils/assistant-message-frame.d.ts",
  "dist/utils/estimate.d.ts",
  "dist/utils/hosted-search.d.ts",
  "dist/utils/local-request-error.d.ts",
  "dist/utils/local-request-stream.d.ts",
]) {
  if (!piAiPatch.includes(`diff --git a/${declarationPath} `)) {
    throw new Error(`Pi AI patch is missing the audited declaration file ${declarationPath}`);
  }
}

const codingAgentPatch = readFileSync(join(root, entries[2].patch), "utf8");
if (!codingAgentPatch.includes("+export declare function estimateProjectedContextTokens(")) {
  throw new Error("Pi coding-agent runtime estimator declaration is missing from its patch");
}

process.stdout.write(`All three Pi ${targetVersion} patches are mapped, locked, installed, and contain the audited contracts.\n`);
