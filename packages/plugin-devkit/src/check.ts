import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LEGACY_FS_PERMISSIONS,
  PLUGIN_FS_MODES,
  PLUGIN_PERMISSIONS,
  PLUGIN_VIEW_ICONS,
  validateManifest,
  type PluginManifest,
} from "@pi-desktop/plugin-sdk";
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, walkPluginDir } from "./walk.js";

/**
 * Permissions the permission dialog surfaces as high risk. Kept in sync with
 * `RISK_BY_PERMISSION` in apps/desktop/src/pages/PluginsPage.tsx.
 */
export const HIGH_RISK_PERMISSIONS = [
  "net.fetch",
  "fs.write",
  "fs.delete",
  "agent.prompt.inject",
  "agent.tool.register",
  "browser.cdp",
] as const;

/** Host API surface each permission unlocks, used for the unused-permission hint. */
const PERMISSION_API_HINTS: Record<string, string[]> = {
  "ui.panel": ["ui.openPanel", "ui.closePanel"],
  notify: [
    "ui.notify",
    "ui.getNotificationPermission",
    "ui.requestNotificationPermission",
    "ui.showNativeNotification",
  ],
  "clipboard.read": ["clipboard.readText", "clipboard.getHistory"],
  "clipboard.write": ["clipboard.writeText"],
  "fs.read": [
    "fs.readText",
    "fs.readPreview",
    "fs.openDefault",
    "fs.reveal",
    "fs.glob",
    "fs.list",
    "fs.requestDirectory",
  ],
  "fs.write": ["fs.writeText"],
  "fs.delete": ["fs.remove"],
  "agent.tool.register": ["agent.registerTool"],
  "net.fetch": ["net.fetch"],
  "shell.openExternal": ["shell.openExternal"],
  "browser.cdp": [
    "browser.navigate",
    "browser.snapshot",
    "browser.screenshot",
    "browser.click",
    "browser.fill",
    "browser.evaluate",
    "browser.console",
    "browser.cdp",
  ],
};

export type CheckIssue = {
  /** Stable machine code, e.g. `manifest.missing` or `permission.unknown`. */
  code: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  dir: string;
  manifest?: PluginManifest;
  errors: CheckIssue[];
  warnings: CheckIssue[];
  fileCount: number;
  totalBytes: number;
};

/** Skill entries are either a bare path or an object carrying one. */
function skillPaths(manifest: PluginManifest): string[] {
  const entries = (manifest.contributes?.skills ?? []) as Array<unknown>;
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") paths.push(entry);
    else if (entry && typeof entry === "object") {
      const path = (entry as { path?: unknown }).path;
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

function isEscapingPath(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return true;
  }
  return value.split(/[\\/]/).includes("..");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Validate a plugin directory against every rule host-core enforces at install
 * time, so a clean `check` means `install` will not reject the package.
 *
 * Errors block packaging; warnings are advice a plugin author should read
 * before publishing but that will still install.
 */
export async function check(dirInput: string): Promise<CheckResult> {
  const dir = resolve(dirInput);
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const fail = (code: string, message: string): CheckResult => ({
    ok: false,
    dir,
    errors: [...errors, { code, message }],
    warnings,
    fileCount: 0,
    totalBytes: 0,
  });

  let raw: string;
  try {
    raw = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    return fail("manifest.missing", "manifest.json is missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail("manifest.invalid-json", `manifest.json is not valid JSON: ${String(error)}`);
  }

  const validated = validateManifest(parsed);
  if (!validated.ok || !validated.manifest) {
    return fail("manifest.invalid", validated.error ?? "manifest is invalid");
  }
  const manifest = validated.manifest;

  if (!(await fileExists(join(dir, manifest.main)))) {
    errors.push({
      code: "main.missing",
      message: `manifest.main "${manifest.main}" does not exist`,
    });
  }

  const panel = manifest.ui?.panel;
  if (panel && !(await fileExists(join(dir, panel)))) {
    errors.push({ code: "panel.missing", message: `ui.panel "${panel}" does not exist` });
  }

  for (const view of manifest.contributes?.views ?? []) {
    const entry = view?.entry;
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (isEscapingPath(entry)) {
      errors.push({
        code: "view.escapes",
        message: `contributes.views entry "${entry}" must be relative and must not contain ".."`,
      });
      continue;
    }
    if (!(await fileExists(join(dir, entry)))) {
      errors.push({
        code: "view.missing",
        message: `view entry "${entry}" does not exist`,
      });
      continue;
    }
    // An unknown token is not fatal — the host draws a letter tile — but it is
    // almost always a typo, and the author cannot see that from the manifest.
    if (view.icon && !PLUGIN_VIEW_ICONS.includes(view.icon as never)) {
      warnings.push({
        code: "view.unknown-icon",
        message: `view "${view.id}" names icon "${view.icon}", which is not a known token, so it renders as a letter tile`,
      });
    }
  }

  for (const path of skillPaths(manifest)) {
    if (isEscapingPath(path)) {
      errors.push({
        code: "skill.escapes",
        message: `contributes.skills path "${path}" must be relative and must not contain ".."`,
      });
      continue;
    }
    if (!(await fileExists(join(dir, path)))) {
      errors.push({ code: "skill.missing", message: `skill file "${path}" does not exist` });
      continue;
    }
    const doc = await readFile(join(dir, path), "utf8");
    if (!doc.trim()) {
      errors.push({ code: "skill.empty", message: `skill file "${path}" is empty` });
    } else if (!/^---[ \t]*\r?\n/.test(doc.replace(/^﻿/, ""))) {
      warnings.push({
        code: "skill.no-frontmatter",
        message: `skill "${path}" has no "name"/"description" front matter, so the agent gets no summary of when to apply it`,
      });
    }
  }

  const permissions = manifest.permissions ?? [];
  const known = new Set<string>(PLUGIN_PERMISSIONS);
  for (const permission of permissions) {
    if (known.has(permission)) continue;
    // The pre-scope names still install, so they are advice rather than a
    // blocker — but they are downgraded, and an author who does not read that
    // here reads it as a mysteriously refused call later.
    if (permission in LEGACY_FS_PERMISSIONS) {
      warnings.push({
        code: "permission.legacy-fs",
        message: `permission "${permission}" predates file scopes: the host rewrites it to "fs.${LEGACY_FS_PERMISSIONS[permission]}" and grants ${
          permission === "fs.read.workspace"
            ? "the whole workspace for reading"
            : permission === "fs.delete.workspace"
              ? "only the files this plugin wrote"
              : "nothing until manifest.fs says where"
        }`,
      });
      continue;
    }
    errors.push({
      code: "permission.unknown",
      message: `permission "${permission}" is not a known PI-Desktop permission`,
    });
  }
  // A write or delete permission with no declared range installs and then
  // cannot touch anything: an undeclared scope reduces to nothing, not to the
  // workspace. Same rule as the marketplace catalog preflight.
  for (const mode of PLUGIN_FS_MODES) {
    if (mode === "read" || !permissions.includes(`fs.${mode}`)) continue;
    const rule = manifest.fs?.[mode];
    const declared =
      (rule?.scope?.length ?? 0) > 0 ||
      rule?.root === "userSelected" ||
      (mode === "delete" && rule?.own === true);
    if (!declared) {
      warnings.push({
        code: "permission.fs-no-scope",
        message: `"fs.${mode}" is declared without a manifest.fs.${mode} scope, so every ${mode} asks the user${
          mode === "delete" ? ' (add a scope, or "own": true to reach what this plugin wrote)' : ""
        }`,
      });
    }
  }
  const highRisk = permissions.filter((p) =>
    (HIGH_RISK_PERMISSIONS as readonly string[]).includes(p),
  );
  if (highRisk.length) {
    warnings.push({
      code: "permission.high-risk",
      message: `high-risk permissions require an explicit user grant: ${highRisk.join(", ")}`,
    });
  }
  if (skillPaths(manifest).length && !permissions.includes("agent.prompt.inject")) {
    warnings.push({
      code: "permission.skills-inert",
      message:
        'contributes.skills is declared without "agent.prompt.inject", so the skills are never sent to the agent',
    });
  }
  if (manifest.contributes?.agentTools?.length && !permissions.includes("agent.tool.register")) {
    errors.push({
      code: "permission.tools-missing",
      message:
        'contributes.agentTools requires the "agent.tool.register" permission',
    });
  }
  if (panel && !permissions.includes("ui.panel")) {
    errors.push({
      code: "permission.panel-missing",
      message: 'ui.panel requires the "ui.panel" permission',
    });
  }
  if (manifest.contributes?.views?.length && !permissions.includes("ui.view")) {
    errors.push({
      code: "permission.views-missing",
      message: 'contributes.views requires the "ui.view" permission',
    });
  }

  const walk = await walkPluginDir(dir);
  if (walk.symlinks.length) {
    errors.push({
      code: "package.symlink",
      message: `symlinks are not allowed in a plugin package: ${walk.symlinks.slice(0, 5).join(", ")}`,
    });
  }
  if (walk.truncated) {
    errors.push({
      code: "package.too-many-files",
      message: `a plugin package may contain at most ${MAX_PACKAGE_FILES} files`,
    });
  }
  if (walk.totalBytes > MAX_PACKAGE_BYTES) {
    errors.push({
      code: "package.too-large",
      message: `a plugin package may not exceed ${MAX_PACKAGE_BYTES / (1024 * 1024)}MB`,
    });
  }

  // Entry-source hints: a declared permission that the code never exercises is
  // a needless prompt for the user, and the reverse is a runtime denial.
  const mainSource = await readFile(join(dir, manifest.main), "utf8").catch(() => "");
  if (mainSource) {
    for (const permission of permissions) {
      const apis = PERMISSION_API_HINTS[permission];
      if (!apis) continue;
      if (!apis.some((api) => mainSource.includes(api))) {
        warnings.push({
          code: "permission.unused",
          message: `permission "${permission}" is declared but ${manifest.main} never calls ${apis.join(" / ")}`,
        });
      }
    }
  }

  const contributes = manifest.contributes ?? {};
  const hasContribution = Object.values(contributes).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
  if (!hasContribution) {
    warnings.push({
      code: "contributes.empty",
      message: "the manifest contributes nothing, so the plugin has no visible effect",
    });
  }

  return {
    ok: errors.length === 0,
    dir,
    manifest,
    errors,
    warnings,
    fileCount: walk.files.length,
    totalBytes: walk.totalBytes,
  };
}
