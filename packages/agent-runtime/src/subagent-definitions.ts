/**
 * Where subagent definitions come from, and how a definition's model pin turns
 * into a usable provider binding (ADR 0062).
 *
 * Discovery has two sources, in shadowing order: the user's global
 * `~/.agents/subagents/*.md` documents handed in by Electron main (D202), and
 * the definitions PI-Desktop ships. Project workspaces never provide subagents;
 * a repository cannot silently add a delegate to a user's agent catalog.
 *
 * Builtins are inline rather than packaged resource files. There are a handful
 * of them, they must exist in every install for the `Task` tool to be worth
 * offering, and a missing-file fallback path is a worse failure mode than a
 * constant.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mergeSubagentDefinitions,
  parseSubagentDefinition,
  subagentModelKey,
  subagentPinnedProviders,
  OAUTH_AUTH_KIND,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import {
  resolvePiModelConfig,
  resolveThinkingCapabilities,
} from "./model-capabilities.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import type { PiModelConfig, ThinkingCapabilitySet } from "./thinking-level.js";

/**
 * What a signed-in vendor account says about one of its models. Resolved by
 * Electron main against the authenticated pi-ai collection, because the
 * builtin catalog knows neither a gateway's dynamic model list nor which wire
 * API a given account serves a model over.
 */
export type VendorModelBinding = ThinkingCapabilitySet & {
  apiStyle: string;
  baseUrl: string;
  modelConfig: PiModelConfig;
};

/** Global directory for user-owned definitions; project roots are not consulted. */
export function subagentDefinitionDir(_workspaceRoot: string): string {
  return join(homedir(), ".agents", "subagents");
}

/**
 * Definitions PI-Desktop ships. Each one earns its prompt-token cost by being
 * a delegation the main agent would otherwise do inline at full context cost:
 * fast codebase navigation, a second opinion on a diff, running a test
 * command, and — for `fixer` — implementing a multi-file change in its own
 * context (ADR 0089).
 */
export const BUILTIN_SUBAGENT_DOCUMENTS: readonly string[] = [
  `---
name: explorer
description: Fast codebase search and pattern matching — find files, locate implementations and answer "where is X?" / "how does Y work?". Use when answering needs a sweep over many files and you only want the conclusion.
tools: [Read, Glob, Grep, Bash]
maxTurns: 60
---

You are Explorer — a fast codebase navigation specialist.

- Prefer Grep for text/regex patterns (strings, symbols, comments), Glob for
  file discovery by name or extension, Read for specific files.
- Fire several searches in parallel when the answer needs more than one place.
- Follow definitions and call sites; do not stop at the first hit if the
  question implies more than one place.
- Quote the few lines that answer the question and cite \`path:line\` for each.

Report in this shape:

<files>
- src/app.ts:42 — brief description of what's there
</files>
<answer>
Concise answer to the question. If you could not find it, say what you
searched and where the trail went cold — a precise dead end is more useful
than a guess.
</answer>`,
  `---
name: code-reviewer
description: Review specific code or a specific change for defects. Use for a second opinion on correctness, edge cases and missing tests before you commit.
tools: [Read, Glob, Grep]
maxTurns: 50
---

Review only what the task names, and read enough surrounding code to judge it.

- Prefer defects that change behavior: wrong results, unhandled failures,
  broken invariants, races, resource leaks, missing test coverage.
- Check the code against how its callers and neighbors actually use it, not
  against a style preference.
- Say nothing about formatting, naming or structure unless it causes a defect.

Report: each finding as \`path:line\` plus one sentence on what breaks and under
what input. Order by severity. If the code is sound, say so plainly and name
the cases you checked — an empty review with no evidence is not a review.`,
  `---
name: test-runner
description: Run a specific test or build command and report what failed and why. Use when a command's output is long and only the failures matter.
tools: [Read, Glob, Grep, Bash]
maxTurns: 40
---

Run the command the task names. Do not invent a different one, and do not fix
anything: diagnosis is the deliverable.

- Run the command once. If it fails to start (missing script, wrong directory),
  find the right invocation and say what you changed.
- For each failure, read the failing test and the code under it far enough to
  name the cause.

Report: pass/fail counts, then one entry per failure with the test name, the
assertion or error, and the \`path:line\` you believe is responsible. Keep the
raw output out of the report except for the lines that carry the failure.`,
  `---
name: fixer
description: Implement a complete multi-file change from a spec. Use when a feature or fix spans several files and the work is separable — it can write files inside the workspace while you keep working.
tools: [Read, Glob, Grep, Edit, Write, Bash]
maxTurns: 80
---

You are Fixer — a fast, focused implementation specialist. The main agent
delegates a complete, self-contained spec; implement it. Do not re-plan and do
not research beyond what the task needs.

- Read every file you will change first; never Edit or Write from memory or
  from stale content.
- Keep changes minimal and scoped to the task. Do not touch unrelated code.
- You may write inside the workspace; never write outside it. Prefer the
  workspace-relative paths the main agent gave you.
- Run the relevant validation when it is clearly applicable (test, build or
  lint command the task names); otherwise report it skipped with a reason.
- Do not delegate, do not ask the user, do not search the web. If the spec
  lacks context you truly need, use Grep/Glob/Read yourself.

Report in this shape:

<summary>
2-3 sentences: what was implemented and the outcome.
</summary>
<changes>
- path/file.ts: what changed (function or line level)
</changes>
<verification>
- Tests: [passed / failed / skipped: reason]
- Validation: [passed / failed / skipped: reason]
</verification>`,
];

/** Parsed builtins, rebuilt per call so a bad constant surfaces as a
 * diagnostic in exactly the same way a bad project document does. */
function builtinSubagents(): {
  definitions: SubagentDefinition[];
  diagnostics: string[];
} {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  for (const raw of BUILTIN_SUBAGENT_DOCUMENTS) {
    const parsed = parseSubagentDefinition(raw, { source: "builtin" });
    if (parsed.ok) definitions.push(parsed.definition);
    else diagnostics.push(`builtin subagent invalid: ${parsed.errors.join("; ")}`);
  }
  return { definitions, diagnostics };
}

async function loadGlobalSubagents(
  dir: string,
): Promise<{ definitions: SubagentDefinition[]; diagnostics: string[] }> {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /\.md$/i.test(name)).sort();
  } catch {
    // No `~/.agents/subagents` directory is the common case, not an error.
    return { definitions, diagnostics };
  }
  for (const name of names) {
    const filePath = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      diagnostics.push(
        `${filePath}: unreadable (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    const parsed = parseSubagentDefinition(raw, {
      source: "user",
      fallbackName: name,
      filePath,
    });
    for (const warning of parsed.warnings) diagnostics.push(`${filePath}: ${warning}`);
    if (parsed.ok) definitions.push(parsed.definition);
    else diagnostics.push(`${filePath}: ${parsed.errors.join("; ")}`);
  }
  return { definitions, diagnostics };
}

/**
 * One document from the user's registry (D202). Electron main reads the
 * registry — host-core owns it — and hands the documents in, so this module
 * keeps one parser and one merge for all three sources.
 */
export type UserSubagentDocument = {
  /** Registry id, used as the fallback name when the frontmatter omits one. */
  id: string;
  /** Raw document text, frontmatter included. */
  document: string;
  /** Absolute path, so a diagnostic and the UI can point at the same file. */
  filePath?: string;
};

export type LoadSubagentOptions = {
  /** Global directory override, primarily for isolated tests. */
  overrideDir?: string;
  /** Documents already scanned by host-core from `~/.agents/subagents`. */
  userDocuments?: readonly UserSubagentDocument[];
};

function loadUserSubagents(documents: readonly UserSubagentDocument[]): {
  definitions: SubagentDefinition[];
  diagnostics: string[];
} {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  for (const entry of documents) {
    const label = entry.filePath ?? `user subagent "${entry.id}"`;
    const parsed = parseSubagentDefinition(entry.document, {
      source: "user",
      fallbackName: entry.id,
      ...(entry.filePath ? { filePath: entry.filePath } : {}),
    });
    for (const warning of parsed.warnings) diagnostics.push(`${label}: ${warning}`);
    if (parsed.ok) definitions.push(parsed.definition);
    else diagnostics.push(`${label}: ${parsed.errors.join("; ")}`);
  }
  return { definitions, diagnostics };
}

/**
 * Definitions offered to a session: the user's global documents and the
 * builtins. Load failures degrade to diagnostics: a malformed document must not
 * cost the session its other delegates, let alone its turn.
 */
export async function loadSubagentDefinitions(
  workspaceRoot: string | null | undefined,
  options: LoadSubagentOptions = {},
): Promise<{ definitions: SubagentDefinition[]; diagnostics: string[] }> {
  const builtin = builtinSubagents();
  const dir =
    options.overrideDir ??
    (workspaceRoot ? subagentDefinitionDir(workspaceRoot) : undefined);
  const disk =
    options.userDocuments === undefined && dir
      ? await loadGlobalSubagents(dir)
      : { definitions: [], diagnostics: [] };
  const user = loadUserSubagents(options.userDocuments ?? []);
  const merged = mergeSubagentDefinitions([
    ...disk.definitions,
    ...user.definitions,
    ...builtin.definitions,
  ]);
  const diagnostics = [
    ...disk.diagnostics,
    ...user.diagnostics,
    ...builtin.diagnostics,
  ];
  if (merged.dropped.length > 0) {
    diagnostics.push(
      `dropped subagents past the catalog cap: ${merged.dropped.join(", ")}`,
    );
  }
  return { definitions: merged.definitions, diagnostics };
}

/** The stored-provider fields a pin can be resolved against. */
export type SubagentProviderSource = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  defaultModelId?: string;
  authKind?: string;
  apiStyle?: string;
};

/** Loose spelling used when matching a pin against a provider name. */
function providerAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Match a pin's `providerId` against configured providers.
 *
 * Stored provider ids are UUIDs, so a hand-written definition almost never
 * names one. The vendor key (`anthropic`) and the display name are what a
 * person actually writes, and both are accepted.
 */
function findProvider(
  providerId: string,
  providers: readonly SubagentProviderSource[],
): SubagentProviderSource | undefined {
  const alias = providerAlias(providerId);
  const exact = providers.find((provider) => provider.id === providerId);
  if (exact) return exact;
  const vendorMatches = providers.filter(
    (provider) => providerAlias(provider.vendorKey ?? "") === alias,
  );
  if (vendorMatches.length === 1) return vendorMatches[0];
  const nameMatches = providers.filter(
    (provider) => providerAlias(provider.name) === alias,
  );
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
}

/**
 * Resolve every distinct model pin into a provider binding the sidecar can
 * use, keyed by `subagentModelKey`.
 *
 * A pin that cannot be resolved is deliberately left out of the map instead of
 * falling back to the session provider: a definition that asks for a cheap
 * model must not silently start spending the expensive one. The runtime turns
 * the missing entry into a tool error naming the pin.
 */
export async function resolveSubagentProviders(input: {
  definitions: readonly SubagentDefinition[];
  providers: readonly SubagentProviderSource[];
  getSecret: (providerId: string) => Promise<string | undefined>;
  /** Per-model binding for a vendor-account row, resolved by Electron main. */
  resolveVendorBinding?: (
    provider: SubagentProviderSource,
    modelId: string,
  ) => Promise<VendorModelBinding | undefined>;
}): Promise<{
  providers: Record<string, RuntimeProviderConfig>;
  diagnostics: string[];
}> {
  const resolved: Record<string, RuntimeProviderConfig> = {};
  const diagnostics: string[] = [];
  const allowed = subagentPinnedProviders(input.definitions);
  const secrets = new Map<string, string | undefined>();

  for (const definition of input.definitions) {
    const pin = definition.model;
    if (!pin) continue;
    const key = subagentModelKey(pin);
    if (resolved[key]) continue;
    if (!allowed.includes(pin.providerId)) {
      diagnostics.push(
        `${definition.name}: too many pinned providers, ignoring "${key}"`,
      );
      continue;
    }
    const provider = findProvider(pin.providerId, input.providers);
    if (!provider) {
      diagnostics.push(
        `${definition.name}: no enabled provider matches "${pin.providerId}"`,
      );
      continue;
    }
    const isVendorAccount = provider.authKind === OAUTH_AUTH_KIND;
    if (!isVendorAccount && !secrets.has(provider.id)) {
      try {
        secrets.set(provider.id, await input.getSecret(provider.id));
      } catch {
        secrets.set(provider.id, undefined);
      }
    }
    const apiKey = secrets.get(provider.id) ?? "";
    if (!apiKey && !isVendorAccount && provider.authKind !== "none") {
      diagnostics.push(`${definition.name}: provider "${provider.name}" has no API key`);
      continue;
    }
    // A vendor account resolves the pinned model against the signed-in
    // catalog: one account can span wire APIs, and a gateway's model list
    // does not exist in the builtin one at all.
    let binding: VendorModelBinding | undefined;
    if (isVendorAccount) {
      try {
        binding = await input.resolveVendorBinding?.(provider, pin.modelId);
      } catch {
        binding = undefined;
      }
      if (!binding) {
        diagnostics.push(
          `${definition.name}: vendor account "${provider.name}" does not offer "${pin.modelId}"`,
        );
        continue;
      }
    }
    const capabilities = binding ?? resolveThinkingCapabilities({
      vendorKey: provider.vendorKey || "custom",
      modelId: pin.modelId,
      apiStyle: provider.apiStyle,
    });
    const modelConfig =
      binding?.modelConfig ??
      resolvePiModelConfig({
        vendorKey: provider.vendorKey || "custom",
        modelId: pin.modelId,
        apiStyle: provider.apiStyle,
      });
    const apiStyle = binding?.apiStyle ?? provider.apiStyle;
    resolved[key] = {
      id: provider.id,
      name: provider.name,
      ...(binding?.baseUrl ?? provider.baseUrl
        ? { baseUrl: binding?.baseUrl ?? provider.baseUrl }
        : {}),
      modelId: pin.modelId,
      apiKey,
      ...(provider.authKind ? { authKind: provider.authKind } : {}),
      ...(apiStyle ? { apiStyle } : {}),
      supportsReasoning: capabilities.supportsReasoning,
      supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
      ...(modelConfig ? { modelConfig } : {}),
    };
  }
  return { providers: resolved, diagnostics };
}
