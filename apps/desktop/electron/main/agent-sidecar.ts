import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { resolveSidecarEntry } from "./agent-sidecar-entry.mjs";
import { redactValue } from "./logger";

export type {
  LocalToolHandler,
  LocalToolResult,
  ProjectInstructionResolver,
  SidecarNotificationHandler,
  TrustedExtensionSidecarBridge,
  VendorAuthResolver,
} from "@pi-desktop/host-runtime";

function fallbackStderrLogger(text: string): void {
  console.error(
    `[agent/runtime] ${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      channel: "agent",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

/**
 * The desktop's agent sidecar: the shared stdio transport from
 * `@pi-desktop/host-runtime`, launched the only way Electron can run Node
 * code out of process — its own executable with `ELECTRON_RUN_AS_NODE` — on
 * the sidecar bundle this build ships.
 */
export class AgentSidecar extends RuntimeAgentSidecar {
  constructor(onStderr?: StderrHandler) {
    super({
      launch: {
        command: process.execPath,
        // Keep the OS trust store available to the sidecar. On macOS the
        // Electron 43 build applies `--use-system-ca` by replacing the
        // bundled roots instead of adding them (its keychain enumeration
        // misses public anchors like GlobalSign Root CA - R3, issue #1187),
        // so there the sidecar merges bundled + system + extra CAs itself
        // (agent-runtime system-ca) and this launcher omits the flag. On
        // Windows and Linux the flag behaves as documented and stays.
        // Never bypass TLS verification.
        args: [
          "--max-old-space-size=2048",
          ...(process.platform === "darwin" ? [] : ["--use-system-ca"]),
          resolveSidecarEntry(import.meta.url, process.resourcesPath || ""),
        ],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      onStderr: onStderr ?? fallbackStderrLogger,
    });
  }
}
