import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HostProcess as RuntimeHostProcess,
  type DiagnosedHostFailure,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  GlibcUnsupportedError,
  glibcMissingSymbol,
} from "./linux-glibc";
import { DbSchemaTooNewError, parseSchemaTooNew } from "./host-boot-diagnostics";
import { redactValue } from "./logger";

export type {
  HostNotificationHandler,
  ProcessExitHandler,
  StderrHandler,
} from "@pi-desktop/host-runtime";

function resolveHostBinary(): string {
  if (process.env.PI_DESKTOP_HOST_BIN && existsSync(process.env.PI_DESKTOP_HOST_BIN)) {
    return process.env.PI_DESKTOP_HOST_BIN;
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    // packaged resources
    join(process.resourcesPath || "", `bin/pi-desktop-host-core${exe}`),
    // monorepo dev/build
    join(__dirname, `../../../../target/debug/pi-desktop-host-core${exe}`),
    join(__dirname, `../../../../target/release/pi-desktop-host-core${exe}`),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    "host-core binary not found. Run `cargo build -p host-core` first.",
  );
}

/**
 * Directory holding the plugins this build ships, or null when it ships none.
 *
 * Mirrors `resolveBuiltinSkillPath`: electron-builder copies
 * `resources/plugins` to `<resources>/plugins`, and a source checkout reaches
 * the same tree relatively.
 */
function resolveBuiltinPluginsDir(): string | null {
  const candidates = [
    join(process.resourcesPath || "", "plugins"),
    join(__dirname, "../../resources/plugins"),
    join(__dirname, "../../../resources/plugins"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Name the two boot refusals the desktop phrases for the user (D380): a data
 * directory newer than this build, and a glibc below the packaged floor. The
 * schema refusal is checked first because its stderr line is the more specific
 * one; anything else stays the generic `HOST_UNAVAILABLE` transport error.
 */
export function diagnoseHostFailure({
  lastStderr,
  message,
}: {
  lastStderr: string;
  message: string;
}): DiagnosedHostFailure | null {
  const schema = parseSchemaTooNew(lastStderr) ?? parseSchemaTooNew(message);
  if (schema) {
    return Object.assign(new DbSchemaTooNewError(schema), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }
  if (glibcMissingSymbol(lastStderr) || glibcMissingSymbol(message)) {
    return Object.assign(new GlibcUnsupportedError(), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }
  return null;
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[host/runtime] ${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      channel: "host",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

/**
 * The desktop's host-core child: the shared stdio transport from
 * `@pi-desktop/host-runtime` plus the two things only Electron knows — where
 * this build keeps the binary and its bundled plugins, and how to name the
 * boot refusals the renderer phrases.
 */
export class HostProcess extends RuntimeHostProcess {
  constructor(dataDir: string, onStderr?: StderrHandler) {
    const builtinPlugins = resolveBuiltinPluginsDir();
    super({
      binaryPath: resolveHostBinary(),
      dataDir,
      // Only Electron knows whether this build runs from `resources/` or a
      // source checkout, so it resolves the bundled-plugin directory and
      // host-core simply reconciles its registry against it (ADR 0105).
      env: builtinPlugins ? { PI_DESKTOP_BUILTIN_PLUGINS_DIR: builtinPlugins } : {},
      onStderr: onStderr ?? fallbackStderrLogger,
      diagnoseFailure: diagnoseHostFailure,
    });
  }
}
