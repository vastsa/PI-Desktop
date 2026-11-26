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
import { createLanStateStore, type LanBinding, type LanSavedState } from "./state";
import { createLanWorkspace, type LanWorkspaceDeps } from "./workspace";

const DEFAULT_PORT = 37180;

function actionError(error: unknown): string {
  if (error instanceof LanError) return error.code;
  return (error as NodeJS.ErrnoException)?.code === "EADDRINUSE" ? "PORT_IN_USE" : "FAILED";
}

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
  const store = createLanStateStore(deps.dataDir);
  let saved: LanSavedState = { enabled: false, binding: null, devices: [] };
  let restoreError: string | null = null;
  let disposal: Promise<void> | null = null;
  const notifyAdmin = () => deps.sendToRenderer(IPC.event.lanWebUiChanged, null);

  function save(state: LanSavedState) {
    try {
      store.write(state);
    } catch {
      deps.log("warn", "lan webui could not save local state");
      throw new LanError(500, "SAVE_FAILED");
    }
    saved = state;
  }

  async function open(binding: LanBinding, remember: boolean) {
    if (server) throw new LanError(409, "ALREADY_RUNNING");
    if (!listLanInterfaces().some(({ address }) => address === binding.address)) {
      throw new LanError(400, "INVALID_ADDRESS");
    }
    const sameBinding = saved.binding?.address === binding.address && saved.binding.port === binding.port;
    const devices = saved.enabled && sameBinding ? saved.devices : [];
    const next = createLanServer({
      handler: workspace, assets: deps.assets(), onChange: notifyAdmin,
      pairings: { devices, save: (devices) => save({ ...saved, devices }) },
    });
    try {
      const bound = await next.start(binding.address, binding.port);
      if (disposal) throw new LanError(409, "NOT_RUNNING");
      if (remember) save({ enabled: true, binding: bound, devices });
      server = next;
      restoreError = null;
      deps.log("info", "lan webui started", { port: bound.port });
      notifyAdmin();
    } catch (error) {
      await next.stop();
      throw error;
    }
  }

  async function close() {
    const current = server;
    server = null;
    await current?.stop();
  }

  async function restore() {
    try {
      saved = store.read();
      if (saved.enabled && saved.binding) await open(saved.binding, false);
    } catch (error) {
      restoreError = actionError(error);
      deps.log("warn", "lan webui restore failed", { code: restoreError });
    }
  }

  // State reads and start/stop actions wait for restore and for each other.
  let pending = restore();
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  function view(error = restoreError): LanAdminView {
    return {
      enabled: saved.enabled,
      running: server !== null,
      origin: server?.origin() ?? null,
      address: saved.binding?.address ?? null,
      port: saved.binding?.port ?? null,
      code: server?.code() ?? null,
      devices: server?.devices() ?? [],
      interfaces: listLanInterfaces(),
      error,
    };
  }

  async function admin(action: LanAdminAction): Promise<LanAdminView> {
    try {
      if (disposal) throw new LanError(409, "NOT_RUNNING");
      switch (action?.kind) {
        case "state":
          break;
        case "start": {
          const port = Number.isInteger(action.port) && action.port > 0 && action.port < 65_536 ? action.port : DEFAULT_PORT;
          await open({ address: action.address, port }, true);
          break;
        }
        case "stop":
          try {
            if (saved.enabled) save({ ...saved, enabled: false, devices: [] });
            restoreError = null;
          } catch (error) {
            restoreError = actionError(error);
            throw error;
          } finally {
            // Always stop serving, even when the setting could not be saved.
            await close();
            deps.log("info", "lan webui stopped");
            notifyAdmin();
          }
          break;
        case "issueCode":
          if (!server) throw new LanError(409, "NOT_RUNNING");
          server.issueCode();
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
      const code = actionError(error);
      if (!(error instanceof LanError)) deps.log("warn", "lan webui action failed", { kind: action?.kind, code });
      return view(code);
    }
    return view();
  }

  return {
    admin: (action: LanAdminAction) => enqueue(() => admin(action)),
    dispose(): Promise<void> {
      if (disposal) return disposal;
      offAgent();
      offWrites();
      disposal = enqueue(async () => {
        try {
          await close();
        } finally {
          workspace.dispose();
        }
      });
      return disposal;
    },
  };
}

export type LanWebUiService = ReturnType<typeof createLanWebUiService>;
