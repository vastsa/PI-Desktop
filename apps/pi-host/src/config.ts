import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RACP_DEFAULT_POLICY, type RacpPermissionMode, type RacpPolicy } from "@pi-desktop/shared";

export type PiHostConfig = {
  dataDir: string;
  /** Loopback bind address; `pi-host` refuses anything else. */
  host: string;
  /** `0` picks a free port and prints it. */
  port: number;
  hostCoreBinary: string;
  sidecarEntry: string;
  /** The Node executable used for the sidecar; defaults to this process's. */
  nodeBinary: string;
  /** Print a fresh single-use pairing token at start and exit once it is consumed or expired. */
  pair: boolean;
  pairingLifetimeMs: number;
  /** Where the folder picker may browse; defaults to the user's home. */
  browseRoot: string;
  logLevel: "info" | "warn" | "error";
  policy: RacpPolicy;
};

const DEFAULT_PORT = 0;
const DEFAULT_PAIRING_LIFETIME_MS = 10 * 60 * 1000;

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Locations the bundle and a source checkout keep host-core in, first hit wins. */
export function hostCoreCandidates(root = here()): string[] {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    process.env.PI_HOST_CORE_BIN ?? "",
    process.env.PI_DESKTOP_HOST_BIN ?? "",
    join(root, `bin/pi-desktop-host-core${exe}`),
    join(root, `../bin/pi-desktop-host-core${exe}`),
    join(root, `../../../target/release/pi-desktop-host-core${exe}`),
    join(root, `../../../target/debug/pi-desktop-host-core${exe}`),
  ].filter(Boolean);
}

export function sidecarCandidates(root = here()): string[] {
  return [
    process.env.PI_HOST_SIDECAR ?? "",
    join(root, "agent-runtime/sidecar.js"),
    join(root, "../agent-runtime/sidecar.js"),
    join(root, "../../../packages/agent-runtime/dist-bundle/sidecar.js"),
    join(root, "../../../packages/agent-runtime/dist/sidecar.js"),
  ].filter(Boolean);
}

function firstExisting(candidates: string[], what: string): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return resolve(candidate);
  }
  throw Object.assign(new Error(`${what} not found; tried ${candidates.join(", ")}`), { errorCode: "HOST_BOOTSTRAP_FAILED" });
}

function invalidPolicyOption(name: string, expected: string): never {
  throw Object.assign(new Error(`invalid ${name}; expected ${expected}`), {
    errorCode: "INVALID_ARGUMENT",
  });
}

function parsePermissionMode(value: string | boolean | undefined): RacpPermissionMode {
  const mode = typeof value === "string" ? value.trim() : value;
  if (mode === "ask" || mode === "accept-edits" || mode === "auto") return mode;
  return invalidPolicyOption("--remote-max-permission-mode / PI_HOST_REMOTE_MAX_PERMISSION_MODE", "ask, accept-edits, or auto");
}

function parsePolicyBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return invalidPolicyOption("--apply-ceiling-to-paired-devices / PI_HOST_APPLY_CEILING_TO_PAIRED_DEVICES", "true or false");
}

function parseApprovalLifetime(value: string | number | boolean | undefined): number {
  const lifetimeMs = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value.trim())
      : Number.NaN;
  if (Number.isSafeInteger(lifetimeMs) && lifetimeMs >= 1) return lifetimeMs;
  return invalidPolicyOption("--approval-lifetime-ms / PI_HOST_APPROVAL_LIFETIME_MS", "a positive safe integer");
}

export type CliArgs = Record<string, string | boolean>;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[arg.slice(2)] = next;
      index += 1;
    } else {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

/** The data directory alone; admin subcommands need it without the binaries. */
export function resolveDataDir(args: CliArgs, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(String(args["data-dir"] ?? env.PI_DESKTOP_DATA_DIR ?? join(homedir(), ".pi-desktop")));
}

export function resolveConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): PiHostConfig {
  const dataDir = resolveDataDir(args, env);
  const port = Number(args.port ?? env.PI_HOST_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw Object.assign(new Error(`invalid port ${String(args.port ?? env.PI_HOST_PORT)}`), { errorCode: "INVALID_ARGUMENT" });
  }
  const level = String(args["log-level"] ?? env.PI_HOST_LOG_LEVEL ?? "info");
  const policy: RacpPolicy = {
    remoteMaxPermissionMode: parsePermissionMode(
      args["remote-max-permission-mode"] ?? env.PI_HOST_REMOTE_MAX_PERMISSION_MODE ?? RACP_DEFAULT_POLICY.remoteMaxPermissionMode,
    ),
    applyCeilingToPairedDevices: parsePolicyBoolean(
      args["apply-ceiling-to-paired-devices"] ?? env.PI_HOST_APPLY_CEILING_TO_PAIRED_DEVICES ?? RACP_DEFAULT_POLICY.applyCeilingToPairedDevices,
    ),
    approvalLifetimeMs: parseApprovalLifetime(
      args["approval-lifetime-ms"] ?? env.PI_HOST_APPROVAL_LIFETIME_MS ?? RACP_DEFAULT_POLICY.approvalLifetimeMs,
    ),
  };
  return {
    dataDir,
    host: String(args.host ?? env.PI_HOST_BIND ?? "127.0.0.1"),
    port,
    hostCoreBinary: args["host-core"] ? resolve(String(args["host-core"])) : firstExisting(hostCoreCandidates(), "host-core binary"),
    sidecarEntry: args.sidecar ? resolve(String(args.sidecar)) : firstExisting(sidecarCandidates(), "agent sidecar entry"),
    nodeBinary: String(args.node ?? env.PI_HOST_NODE ?? process.execPath),
    pair: args.pair === true || args.pair === "true",
    pairingLifetimeMs: Number(args["pairing-lifetime-ms"] ?? DEFAULT_PAIRING_LIFETIME_MS),
    browseRoot: resolve(String(args["browse-root"] ?? env.PI_HOST_BROWSE_ROOT ?? homedir())),
    logLevel: level === "warn" || level === "error" ? level : "info",
    policy,
  };
}
