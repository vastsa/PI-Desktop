/**
 * Desktop-owned prompt-template loading and expansion for the composer slash
 * menu (D123, ADR 0024). Keeping this adapter local avoids depending on the
 * removed pi-agent-core harness exports while preserving pi's file and argument
 * conventions.
 *
 * Discovery: `<workspace>/.pi/prompts/*.md` (project) and
 * `~/.pi/agent/prompts/*.md` (user-global); project wins name conflicts.
 */

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export type ComposerTemplateSource = "project" | "user";

export type PromptTemplate = {
  name: string;
  description?: string;
  content: string;
};

export type ComposerTemplate = PromptTemplate & {
  source: ComposerTemplateSource;
  /** Frontmatter `argument-hint`, e.g. "<file> [focus]". */
  argumentHint?: string;
};

export type ComposerTemplateDirs = {
  project?: string;
  user: string;
};

type TemplateDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed";

type TemplateDiagnostic = {
  code: TemplateDiagnosticCode;
  message: string;
  path: string;
  source: ComposerTemplateSource;
};

type LoadedTemplate = {
  promptTemplate: PromptTemplate;
  argumentHint?: string;
  source: ComposerTemplateSource;
};

type ParsedPrompt = {
  frontmatter: Record<string, unknown>;
  body: string;
};

function normalizeTemplateName(name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
  return basename.replace(/\.md$/i, "");
}

/** Template directories for a workspace (project dir absent without one). */
export function composerTemplateDirs(
  workspaceRoot: string | null | undefined,
): ComposerTemplateDirs {
  return {
    ...(workspaceRoot ? { project: join(workspaceRoot, ".pi", "prompts") } : {}),
    user: join(homedir(), ".pi", "agent", "prompts"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePrompt(raw: string): ParsedPrompt {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const parsed: unknown = parse(normalized.slice(4, endIndex)) ?? {};
  return {
    frontmatter: isRecord(parsed) ? parsed : {},
    body: normalized.slice(endIndex + 4).trim(),
  };
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolvePathKind(
  path: string,
): Promise<{ path: string; kind: "file" | "directory" } | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) return { path, kind: "file" };
    if (stats.isDirectory()) return { path, kind: "directory" };
    if (!stats.isSymbolicLink()) return undefined;
    const target = await realpath(path);
    const targetStats = await lstat(target);
    if (targetStats.isFile()) return { path, kind: "file" };
    if (targetStats.isDirectory()) return { path, kind: "directory" };
    return undefined;
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function loadTemplateFile(
  filePath: string,
  source: ComposerTemplateSource,
): Promise<{ template?: LoadedTemplate; diagnostic?: TemplateDiagnostic }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      diagnostic: {
        code: "read_failed",
        message: parseErrorMessage(error),
        path: filePath,
        source,
      },
    };
  }

  let parsed: ParsedPrompt;
  try {
    parsed = parsePrompt(raw);
  } catch (error) {
    return {
      diagnostic: {
        code: "parse_failed",
        message: parseErrorMessage(error),
        path: filePath,
        source,
      },
    };
  }

  const firstLine = parsed.body.split("\n").find((line) => line.trim());
  let description = typeof parsed.frontmatter.description === "string"
    ? parsed.frontmatter.description
    : "";
  if (!description && firstLine) {
    description = firstLine.slice(0, 60);
    if (firstLine.length > 60) description += "...";
  }
  const name = normalizeTemplateName(filePath);
  const promptTemplate: PromptTemplate = {
    name,
    description,
    content: parsed.body,
  };
  const argumentHint = typeof parsed.frontmatter["argument-hint"] === "string"
    ? parsed.frontmatter["argument-hint"]
    : undefined;
  return {
    template: {
      promptTemplate,
      ...(argumentHint ? { argumentHint } : {}),
      source,
    },
  };
}

async function loadTemplatesFromPath(
  path: string,
  source: ComposerTemplateSource,
  cwd: string,
): Promise<{ templates: LoadedTemplate[]; diagnostics: TemplateDiagnostic[] }> {
  const resolved = resolve(cwd, path);
  let info: { path: string; kind: "file" | "directory" } | undefined;
  try {
    info = await resolvePathKind(resolved);
  } catch (error) {
    return {
      templates: [],
      diagnostics: [{
        code: "file_info_failed",
        message: parseErrorMessage(error),
        path: resolved,
        source,
      }],
    };
  }
  if (!info) return { templates: [], diagnostics: [] };

  const diagnostics: TemplateDiagnostic[] = [];
  let files: string[];
  if (info.kind === "file") {
    files = info.path.endsWith(".md") ? [info.path] : [];
  } else {
    let names: string[];
    try {
      names = await readdir(info.path);
    } catch (error) {
      return {
        templates: [],
        diagnostics: [{
          code: "list_failed",
          message: parseErrorMessage(error),
          path: info.path,
          source,
        }],
      };
    }
    files = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!name.endsWith(".md")) continue;
      const filePath = join(info.path, name);
      try {
        if ((await resolvePathKind(filePath))?.kind === "file") files.push(filePath);
      } catch (error) {
        diagnostics.push({
          code: "file_info_failed",
          message: parseErrorMessage(error),
          path: filePath,
          source,
        });
      }
    }
  }

  const templates: LoadedTemplate[] = [];
  for (const file of files) {
    const fileInfo = await loadTemplateFile(file, source);
    if (fileInfo.template) templates.push(fileInfo.template);
    if (fileInfo.diagnostic) diagnostics.push(fileInfo.diagnostic);
  }
  return { templates, diagnostics };
}

/**
 * Load the merged template list for the composer "/" menu. Project templates
 * shadow user-global templates with the same name. Load failures degrade to
 * diagnostics, never throw.
 */
export async function loadComposerTemplates(
  workspaceRoot: string | null | undefined,
  overrideDirs?: ComposerTemplateDirs,
): Promise<{ templates: ComposerTemplate[]; diagnostics: string[] }> {
  const dirs = overrideDirs ?? composerTemplateDirs(workspaceRoot);
  const cwd = workspaceRoot || homedir();
  const inputs: Array<{ path: string; source: ComposerTemplateSource }> = [
    ...(dirs.project ? [{ path: dirs.project, source: "project" as const }] : []),
    { path: dirs.user, source: "user" },
  ];
  const loaded: LoadedTemplate[] = [];
  const diagnostics: TemplateDiagnostic[] = [];
  for (const input of inputs) {
    const result = await loadTemplatesFromPath(input.path, input.source, cwd);
    loaded.push(...result.templates);
    diagnostics.push(...result.diagnostics);
  }

  const byName = new Map<string, ComposerTemplate>();
  for (const { promptTemplate, argumentHint, source } of loaded) {
    const name = normalizeTemplateName(promptTemplate.name);
    if (byName.has(name)) continue;
    byName.set(name, {
      ...promptTemplate,
      name,
      source,
      ...(argumentHint ? { argumentHint } : {}),
    });
  }
  return {
    templates: [...byName.values()],
    diagnostics: diagnostics.map(
      (diagnostic) => `${diagnostic.source}:${diagnostic.code}: ${diagnostic.message} (${diagnostic.path})`,
    ),
  };
}

const PLACEHOLDER_RE = /\$\{(?:\d+|ARGUMENTS|@):-[^}]*\}|\$\{@:\d+(?::\d+)?\}|\$ARGUMENTS|\$@|\$\d+/;

export type SlashExpansion = {
  /** Expanded prompt text the model receives (persisted as `content`). */
  expanded: string;
  /** The typed invocation, e.g. "/review src/a.ts" (persisted as `command`). */
  command: string;
};

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: "'" | '"' | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Substitute pi's prompt-template positional and aggregate argument placeholders. */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget: string | undefined, defaultValue: string | undefined,
      sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
      if (defaultTarget) {
        const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS"
          ? allArgs
          : args[Number.parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue ?? "";
      }
      if (sliceStart) {
        const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
        if (sliceLength) {
          return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
        }
        return args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      if (simple) return args[Number.parseInt(simple, 10) - 1] ?? "";
      return _match;
    },
  );
}

/**
 * Expand a leading `/name args` invocation against loaded templates using
 * pi's argument grammar. Returns null when the draft is not a template
 * invocation (unknown names stay literal text, D123).
 *
 * One deliberate extension over pi: when a template has no placeholder at
 * all, non-empty arguments are appended after a blank line instead of being
 * silently dropped.
 */
export function expandSlashInvocation(
  content: string,
  templates: ReadonlyArray<Pick<ComposerTemplate, "name" | "content">>,
): SlashExpansion | null {
  if (!content.startsWith("/")) return null;
  const tokenEnd = content.search(/[\s]/);
  const token = tokenEnd === -1 ? content : content.slice(0, tokenEnd);
  const name = token.slice(1);
  if (!name) return null;
  const template = templates.find((item) => item.name === name);
  if (!template) return null;

  const rest = (tokenEnd === -1 ? "" : content.slice(tokenEnd)).trim();
  const args = parseCommandArgs(rest.replace(/[\n\r]+/g, " "));
  let expanded = substituteArgs(template.content, args);
  if (rest && !PLACEHOLDER_RE.test(template.content)) {
    expanded = `${expanded}\n\n${rest}`;
  }
  return { expanded, command: content.trim() };
}
