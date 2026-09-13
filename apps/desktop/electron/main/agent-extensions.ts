/**
 * Agent extension bridge for Electron main (D387/D388, ADR 0214,
 * spec 07-plugins/16 §9 to §11).
 *
 * ExtensionAPI modules are contributed by plugins (`contributes.agentExtensions`)
 * and run inside the agent sidecar. This bridge holds what the sidecar reports
 * back per session (registered commands, load reports, diagnostics) and brokers
 * the modal prompts between the sidecar and the renderer. Discovery and
 * enablement are the plugin system's job; nothing here touches the filesystem.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertImportedPackagePath, discoverImportedPackageSkills } from "./imported-package-skills";
import { discoverManualPath } from "@pi-desktop/agent-runtime";
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
  return kind === "confirm" ? { kind, value: false } : { kind, value: undefined };
}

export class AgentExtensionBridge {
  private readonly options: AgentExtensionBridgeOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, PendingPrompt>();
  /** One interactive prompt per session at a time (spec §9). */
  private readonly promptQueues = new Map<string, Promise<unknown>>();

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
      diagnostics: [],
    };
    for (const session of this.sessions.values()) {
      const reports = session.reports.filter((r) => ids.has(r.extensionId));
      if (!reports.length) continue;
      status.state = reports.some((r) => r.state === "error") ? "error" : "loaded";
      status.toolNames = reports.flatMap((r) => r.toolNames);
      status.commandNames = reports.flatMap((r) => r.commandNames);
      status.diagnostics = session.diagnostics.filter((d) => ids.has(d.extensionId));
    }
    return status;
  }

  // --- UI bridge ------------------------------------------------------------------

  async requestUi(envelope: TrustedExtensionUiRequestEnvelope): Promise<TrustedExtensionUiResponse> {
    const { request } = envelope;
    switch (request.kind) {
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
    const previous = this.promptQueues.get(envelope.sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.showPrompt(envelope, request));
    this.promptQueues.set(envelope.sessionId, run.catch(() => undefined));
    return run;
  }

  respond(promptId: string, value: string | boolean | undefined): boolean {
    const pending = this.pending.get(promptId);
    if (!pending) return false;
    this.settle(promptId, this.responseFor(pending.kind, value));
    return true;
  }

  /** Aborting a turn dismisses that session's open prompts (spec §9). */
  cancelPrompts(sessionId: string): void {
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
  ): Promise<TrustedExtensionUiResponse> {
    return new Promise((resolvePrompt) => {
      const promptId = randomUUID();
      const timer = setTimeout(
        () => this.settle(promptId, dismissedResponse(request.kind)),
        this.options.promptTimeoutMs ?? TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
      );
      this.pending.set(promptId, {
        sessionId: envelope.sessionId,
        kind: request.kind,
        resolve: resolvePrompt,
        timer,
      });
      this.options.onPrompt({
        promptId,
        sessionId: envelope.sessionId,
        extensionId: envelope.extensionId,
        extensionLabel: envelope.extensionLabel,
        request,
      });
    });
  }

  private settle(promptId: string, response: TrustedExtensionUiResponse): void {
    const pending = this.pending.get(promptId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(promptId);
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

export type ExtensionDependencyInstallResult =
  | { state: "skipped"; reason: "no-package-json" | "no-dependencies" }
  | { state: "installed" }
  | { state: "failed"; error: string };

/** Injectable so tests never run npm. Resolves with the exit code and captured stderr. */
export type DependencyCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; stderr: string }>;

const NPM_INSTALL_TIMEOUT_MS = 120_000;
/** npm output is not toast-shaped; the tail carries the actual failure. */
const DEPENDENCY_ERROR_TAIL_CHARS = 200;
/** Rolling cap so a chatty npm cannot balloon the main process's memory. */
const DEPENDENCY_STDERR_KEEP_CHARS = 8192;

function dependencyErrorTail(text: string): string {
  return text.length > DEPENDENCY_ERROR_TAIL_CHARS
    ? `…${text.slice(-DEPENDENCY_ERROR_TAIL_CHARS)}`
    : text;
}

export function defaultDependencyRunner(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Shell only where npm is a .cmd shim (Windows); every arg is a literal.
    // A shell kill on Windows terminates the shim, possibly leaving npm
    // itself running — accepted for v1, the timeout result still resolves.
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > DEPENDENCY_STDERR_KEEP_CHARS * 2) {
        stderr = stderr.slice(-DEPENDENCY_STDERR_KEEP_CHARS);
      }
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      stderr += `\nnpm install exceeded ${timeoutMs}ms and was terminated`;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => resolve({ code: code ?? 1, stderr }));
    });
  });
}

/**
 * Install an imported extension's npm dependencies inside the generated plugin
 * directory (spec 07-plugins/16 §3): the sidecar's jiti resolves bare imports
 * from the plugin root's `node_modules`, and the kernel packages (`pi-ai`,
 * `pi-coding-agent`, `pi-tui`) keep winning through virtual modules, so
 * installing them is harmless. `--legacy-peer-deps` keeps `pi-coding-agent`
 * peers out of the tree; `--ignore-scripts` means no third-party install
 * script ever runs here — a native module that needs one fails to load with a
 * diagnostic instead (documented workaround: rebuild against Electron
 * headers). A failure never blocks the import; the extension reports its own
 * load error and the renderer surfaces this result.
 */
export async function installExtensionDependencies(
  pluginDir: string,
  options?: { runner?: DependencyCommandRunner; timeoutMs?: number },
): Promise<ExtensionDependencyInstallResult> {
  const packageJsonPath = join(pluginDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { state: "skipped", reason: "no-package-json" };
  }
  let manifest: { dependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    return {
      state: "failed",
      error: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!manifest.dependencies || Object.keys(manifest.dependencies).length === 0) {
    return { state: "skipped", reason: "no-dependencies" };
  }
  try {
    const result = await (options?.runner ?? defaultDependencyRunner)(
      "npm",
      ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", "--ignore-scripts"],
      pluginDir,
      options?.timeoutMs ?? NPM_INSTALL_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      return {
        state: "failed",
        error: dependencyErrorTail(`npm install exited ${result.code}: ${result.stderr.trim()}`),
      };
    }
    return { state: "installed" };
  } catch (err) {
    return {
      state: "failed",
      error: dependencyErrorTail(err instanceof Error ? err.message : String(err)),
    };
  }
}

const PLUGIN_ID_PREFIX = "imported.";

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
 * files as `contributes.agentExtensions`, and a no-op `main.js`. A directory
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
    throw Object.assign(new Error("no extension entry found at that path"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  for (const spec of specs) assertImportedPackagePath(isDirectory ? resolved : dirname(resolved), spec.entry);
  const slug = slugFor(resolved);
  const id = `${PLUGIN_ID_PREFIX}${slug}`;
  let dir = join(importRoot, slug);
  let suffix = 2;
  while (existsSync(dir)) dir = join(importRoot, `${slug}-${suffix++}`);
  const destinationRelative = relative(resolved, resolve(dir));
  if (isDirectory && !isAbsolute(destinationRelative) && !destinationRelative.split(sep).includes("..")) {
    throw Object.assign(new Error("import destination cannot be inside the selected package"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  const srcDir = join(dir, "src");
  try {
    mkdirSync(srcDir, { recursive: true });
    if (isDirectory) {
      cpSync(resolved, srcDir, { recursive: true, filter: (path) => {
        // Exclude dependencies within the selection, not its npm installation ancestors.
        if (relative(resolved, path).split(sep).includes("node_modules")) return false;
        if (lstatSync(path).isSymbolicLink()) {
          throw Object.assign(new Error("imported packages cannot contain a symbolic link"), {
            errorCode: ErrorCodes.INVALID_ARGUMENT,
          });
        }
        return true;
      } });
    } else {
      cpSync(resolved, join(srcDir, basename(resolved)));
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
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
    main: "main.js",
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
    join(dir, "main.js"),
    "// Generated by PI-Desktop: declarative skills and/or agent extensions.\nmodule.exports = {};\n",
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
      for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
        if (existsSync(join(resolved, file))) copyFileSync(join(resolved, file), join(dir, file));
      }
    }
  }
  return { path: dir, id, entries };
}
