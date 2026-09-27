#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_URL =
  process.env.PI_DESKTOP_PLUGIN_MARKET_URL ||
  "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json";

/**
 * Hosts a published package may be served from.
 *
 * Mirrors PACKAGE_HOST_ALLOWLIST in crates/host-core/src/plugins.rs. A catalog
 * that passes preflight but names a host the client refuses would be a release
 * nobody can install, so the gate is checked here rather than discovered by the
 * first user.
 */
const PACKAGE_HOST_ALLOWLIST = ["github.com", "githubusercontent.com", "cnb.cool"];

function usage() {
  console.error(
    "Usage: node scripts/check-marketplace-catalog.mjs [--url <url-or-file>] [--plugin <id>]",
  );
}

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, plugin: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--url") options.url = argv[++index] || "";
    else if (arg === "--plugin") options.plugin = argv[++index] || "";
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function readCatalog(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { "user-agent": "pi-desktop-marketplace-preflight" },
    });
    if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`);
    return JSON.parse(await response.text());
  }
  return JSON.parse(await readFile(source, "utf8"));
}

function parseSemver(value) {
  const match = String(value ?? "")
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/**
 * A published version whose file permissions carry no scope is a plugin that
 * installs and then cannot write or delete anything: the host reduces an
 * undeclared scope to nothing rather than to the whole workspace. Catching it
 * here is cheaper than a bug report from the first user who tries it.
 */
function fsScopeErrors(label, version) {
  const errors = [];
  const permissions = version.permissions.map(String);
  const fs = version.fs;
  if (fs !== undefined && (typeof fs !== "object" || fs === null || Array.isArray(fs))) {
    return [`${label}: fs must be an object`];
  }
  for (const legacy of ["fs.read.workspace", "fs.write.workspace", "fs.delete.workspace"]) {
    if (permissions.includes(legacy)) {
      errors.push(`${label}: ${legacy} predates file scopes and is downgraded on install`);
    }
  }
  for (const mode of ["write", "delete"]) {
    if (!permissions.includes(`fs.${mode}`)) continue;
    const rule = fs?.[mode];
    // `own` is a grant of its own: deleting what the plugin wrote needs no
    // scope, so a delete rule may legitimately carry nothing else.
    const declared =
      (Array.isArray(rule?.scope) && rule.scope.length > 0) ||
      rule?.root === "userSelected" ||
      (mode === "delete" && rule?.own === true);
    if (!declared) {
      errors.push(`${label}: fs.${mode} is declared with no fs.${mode} scope to go with it`);
    }
  }
  return errors;
}

function hostMatchesAllowlist(host) {
  return PACKAGE_HOST_ALLOWLIST.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * Resolve a version URL the way host-core does, then judge the host.
 *
 * A relative URL anchors to the catalog's declared `artifactBaseUrl` when it
 * has one, and otherwise to the catalog directory. Checking the resolved URL
 * rather than the raw field is what makes this preflight agree with the client.
 */
function packageUrlErrors(label, rawUrl, catalog, catalogSource) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return [`${label}: url is required`];

  let absolute = url;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    const base = String(catalog.artifactBaseUrl ?? "").trim();
    if (base) {
      absolute = `${base.endsWith("/") ? base : `${base}/`}${url.replace(/^\/+/, "")}`;
    } else if (/^https?:\/\//i.test(catalogSource)) {
      absolute = new URL(url, catalogSource).toString();
    } else {
      // A local catalog fixture resolves against the filesystem; there is no
      // host to judge and the client treats it as a local package.
      return [];
    }
  }

  if (absolute.startsWith("file://")) return [];
  let parsed;
  try {
    parsed = new URL(absolute);
  } catch {
    return [`${label}: url is not a valid URL: ${absolute}`];
  }
  if (parsed.protocol !== "https:") {
    return [`${label}: url must use https, got ${parsed.protocol}`];
  }
  if (parsed.username || parsed.password) {
    return [`${label}: url must not embed credentials`];
  }
  if (!hostMatchesAllowlist(parsed.hostname)) {
    return [
      `${label}: ${parsed.hostname} is not a package host the client will download from`,
    ];
  }
  return [];
}

const TRUST_TIERS = new Set(["verified", "community", "unknown"]);

/**
 * Checks that only apply once a catalog declares schemaVersion 2.
 *
 * A published v2 version is expected to carry the source pin the desktop shows
 * before install; without it the client falls back to "no source asserted",
 * which is exactly the state the plugin center exists to remove.
 */
function v2VersionErrors(label, version) {
  const errors = [];
  if (version.yanked === true) {
    // A withdrawn version is not installable, so its package fields are not
    // required; only the reason a user will read has to be there.
    if (!String(version.yankedReason ?? "").trim()) {
      errors.push(`${label}: a yanked version must say why it was withdrawn`);
    }
    return errors;
  }
  const provenance = version.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    errors.push(`${label}: provenance is required for a published v2 version`);
    return errors;
  }
  if (!/^https:\/\/[^\s]+$/.test(String(provenance.sourceRepository ?? ""))) {
    errors.push(`${label}: provenance.sourceRepository must be an https repository URL`);
  }
  if (!/^[a-f0-9]{40}$/i.test(String(provenance.sourceCommit ?? ""))) {
    errors.push(`${label}: provenance.sourceCommit must be a 40-character commit SHA`);
  }
  return errors;
}

function validateCatalog(catalog, pluginFilter, catalogSource) {
  const errors = [];
  if (!catalog || !Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
    return ["catalog.plugins must be a non-empty array"];
  }
  const schemaVersion = Number(catalog.schemaVersion ?? 1);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 2) {
    errors.push(`catalog.schemaVersion must be 1 or 2, got ${catalog.schemaVersion}`);
  }

  for (const plugin of catalog.plugins) {
    if (pluginFilter && plugin.id !== pluginFilter) continue;
    if (!plugin.id) errors.push("plugin is missing id");
    if (plugin.trust !== undefined && !TRUST_TIERS.has(String(plugin.trust))) {
      errors.push(`${plugin.id || "<unknown>"}: unknown trust tier ${plugin.trust}`);
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
      errors.push(`${plugin.id || "<unknown>"}: versions must be non-empty`);
      continue;
    }
    const seen = new Set();
    let installable = 0;
    for (const version of plugin.versions) {
      const label = `${plugin.id || "<unknown>"}@${version.version || "<missing>"}`;
      if (!parseSemver(version.version)) errors.push(`${label}: invalid semantic version`);
      if (seen.has(version.version)) errors.push(`${label}: duplicate version`);
      seen.add(version.version);

      if (schemaVersion >= 2) errors.push(...v2VersionErrors(label, version));

      // A withdrawn version keeps its history entry and is never downloaded,
      // so the package gate below does not apply to it.
      if (version.yanked === true) continue;
      installable += 1;

      if (!/^[a-f0-9]{64}$/i.test(String(version.shasum || ""))) {
        errors.push(`${label}: shasum must be a 64-character SHA-256 hex digest`);
      }
      errors.push(...packageUrlErrors(label, version.url, catalog, catalogSource));
      if (!Number.isInteger(version.sizeBytes) || version.sizeBytes <= 0) {
        errors.push(`${label}: sizeBytes must be a positive integer`);
      }
      if (!Array.isArray(version.permissions)) {
        errors.push(`${label}: permissions must be an array`);
      } else {
        errors.push(...fsScopeErrors(label, version));
      }
    }
    if (installable === 0) {
      errors.push(`${plugin.id || "<unknown>"}: every version is withdrawn`);
    }
  }

  if (pluginFilter && !catalog.plugins.some((plugin) => plugin.id === pluginFilter)) {
    errors.push(`plugin not found: ${pluginFilter}`);
  }
  return errors;
}

export { validateCatalog };

// Exported for tests; only run the CLI when this file is the entry point.
const invokedDirectly =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.url) throw new Error("--url requires a value");
    const catalog = await readCatalog(options.url);
    const errors = validateCatalog(catalog, options.plugin, options.url);
    if (errors.length) {
      console.error(`Marketplace catalog failed preflight: ${options.url}`);
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      const scope = options.plugin ? ` for ${options.plugin}` : "";
      const schema = Number(catalog.schemaVersion ?? 1);
      console.log(
        `Marketplace catalog v${schema} passed preflight${scope}: ${options.url}`,
      );
    }
  } catch (error) {
    usage();
    console.error(`Marketplace catalog preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
