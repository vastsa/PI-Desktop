#!/usr/bin/env node
import { parseArgs, resolveConfig } from "./config.js";
import { startPiHost } from "./app.js";
import { runProviderImport } from "./provider-import.js";

/**
 * `pi-host [--data-dir <dir>] [--port <n>] [--pair] [--host-core <bin>] [--sidecar <entry>]`
 *
 * stdout carries exactly the lines a bootstrap script parses:
 *   PI_HOST_READY {"hostId":..,"port":..,"version":..}
 *   PI_HOST_PAIRING_TOKEN {"token":..,"expiresAt":..}   (with --pair)
 * Everything else is structured stderr.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "provider-import") {
    process.exitCode = await runProviderImport(process.argv.slice(3));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(
      [
        "pi-host — headless PI Agent Host (RACP-WS on loopback)",
        "",
        "  --data-dir <dir>          host data directory (default ~/.pi-desktop)",
        "  --port <n>                loopback port (default 0 = pick free)",
        "  --host <addr>             bind address; loopback only",
        "  --pair                    print a single-use pairing token at start",
        "  --pairing-lifetime-ms <n> pairing token lifetime (default 600000)",
        "  --remote-max-permission-mode <mode> ask | accept-edits | auto",
        "                            default ask",
        "  --apply-ceiling-to-paired-devices <bool> true | false; default false",
        "  --approval-lifetime-ms <n> approval lifetime; default 1800000",
        "  --host-core <path>        pi-desktop-host-core binary",
        "  --sidecar <path>          agent sidecar entry",
        "  --browse-root <dir>       folder-picker root (default home)",
        "  --log-level <level>       info | warn | error",
        "",
        "RACP policy can also be set with PI_HOST_REMOTE_MAX_PERMISSION_MODE,",
        "PI_HOST_APPLY_CEILING_TO_PAIRED_DEVICES, and PI_HOST_APPROVAL_LIFETIME_MS.",
        "",
        "pi-host provider-import [--data-dir <dir>]",
        "  read a provider import payload (JSON) from stdin and hand it to the",
        "  running pi-host over its admin socket; prints PI_HOST_PROVIDERS {...}",
        "",
      ].join("\n"),
    );
    return;
  }
  const config = resolveConfig(args);
  const app = await startPiHost(config);
  process.stdout.write(`PI_HOST_READY ${JSON.stringify({ hostId: app.hostId, host: app.address.host, port: app.address.port, version: (await import("@pi-desktop/shared")).APP_VERSION })}\n`);
  if (config.pair) {
    const pairing = await app.issuePairingToken(config.pairingLifetimeMs);
    process.stdout.write(`PI_HOST_PAIRING_TOKEN ${JSON.stringify(pairing)}\n`);
  }
  const stop = (signal: string) => {
    app.log("info", "signal received", { signal });
    void app.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log("error", "unhandled rejection", { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  });
  process.on("uncaughtException", (error) => {
    app.log("error", "uncaught exception", { error: error.stack ?? error.message });
  });
}

main().catch((error) => {
  const code = (error as { errorCode?: string })?.errorCode ?? "INTERNAL";
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "pi-host", message: "pi-host failed to start", data: { code, error: error instanceof Error ? error.message : String(error) } })}\n`);
  process.stdout.write(`PI_HOST_FAILED ${JSON.stringify({ code })}\n`);
  process.exit(1);
});
