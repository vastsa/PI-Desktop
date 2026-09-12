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
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
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
 * files as `contributes.agentExtensions`, and a no-op `main.js`.
 */
export function generateImportedExtensionPlugin(
  source: string,
  importRoot: string,
): { path: string; id: string; entries: string[] } {
  const resolved = resolve(source);
  const specs = discoverManualPath(resolved);
  if (specs.length === 0) {
    throw Object.assign(new Error("no extension entry found at that path"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  const isDirectory = statSync(resolved).isDirectory();
  const slug = slugFor(resolved);
  const id = `${PLUGIN_ID_PREFIX}${slug}`;
  let dir = join(importRoot, slug);
  let suffix = 2;
  while (existsSync(dir)) dir = join(importRoot, `${slug}-${suffix++}`);
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  if (isDirectory) {
    cpSync(resolved, srcDir, { recursive: true, filter: (p) => !p.includes("node_modules") });
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
    main: "main.js",
    permissions: ["agent.extension"],
    contributes: { agentExtensions: entries },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeFileSync(
    join(dir, "main.js"),
    "// Generated by PI-Desktop: this plugin only contributes agent extensions.\nmodule.exports = {};\n",
    "utf8",
  );
  return { path: dir, id, entries };
}
