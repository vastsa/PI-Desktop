/**
 * Agent extension bridge for Electron main (D387/D388, ADR 0214,
 * spec 07-plugins/16 §9 to §11).
 *
 * ExtensionAPI modules are contributed by plugins (`contributes.agentExtensions`)
 * and run inside the agent sidecar. This bridge holds what the sidecar reports
 * back per session (registered commands, load reports, diagnostics) and brokers
 * the modal prompts between the sidecar and the renderer. Discovery and
 * enablement are the plugin system's job. Import generation stays here, while
 * dependency installation lives in the dedicated npm installer so its trust
 * boundary and lifecycle can be tested independently.
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertImportedPackagePath, discoverImportedPackageSkills } from "./imported-package-skills";
import {
  IMPORTED_PLUGIN_ID_PREFIX,
  IMPORTED_PLUGIN_MAIN,
  IMPORTED_PLUGIN_WRAPPER_SOURCE,
} from "./imported-plugin-wrapper";
import { discoverManualPath } from "@pi-desktop/agent-runtime";
export { defaultDependencyRunner, installExtensionDependencies } from "./npm-installer";
export type { DependencyCommandRunner, ExtensionDependencyInstallResult } from "./npm-installer";
import {
  ErrorCodes,
  TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
  type PluginAgentExtensionStatus,
  type TrustedExtensionCommand,
  type TrustedExtensionDiagnostic,
  type TrustedExtensionLoadReport,
  type TrustedExtensionStatusEvent,
  type TrustedExtensionUiPrompt,
  type TrustedExtensionUiRequestEnvelope,
  type TrustedExtensionUiResponse,
} from "@pi-desktop/shared";

type SessionState = {
  commands: TrustedExtensionCommand[];
  diagnostics: TrustedExtensionDiagnostic[];
  reports: TrustedExtensionLoadReport[];
};

type PendingPrompt = {
  prompt: TrustedExtensionUiPrompt;
  sessionId: string;
  kind: "confirm" | "select" | "input";
  resolve: (response: TrustedExtensionUiResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type AgentExtensionBridgeOptions = {
  /** Renderer notifications. `hasRenderer` false means prompts fail closed (spec §9). */
  hasRenderer: () => boolean;
  onChanged: () => void;
  onPrompt: (prompt: TrustedExtensionUiPrompt) => void;
  onToast: (message: string, level: "info" | "warning" | "error") => void;
  onStatus: (event: TrustedExtensionStatusEvent) => void;
  promptTimeoutMs?: number;
};

function dismissedResponse(kind: PendingPrompt["kind"]): TrustedExtensionUiResponse {
  return kind === "confirm" ? { kind, value: false, cancelled: true } : { kind, value: undefined, cancelled: true };
}

export class AgentExtensionBridge {
  private readonly options: AgentExtensionBridgeOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, PendingPrompt>();
  /** One interactive prompt per session at a time (spec §9). */
  private readonly promptQueues = new Map<string, Promise<unknown>>();
  private readonly uiRequests = new Map<string, { sessionId: string; controller: AbortController }>();

  constructor(options: AgentExtensionBridgeOptions) {
    this.options = options;
  }

  // --- sidecar publications ---------------------------------------------------

  publishCommands(sessionId: string, commands: TrustedExtensionCommand[]): void {
    this.session(sessionId).commands = commands;
    this.options.onChanged();
  }

  publishDiagnostics(
    sessionId: string,
    diagnostics: TrustedExtensionDiagnostic[],
    reports: TrustedExtensionLoadReport[],
  ): void {
    const state = this.session(sessionId);
    state.diagnostics = diagnostics;
    if (reports.length) state.reports = reports;
    this.options.onChanged();
  }

  /** Commands registered by any live session, deduplicated by name. */
  allCommands(): TrustedExtensionCommand[] {
    const byName = new Map<string, TrustedExtensionCommand>();
    for (const state of this.sessions.values()) {
      for (const command of state.commands) {
        if (!byName.has(command.name)) byName.set(command.name, command);
      }
    }
    return [...byName.values()];
  }

  commandsForSession(sessionId: string): TrustedExtensionCommand[] {
    return this.sessions.get(sessionId)?.commands ?? [];
  }

  clearSession(sessionId: string): void {
    this.cancelPrompts(sessionId);
    if (this.sessions.delete(sessionId)) this.options.onChanged();
  }

  /**
   * What the plugin row shows for one plugin's modules (spec §11): the most
   * recent session that reported on any of them wins; `enabled` until then.
   */
  statusForPlugin(extensionIds: readonly string[]): PluginAgentExtensionStatus {
    const ids = new Set(extensionIds);
    const status: PluginAgentExtensionStatus = {
      state: "enabled",
      toolNames: [],
      commandNames: [],
      agentNames: [],
      diagnostics: [],
    };
    for (const session of this.sessions.values()) {
      const reports = session.reports.filter((r) => ids.has(r.extensionId));
      if (!reports.length) continue;
      status.state = reports.some((r) => r.state === "error") ? "error" : "loaded";
      status.toolNames = reports.flatMap((r) => r.toolNames);
      status.commandNames = reports.flatMap((r) => r.commandNames);
      status.agentNames = reports.flatMap((r) => r.agentNames);
      status.diagnostics = session.diagnostics.filter((d) => ids.has(d.extensionId));
    }
    return status;
  }

  // --- UI bridge ------------------------------------------------------------------

  async requestUi(envelope: TrustedExtensionUiRequestEnvelope): Promise<TrustedExtensionUiResponse> {
    const { request } = envelope;
    switch (request.kind) {
      case "cancel": {
        const key = JSON.stringify([envelope.sessionId, envelope.extensionId, request.requestId]);
        this.uiRequests.get(key)?.controller.abort();
        return { kind: "cancel" };
      }
      case "notify":
        this.options.onToast(`${envelope.extensionLabel}: ${request.message}`, request.level);
        return { kind: "notify" };
      case "setStatus":
        this.options.onStatus({
          sessionId: envelope.sessionId,
          extensionId: envelope.extensionId,
          key: request.key,
          text: request.text,
        });
        return { kind: "setStatus" };
      case "setWorkingMessage":
        this.options.onStatus({
          sessionId: envelope.sessionId,
          extensionId: envelope.extensionId,
          key: "working",
          text: request.text,
        });
        return { kind: "setWorkingMessage" };
      case "confirm":
      case "select":
      case "input":
        break;
    }
    if (!this.options.hasRenderer()) {
      throw Object.assign(new Error("interactive extension prompts need the desktop window"), {
        errorCode: ErrorCodes.UNSUPPORTED,
      });
    }
    const key = JSON.stringify([envelope.sessionId, envelope.extensionId, envelope.requestId ?? randomUUID()]);
    if (this.uiRequests.has(key)) throw new Error("Duplicate extension UI request");
    const controller = new AbortController();
    this.uiRequests.set(key, { sessionId: envelope.sessionId, controller });
    const previous = this.promptQueues.get(envelope.sessionId) ?? Promise.resolve();
    const run = previous.then(() => controller.signal.aborted
      ? dismissedResponse(request.kind)
      : this.showPrompt(envelope, request, controller.signal));
    const tail = run.catch(() => undefined);
    this.promptQueues.set(envelope.sessionId, tail);
    let retire!: () => void;
    const cancelled = new Promise<TrustedExtensionUiResponse>((resolve) => {
      retire = () => resolve(dismissedResponse(request.kind));
      controller.signal.addEventListener("abort", retire, { once: true });
      if (controller.signal.aborted) retire();
    });
    try { return await Promise.race([run, cancelled]); }
    finally {
      controller.signal.removeEventListener("abort", retire);
      this.uiRequests.delete(key);
      void tail.then(() => {
        if (this.promptQueues.get(envelope.sessionId) === tail) this.promptQueues.delete(envelope.sessionId);
      });
    }
  }

  respond(promptId: string, value: string | boolean | undefined): boolean {
    const pending = this.pending.get(promptId);
    if (!pending) return false;
    this.settle(promptId, this.responseFor(pending.kind, value));
    return true;
  }

  /** Aborting a turn dismisses that session's open prompts (spec §9). */
  cancelPrompts(sessionId: string): void {
    for (const entry of this.uiRequests.values()) {
      if (entry.sessionId === sessionId) entry.controller.abort();
    }
    for (const [promptId, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle(promptId, dismissedResponse(pending.kind));
    }
  }

  pendingPromptCount(): number {
    return this.pending.size;
  }

  // --- internals -------------------------------------------------------------------

  private showPrompt(
    envelope: TrustedExtensionUiRequestEnvelope,
    request: TrustedExtensionUiPrompt["request"],
    signal: AbortSignal,
  ): Promise<TrustedExtensionUiResponse> {
    return new Promise((resolvePrompt) => {
      const promptId = randomUUID();
      const prompt = { promptId, sessionId: envelope.sessionId, extensionId: envelope.extensionId,
        extensionLabel: envelope.extensionLabel, request };
      const abort = () => this.settle(promptId, dismissedResponse(request.kind));
      const timer = setTimeout(
        () => this.settle(promptId, dismissedResponse(request.kind)),
        this.options.promptTimeoutMs ?? TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
      );
      this.pending.set(promptId, {
        prompt,
        sessionId: envelope.sessionId,
        kind: request.kind,
        resolve: (response) => { signal.removeEventListener("abort", abort); resolvePrompt(response); },
        timer,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.options.onPrompt(prompt);
      if (signal.aborted) abort();
    });
  }

  private settle(promptId: string, response: TrustedExtensionUiResponse): void {
    const pending = this.pending.get(promptId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(promptId);
    this.options.onPrompt({ ...pending.prompt, cancelled: true });
    pending.resolve(response);
  }

  private responseFor(
    kind: PendingPrompt["kind"],
    value: string | boolean | undefined,
  ): TrustedExtensionUiResponse {
    if (kind === "confirm") return { kind, value: value === true };
    return { kind, value: typeof value === "string" ? value : undefined };
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { commands: [], diagnostics: [], reports: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}


const NPM_LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

const IMPORT_SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
]);
const IMPORT_SENSITIVE_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

function isSensitiveImportedPath(relativePath: string): boolean {
  const parts = relativePath.split(sep).filter(Boolean);
  if (parts.some((part) => IMPORT_SENSITIVE_DIRECTORY_NAMES.has(part.toLowerCase()))) return true;
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return (
    IMPORT_SENSITIVE_FILE_NAMES.has(name) ||
    name.startsWith(".env") ||
    name.startsWith("id_rsa") ||
    /\.(pem|p12|pfx|keystore)$/.test(name)
  );
}

function importedPathError(message: string): Error & { errorCode?: string } {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function slugFor(path: string): string {
  const stem = basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "extension";
}

/**
 * Build a plugin directory from a pi extension file or directory (spec §3):
 * copies the source under `src/`, writes a manifest that declares the entry
 * files as `contributes.agentExtensions`, and a CommonJS no-op `main.cjs`. A directory
 * that ships a `package.json` also gets it (plus its lockfile) at the plugin
 * root so {@link installExtensionDependencies} can resolve its dependencies
 * there; `node_modules` itself is never copied — it is reinstalled.
 */
export function generateImportedExtensionPlugin(
  source: string,
  importRoot: string,
): { path: string; id: string; entries: string[] } {
  const resolved = existsSync(source) ? realpathSync(source) : resolve(source);
  const isDirectory = existsSync(resolved) && statSync(resolved).isDirectory();
  const { skills, skillsOnly } = isDirectory
    ? discoverImportedPackageSkills(resolved)
    : { skills: [], skillsOnly: false };
  // A skill-only package may contain helper scripts; do not promote a root
  // index.js or other incidental script to executable agent extensions.
  const specs = skillsOnly ? [] : discoverManualPath(resolved);
  if (specs.length === 0 && skills.length === 0) {
    throw importedPathError("no extension entry found at that path");
  }
  for (const spec of specs) {
    assertImportedPackagePath(isDirectory ? resolved : dirname(resolved), spec.entry);
    if (isSensitiveImportedPath(relative(isDirectory ? resolved : dirname(resolved), spec.entry))) {
      throw importedPathError("imported packages cannot contain credential files");
    }
  }
  const slug = slugFor(resolved);
  mkdirSync(importRoot, { recursive: true });
  if (lstatSync(importRoot).isSymbolicLink()) {
    throw importedPathError("import destination root cannot be a symbolic link");
  }
  let dir: string;
  let suffix = 2;
  while (true) {
    const candidate = join(importRoot, suffix === 2 ? slug : `${slug}-${suffix}`);
    const destinationRelative = relative(resolved, resolve(candidate));
    if (isDirectory && !isAbsolute(destinationRelative) && !destinationRelative.split(sep).includes("..")) {
      throw importedPathError("import destination cannot be inside the selected package");
    }
    try {
      // Atomic creation prevents a pre-existing or racing symlink from being followed.
      mkdirSync(candidate);
      dir = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
  const id = `${IMPORTED_PLUGIN_ID_PREFIX}${basename(dir)}`;
  const srcDir = join(dir, "src");
  try {
    mkdirSync(srcDir);
    if (isDirectory) {
      cpSync(resolved, srcDir, {
        recursive: true,
        filter: (path) => {
          const relativePath = relative(resolved, path);
          // Exclude dependencies within the selection, not its npm installation ancestors.
          if (relativePath.split(sep).includes("node_modules")) return false;
          if (relativePath && isSensitiveImportedPath(relativePath)) return false;
          if (lstatSync(path).isSymbolicLink()) {
            throw importedPathError("imported packages cannot contain a symbolic link");
          }
          return true;
        },
      });
    } else {
      cpSync(resolved, join(srcDir, basename(resolved)));
    }
    const entries = specs.map((spec) =>
      isDirectory
        ? `src/${relative(resolved, spec.entry).split("\\").join("/")}`
        : `src/${basename(resolved)}`,
    );
    const manifest = {
      schemaVersion: 1,
      id,
      name: slug,
      version: "0.0.0",
      description: `Imported pi extension from ${resolved}`,
      main: IMPORTED_PLUGIN_MAIN,
      permissions: [...(entries.length ? ["agent.extension"] : []), ...(skills.length ? ["agent.prompt.inject"] : [])],
      contributes: {
        ...(entries.length ? { agentExtensions: entries } : {}),
        ...(skills.length ? { skills: skills.map((path) => ({
          path: `src/${path}`,
          // Distinct directories often use the same SKILL.md basename.
          id: `skill-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
        })) } : {}),
      },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(
      join(dir, IMPORTED_PLUGIN_MAIN),
      IMPORTED_PLUGIN_WRAPPER_SOURCE,
      "utf8",
    );
    if (isDirectory) {
      const rootPackageJson = join(resolved, "package.json");
      if (existsSync(rootPackageJson)) {
        // A `workspaces` field would send npm into the copied sources under
        // src/; strip it so the install sees only the declared dependencies.
        try {
          const pkg = JSON.parse(readFileSync(rootPackageJson, "utf8")) as Record<string, unknown>;
          if (pkg && typeof pkg === "object" && "workspaces" in pkg) {
            delete pkg.workspaces;
            writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
          } else {
            copyFileSync(rootPackageJson, join(dir, "package.json"));
          }
        } catch {
          // Not valid JSON: copy verbatim; the install step reports the failure.
          copyFileSync(rootPackageJson, join(dir, "package.json"));
        }
        for (const file of NPM_LOCKFILE_NAMES) {
          if (existsSync(join(resolved, file))) copyFileSync(join(resolved, file), join(dir, file));
        }
      }
    }
    return { path: dir, id, entries };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
