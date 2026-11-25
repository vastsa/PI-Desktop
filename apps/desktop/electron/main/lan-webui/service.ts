import { networkInterfaces } from "node:os";
import {
  IPC,
  type LanAdminAction,
  type LanAdminView,
  type LanInterface,
} from "@pi-desktop/shared";
import { onLanAgentEvent } from "./agent-tap";
import { getLanOrganization } from "./organization";
import { LanError } from "./ports";
import { createLanServer, type LanAsset } from "./server";
import { createLanWorkspace, type LanWorkspaceDeps } from "./workspace";

const DEFAULT_PORT = 37180;

/** IPv4 private LAN addresses plus loopback, in that order. */
export function listLanInterfaces(source = networkInterfaces()): LanInterface[] {
  const result: LanInterface[] = [];
  for (const [name, entries] of Object.entries(source)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      const isPrivate = a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
      if (isPrivate) result.push({ address: entry.address, name });
    }
  }
  result.push({ address: "127.0.0.1", name: "loopback" });
  return result;
}

export function createLanWebUiService(deps: {
  workspace: Omit<LanWorkspaceDeps, "organization" | "notifyDesktop">;
  dataDir: string;
  assets: () => ReadonlyMap<string, LanAsset>;
  sendToRenderer(channel: string, payload: unknown): void;
  log(level: "info" | "warn", message: string, data?: unknown): void;
}) {
  const organization = getLanOrganization(deps.dataDir);
  organization.setNotifier((event) => deps.sendToRenderer(IPC.event.lanWebUiCatalogChanged, event));
  const workspace = createLanWorkspace({
    ...deps.workspace,
    organization,
    notifyDesktop: (sessionId) =>
      deps.sendToRenderer(IPC.event.sessionsChanged, { reason: "lan.webui", ...(sessionId ? { sessionId } : {}) }),
  });
  const offAgent = onLanAgentEvent((envelope) => workspace.ingest(envelope));
  const offWrites = organization.onRendererWrite(() => workspace.catalogChanged());
  let server: ReturnType<typeof createLanServer> | null = null;
  let address: string | null = null;
  let port: number | null = null;
  const notifyAdmin = () => deps.sendToRenderer(IPC.event.lanWebUiChanged, null);

  const ensureServer = () => {
    server ??= createLanServer({ handler: workspace, assets: deps.assets(), onChange: notifyAdmin });
    return server;
  };

  function view(error: string | null = null): LanAdminView {
    const current = server;
    const running = current?.running() === true;
    return {
      running,
      origin: running ? current!.origin() : null,
      address: running ? address : null,
      port: running ? port : null,
      code: running ? current!.code() : null,
      pending: running ? current!.pending() : [],
      devices: running ? current!.devices() : [],
      interfaces: listLanInterfaces(),
      error,
    };
  }

  async function admin(action: LanAdminAction): Promise<LanAdminView> {
    try {
      switch (action?.kind) {
        case "state":
          break;
        case "start": {
          const allowed = listLanInterfaces().some((entry) => entry.address === action.address);
          const requestedPort = Number.isInteger(action.port) && action.port > 0 && action.port < 65536 ? action.port : DEFAULT_PORT;
          if (!allowed) throw new LanError(400, "INVALID_ADDRESS");
          const bound = await ensureServer().start(action.address, requestedPort);
          address = bound.address;
          port = bound.port;
          deps.log("info", "lan webui started", { port: bound.port });
          notifyAdmin();
          break;
        }
        case "stop":
          await server?.stop();
          address = null;
          port = null;
          deps.log("info", "lan webui stopped");
          notifyAdmin();
          break;
        case "issueCode":
          ensureServer().issueCode();
          break;
        case "confirm":
          ensureServer().confirm(String(action.id), action.grants);
          break;
        case "update":
          ensureServer().update(String(action.id), action.grants);
          break;
        case "deny":
          server?.deny(String(action.id));
          break;
        case "revoke":
          server?.revoke(String(action.id));
          break;
        case "ack":
          if (Number.isInteger(action.seq)) organization.ack(action.seq);
          break;
        default:
          throw new LanError(400, "INVALID_ARGUMENT");
      }
    } catch (error) {
      const code = error instanceof LanError
        ? error.code
        : (error as { code?: unknown })?.code === "EADDRINUSE" ? "PORT_IN_USE" : "FAILED";
      if (!(error instanceof LanError)) deps.log("warn", "lan webui action failed", { kind: action?.kind, code });
      return view(code);
    }
    return view();
  }

  return {
    admin,
    async dispose(): Promise<void> {
      offAgent();
      offWrites();
      await server?.stop();
      workspace.dispose();
    },
  };
}

export type LanWebUiService = ReturnType<typeof createLanWebUiService>;
