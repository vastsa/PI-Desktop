import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { redactValue } from "./logger";

export type {
  LocalToolHandler,
  LocalToolResult,
  ProjectInstructionResolver,
  SidecarNotificationHandler,
  TrustedExtensionSidecarBridge,
  VendorAuthResolver,
} from "@pi-desktop/host-runtime";

function resolveSidecarEntry(): string {
  const candidates = [
    join(process.resourcesPath || "", "agent-runtime/sidecar.js"),
    join(__dirname, "../../../agent-runtime/dist/sidecar.js"),
    join(__dirname, "../../../../packages/agent-runtime/dist/sidecar.js"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return join(__dirname, "../../../../packages/agent-runtime/dist/sidecar.js");
}

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
        // Electron 43's Node supports the OS trust store. Keep bundled roots
        // and inherited NODE_EXTRA_CA_CERTS; never bypass TLS verification.
        args: ["--max-old-space-size=2048", "--use-system-ca", resolveSidecarEntry()],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      onStderr: onStderr ?? fallbackStderrLogger,
    });
  }
}
