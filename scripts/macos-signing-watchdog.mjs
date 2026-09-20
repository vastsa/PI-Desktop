#!/usr/bin/env node
/**
 * macOS signing watchdog.
 *
 * Why this exists: `electron-builder --mac` prints one line
 * (`• signing file=... platform=darwin type=distribution identityName=...`) and
 * then goes silent for a long time. Three real reasons, all invisible in the
 * default output:
 *
 *   1. @electron/osx-sign signs serially, one `codesign` call per file, and only
 *      logs per file with `DEBUG=electron-osx-sign*`.
 *   2. When any `codesign` call fails, builder-util retries the whole round
 *      three times (5s/10s/15s) without printing anything.
 *   3. With `mac.notarize=true`, @electron/notarize zips the app, uploads it and
 *      waits for Apple's queue - visible only with `DEBUG=electron-notarize*`.
 *
 * This wrapper gives that stage a back channel:
 *
 *   - every child line is forwarded live with a `[sign] ` prefix (redacted),
 *   - `codesign` is wrapped by scripts/macos-codesign-shim.sh so each call is
 *     timed through $PI_CODESIGN_LOG (see --codesign-log),
 *   - a heartbeat reports phase/idle time/active codesign while output is
 *     silent, plus a bounded stall diagnostic dump,
 *   - a hard timeout terminates the whole process group and exits 124,
 *   - a summary with codesign call counts, percentiles and slowest files is
 *     printed on every exit path and appended to $GITHUB_STEP_SUMMARY.
 *
 * Usage:
 *   node scripts/macos-signing-watchdog.mjs [options] -- <command> [args...]
 *
 * Nothing here fails on a stall: waiting on Apple's notary queue is a legal,
 * silent, multi-minute wait.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_SOURCE_PATH = fileURLToPath(
  new URL("./macos-codesign-shim.sh", import.meta.url),
);
const DEFAULT_CODESIGN_LOG = join(
  tmpdir(),
  `pi-desktop-codesign-timing-${process.pid}.log`,
);
const DEFAULT_TIMEOUT_SECONDS = 2400;
const DEFAULT_STALL_SECONDS = 300;
const DEFAULT_HEARTBEAT_SECONDS = 60;

/**
 * Env values that must never reach the log, even if the child echoes them.
 * Password values are redacted at any length; the certificate blob and the
 * Apple ID keep a length guard so a short, innocuous value cannot rewrite
 * unrelated log text.
 */
const REDACT_ENV_KEYS = ["CSC_LINK", "APPLE_ID"];
const REDACT_ALWAYS_ENV_KEYS = [
  "CSC_KEY_PASSWORD",
  "APPLE_APP_SPECIFIC_PASSWORD",
];
/**
 * `-k` is in the list because `security set-key-partition-list ... -k <p12
 * password>` is how electron-builder unlocks the imported certificate, and
 * builder-util's own `executing` debug line does not redact that stem. The
 * cost is that an unrelated `-k <keychain path>` is redacted too.
 */
const REDACT_FLAG_PATTERN =
  /(--password|--keychain-password|--app-specific-password|-p|-k)\s+\S+/g;
const REDACT_FLAG_VALUE_PATTERN =
  /(-k|--password|--keychain-password|--app-specific-password)=\S+/g;

/** Only these processes are reported in a diagnostic dump (never their argv). */
const DIAGNOSTIC_COMMANDS = new Set([
  "codesign",
  "security",
  "notarytool",
  "stapler",
  "xcrun",
  "electron-builder",
  "node",
]);

const RECENT_OUTPUT_LINES = 20;
const CODESIGN_LOG_TAIL_LINES = 10;
const MAX_STALL_DUMPS = 3;
const SLOWEST_LIMIT = 5;
/** Rate limit so the watchdog never turns into a high frequency poller. */
const HEARTBEAT_MIN_INTERVAL_MS = 10_000;
const KILL_GRACE_MS = 10_000;
const SIGKILL_SETTLE_MS = 1000;

class UsageError extends Error {}

function usage() {
  return [
    "Usage: node scripts/macos-signing-watchdog.mjs [options] -- <command> [args...]",
    "",
    "Options:",
    "  --label <name>            Label used in the summary (default: basename of the command).",
    "  --timeout-seconds <n>     Hard timeout in seconds (default: 2400, env PI_SIGNING_TIMEOUT_SECONDS).",
    "  --stall-seconds <n>       Silence that counts as a stall, in seconds (default: 300, env PI_SIGNING_STALL_SECONDS).",
    "  --heartbeat-seconds <n>   Heartbeat interval while output is silent (default: 60, env PI_SIGNING_HEARTBEAT_SECONDS).",
    "  --codesign-log <path>     codesign timing log (default: $TMPDIR/pi-desktop-codesign-timing.log).",
    "  --summary-file <path>     Also write the summary lines to this file.",
    "  --no-codesign-shim        Do not inject the codesign timing shim (env PI_SIGNING_NO_CODESIGN_SHIM).",
    "",
    "Everything after `--` is the command to run; its stdout/stderr is forwarded line by line.",
  ].join("\n");
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isEnabledEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parsePositiveNumber(flag, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flag} expects a positive number, got: ${raw}`);
  }
  return value;
}

function parseArgv(argv) {
  const options = {
    label: "",
    timeoutSeconds: numberFromEnv(
      "PI_SIGNING_TIMEOUT_SECONDS",
      DEFAULT_TIMEOUT_SECONDS,
    ),
    stallSeconds: numberFromEnv(
      "PI_SIGNING_STALL_SECONDS",
      DEFAULT_STALL_SECONDS,
    ),
    heartbeatSeconds: numberFromEnv(
      "PI_SIGNING_HEARTBEAT_SECONDS",
      DEFAULT_HEARTBEAT_SECONDS,
    ),
    codesignLog: DEFAULT_CODESIGN_LOG,
    summaryFile: "",
    // The shim only adds timing; `PI_SIGNING_NO_CODESIGN_SHIM=1` is the
    // rollback switch if a keychain ever refuses to hand the key to a
    // wrapped codesign invocation.
    codesignShim: !isEnabledEnv("PI_SIGNING_NO_CODESIGN_SHIM"),
    command: [],
  };

  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    const nextValue = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      return value;
    };
    switch (arg) {
      case "--label":
        options.label = nextValue();
        break;
      case "--timeout-seconds":
        options.timeoutSeconds = parsePositiveNumber(arg, nextValue());
        break;
      case "--stall-seconds":
        options.stallSeconds = parsePositiveNumber(arg, nextValue());
        break;
      case "--heartbeat-seconds":
        options.heartbeatSeconds = parsePositiveNumber(arg, nextValue());
        break;
      case "--codesign-log":
        options.codesignLog = nextValue();
        break;
      case "--summary-file":
        options.summaryFile = nextValue();
        break;
      case "--no-codesign-shim":
        options.codesignShim = false;
        break;
      default:
        throw new UsageError(
          arg.startsWith("-")
            ? `unknown option: ${arg}`
            : `expected "--" before the command, got: ${arg}`,
        );
    }
  }

  options.command = argv.slice(index);
  if (options.command.length === 0) {
    throw new UsageError('no command given, expected "-- <command> [args...]"');
  }
  if (options.label === "") options.label = basename(options.command[0]);
  return options;
}

/**
 * Remove credentials from anything the watchdog prints. Output found in the
 * child's output is untrusted, so both known secret env values (length >= 6, to
 * avoid mangling short harmless values) and flag/value shapes are replaced.
 */
function redact(text) {
  let out = String(text);
  for (const key of REDACT_ALWAYS_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      out = out.split(value).join("[redacted]");
    }
  }
  for (const key of REDACT_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length >= 6) {
      out = out.split(value).join("[redacted]");
    }
  }
  out = out.replace(REDACT_FLAG_PATTERN, (_match, flag) => `${flag} [redacted]`);
  out = out.replace(
    REDACT_FLAG_VALUE_PATTERN,
    (_match, flag) => `${flag}=[redacted]`,
  );
  return out;
}

function resolveRealCodesign(pathValue) {
  try {
    const result = spawnSync("bash", ["-c", "command -v codesign"], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathValue },
    });
    const candidates = (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const candidate = candidates[candidates.length - 1];
    if (typeof candidate === "string" && candidate.startsWith("/")) {
      return candidate;
    }
  } catch {
    // Fall through to the system default.
  }
  return "/usr/bin/codesign";
}

/**
 * Line splitter that keeps partial lines buffered so a child killed mid-line
 * still flushes its remainder on exit ('end' or an explicit flush()).
 */
function createLineReader(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line.replace(/\r$/, ""));
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer.replace(/\r$/, ""));
      buffer = "";
    }
  });
  stream.on("error", () => {});
  return {
    flush() {
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    },
  };
}

/**
 * Parse the shim log. Records are tab separated:
 *   start <unix-seconds.ms> <pid> <space joined args>
 *   end   <unix-seconds.ms> <pid> <exit code>
 * Calls are paired FIFO per pid; anything left over is still running (or was
 * killed), which is exactly what the stall diagnostic and the summary need.
 */
function readCodesignLog(logPath) {
  const calls = [];
  const active = [];
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { calls, active, failures: 0 };
  }

  const pending = new Map();
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    if (parts[0] === "start" && parts.length >= 4) {
      const startedAt = Number(parts[1]);
      const pid = parts[2];
      const args = parts.slice(3).join("\t");
      const queue = pending.get(pid) ?? [];
      queue.push({
        pid,
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        args,
        exitCode: null,
      });
      pending.set(pid, queue);
      continue;
    }
    if (parts[0] === "end" && parts.length >= 4) {
      const endedAt = Number(parts[1]);
      const queue = pending.get(parts[2]);
      if (!queue || queue.length === 0) continue;
      const call = queue.shift();
      const duration =
        Number.isFinite(endedAt) && Number.isFinite(call.startedAt)
          ? Math.max(0, endedAt - call.startedAt)
          : 0;
      calls.push({
        pid: call.pid,
        args: call.args,
        exitCode: Number(parts[3]),
        duration,
        category: categorizeCodesign(call.args),
        target: codesignTarget(call.args),
      });
    }
  }

  for (const queue of pending.values()) {
    for (const call of queue) active.push(call);
  }
  active.sort((a, b) => a.startedAt - b.startedAt);

  const failures =
    active.length + calls.filter((call) => call.exitCode !== 0).length;
  return { calls, active, failures };
}

function categorizeCodesign(args) {
  if (/(^|\s)--verify(\s|$)/.test(args)) return "verify";
  if (/(^|\s)--display(\s|$)/.test(args)) return "display";
  if (/(^|\s)--sign(\s|$)/.test(args)) return "sign";
  return "other";
}

/** codesign takes its target as the last bare argument. */
function codesignTarget(args) {
  const tokens = args.split(" ").filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (!tokens[index].startsWith("-")) return tokens[index];
  }
  return args === "" ? "<unknown>" : args;
}

function percentile(sortedDurations, percent) {
  if (sortedDurations.length === 0) return 0;
  const rank = Math.ceil((percent / 100) * sortedDurations.length);
  const index = Math.min(
    sortedDurations.length - 1,
    Math.max(0, rank - 1),
  );
  return sortedDurations[index];
}

function seconds(value) {
  return `${value.toFixed(1)}s`;
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function signalNumber(signal) {
  const number = osConstants.signals?.[signal];
  return typeof number === "number" ? number : 0;
}

function run() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`macos-signing-watchdog: ${error.message}\n\n${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const startedAt = Date.now();
  const state = {
    phase: "starting",
    lastFile: "",
    recent: [],
    lastOutputAt: startedAt,
    lastHeartbeatAt: 0,
    lastStallAt: 0,
    stallCount: 0,
    timedOut: false,
    spawnError: null,
  };

  const isDarwin = process.platform === "darwin";
  const useShim = options.codesignShim && isDarwin;
  let shimRoot = "";
  let childEnv = { ...process.env };

  let shimActive = false;
  if (useShim) {
    try {
      const realCodesign = resolveRealCodesign(process.env.PATH ?? "");
      shimRoot = mkdtempSync(join(tmpdir(), "pi-desktop-signing-watchdog-"));
      const shimDir = join(shimRoot, "bin");
      mkdirSync(shimDir, { recursive: true });
      const shimPath = join(shimDir, "codesign");
      writeFileSync(shimPath, readFileSync(SHIM_SOURCE_PATH));
      chmodSync(shimPath, 0o755);
      mkdirSync(dirname(options.codesignLog), { recursive: true });
      // Start from an empty log so a previous run cannot pollute the summary.
      writeFileSync(options.codesignLog, "");
      childEnv = {
        ...childEnv,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        PI_CODESIGN_LOG: options.codesignLog,
        PI_CODESIGN_REAL: realCodesign,
      };
      shimActive = true;
    } catch (error) {
      // Timing data is diagnostics: losing it must not fail the release.
      shimRoot = "";
      process.stderr.write(
        `[sign] warning: codesign timing shim disabled (${redact(error.message)})\n`,
      );
    }
  }

  process.stdout.write(
    `[sign] watchdog label=${options.label} timeout=${options.timeoutSeconds}s stall=${options.stallSeconds}s heartbeat=${options.heartbeatSeconds}s codesign-shim=${shimActive ? "on" : "off"}\n`,
  );
  process.stdout.write(
    `[sign] watchdog command: ${redact(options.command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" "))}\n`,
  );

  const heartbeatIntervalMs = Math.max(
    options.heartbeatSeconds * 1000,
    HEARTBEAT_MIN_INTERVAL_MS,
  );
  const stallIntervalMs = options.stallSeconds * 1000;
  // Never poll faster than 500ms and never slower than 10s: the heartbeat rate
  // limit and a stall dump both need a timely tick.
  const tickIntervalMs = Math.max(
    500,
    Math.min(
      HEARTBEAT_MIN_INTERVAL_MS,
      heartbeatIntervalMs,
      Math.max(stallIntervalMs, 500),
    ),
  );
  const heartbeatDueMs = Math.max(0, heartbeatIntervalMs - tickIntervalMs);
  const readShimState = () =>
    useShim
      ? readCodesignLog(options.codesignLog)
      : { calls: [], active: [], failures: 0 };

  function activeCodesign() {
    const { active } = readShimState();
    if (active.length === 0) return null;
    const latest = active[active.length - 1];
    return {
      pid: latest.pid,
      startedAt: latest.startedAt * 1000,
      args: latest.args,
      target: codesignTarget(latest.args),
    };
  }

  function targetName(active) {
    const target = state.lastFile || active?.target || "";
    return target === "" ? "none" : basename(target);
  }

  function detectPhase(line) {
    if (line.includes("Walking...")) return "walking";
    const signing = line.match(/Signing\.\.\.\s+(.+?)\s*$/);
    if (signing) {
      state.lastFile = signing[1];
      return `signing:${basename(signing[1])}`;
    }
    if (/Executing\.\.\./.test(line)) return "codesign";
    if (line.includes("Verifying...")) return "verifying";
    if (line.includes("signing file=")) return "packaging-sign";
    if (/notarization successful/i.test(line)) return "notarized";
    if (
      line.includes("notarizing using notarytool") ||
      line.includes("starting notarize process") ||
      line.includes("attempting to upload file to Apple") ||
      line.includes("zipping application to")
    ) {
      return "notarizing";
    }
    return null;
  }

  function handleLine(rawLine, sink) {
    const line = rawLine.replace(/\r$/, "");
    state.lastOutputAt = Date.now();
    state.lastStallAt = 0;
    const phase = detectPhase(line);
    if (phase !== null && phase !== state.phase) {
      state.phase = phase;
      sink.write(`[sign] phase: ${redact(phase)}\n`);
    }
    const safe = redact(line);
    state.recent.push(safe);
    if (state.recent.length > RECENT_OUTPUT_LINES) state.recent.shift();
    sink.write(`[sign] ${safe}\n`);
  }

  function processSnapshot() {
    try {
      const raw = execFileSync("ps", ["-Ao", "pid=,etime=,comm="], {
        encoding: "utf8",
      });
      const rows = [];
      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*\S)\s*$/);
        if (!match) continue;
        const [, pid, etime, comm] = match;
        if (!DIAGNOSTIC_COMMANDS.has(basename(comm))) continue;
        rows.push(`${pid} ${etime} ${comm}`);
      }
      return rows;
    } catch {
      return [];
    }
  }

  function codesignLogTail() {
    if (!useShim) return [];
    try {
      const raw = readFileSync(options.codesignLog, "utf8");
      return raw
        .split("\n")
        .filter((line) => line !== "")
        .slice(-CODESIGN_LOG_TAIL_LINES)
        .map((line) => redact(line));
    } catch {
      return [];
    }
  }

  // The dump is reused verbatim by the timeout path.
  function writeDiagnostics() {
    const lines = [];
    lines.push("[sign] STALL: recent output:");
    if (state.recent.length === 0) {
      lines.push("[sign]   <none>");
    } else {
      for (const line of state.recent) lines.push(`[sign]   ${line}`);
    }
    lines.push("[sign] STALL: processes:");
    const processes = processSnapshot();
    if (processes.length === 0) {
      lines.push("[sign]   <none>");
    } else {
      for (const row of processes) lines.push(`[sign]   ${row}`);
    }
    lines.push("[sign] STALL: codesign log tail:");
    const tail = codesignLogTail();
    if (tail.length === 0) {
      lines.push("[sign]   <none>");
    } else {
      for (const row of tail) lines.push(`[sign]   ${row}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  function onTick() {
    const now = Date.now();
    const idleMs = now - state.lastOutputAt;
    const active = activeCodesign();

    // One tick of slack: the heartbeat is polled, and the tick that lands just
    // before the interval boundary must not skip a whole period. The 10s rate
    // limit below still keeps the print rate bounded.
    if (
      idleMs >= heartbeatDueMs &&
      now - state.lastHeartbeatAt >= HEARTBEAT_MIN_INTERVAL_MS
    ) {
      state.lastHeartbeatAt = now;
      const activeStartedAt = active === null ? 0 : active.startedAt;
      const activeElapsed =
        active === null
          ? 0
          : Math.max(0, Math.floor((now - activeStartedAt) / 1000));
      process.stdout.write(
        `[sign] heartbeat elapsed=${Math.floor((now - startedAt) / 1000)}s phase=${state.phase} idle=${Math.floor(idleMs / 1000)}s active-codesign=${active === null ? "none" : active.pid} active-elapsed=${activeElapsed}s target=${targetName(active)}\n`,
      );
    }

    if (idleMs < stallIntervalMs) return;
    if (active !== null) return;
    if (state.stallCount >= MAX_STALL_DUMPS) return;
    if (now - state.lastStallAt < stallIntervalMs) return;
    state.lastStallAt = now;
    state.stallCount += 1;
    process.stdout.write(
      `[sign] STALL: no output for ${Math.floor(idleMs / 1000)}s (phase=${state.phase}); last file: ${state.lastFile === "" ? "unknown" : state.lastFile}\n`,
    );
    writeDiagnostics();
  }

  function killChildGroup(signal) {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  let finished = false;
  let tickTimer = null;
  let timeoutTimer = null;
  let killTimer = null;
  let settleTimer = null;

  function writeSummary(exitCode) {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const { calls, failures } = readShimState();
    const durations = calls
      .map((call) => call.duration)
      .sort((a, b) => a - b);
    const totalCodesignSeconds = calls.reduce(
      (sum, call) => sum + call.duration,
      0,
    );
    const categories = {
      sign: { count: 0, seconds: 0 },
      verify: { count: 0, seconds: 0 },
      display: { count: 0, seconds: 0 },
      other: { count: 0, seconds: 0 },
    };
    for (const call of calls) {
      const bucket = categories[call.category];
      bucket.count += 1;
      bucket.seconds += call.duration;
    }
    const slowest = [...calls]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, SLOWEST_LIMIT);

    const lines = [];
    lines.push(
      `[sign] summary label=${options.label} exit=${exitCode} elapsed=${seconds(elapsedSeconds)} codesign-calls=${calls.length} codesign-total=${seconds(totalCodesignSeconds)} p50=${seconds(percentile(durations, 50))} p95=${seconds(percentile(durations, 95))} max=${seconds(percentile(durations, 100))}`,
    );
    lines.push(
      `[sign] summary codesign-categories: sign=${categories.sign.count}/${seconds(categories.sign.seconds)} verify=${categories.verify.count}/${seconds(categories.verify.seconds)} display=${categories.display.count}/${seconds(categories.display.seconds)} other=${categories.other.count}/${seconds(categories.other.seconds)}`,
    );
    lines.push(
      `[sign] summary slowest: ${
        slowest.length === 0
          ? "<none>"
          : slowest
              .map(
                (call) =>
                  `${truncate(redact(call.target), 160)} ${seconds(call.duration)}`,
              )
              .join(" ")
      }`,
    );
    if (failures > 0) {
      lines.push(
        `[sign] summary failures: ${failures} codesign calls exited non-zero`,
      );
    }

    const output = `${lines.join("\n")}\n`;
    process.stdout.write(output);

    if (options.summaryFile !== "") {
      try {
        writeFileSync(options.summaryFile, output);
      } catch (error) {
        process.stderr.write(
          `[sign] error: cannot write summary file: ${redact(error.message)}\n`,
        );
      }
    }

    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (typeof stepSummary === "string" && stepSummary !== "") {
      const markdown = [
        `## macOS signing: ${options.label}`,
        "",
        "| metric | value |",
        "| --- | --- |",
        `| exit | ${exitCode} |`,
        `| elapsed | ${seconds(elapsedSeconds)} |`,
        `| codesign calls | ${calls.length} |`,
        `| codesign total | ${seconds(totalCodesignSeconds)} |`,
        `| codesign p50 | ${seconds(percentile(durations, 50))} |`,
        `| codesign p95 | ${seconds(percentile(durations, 95))} |`,
        `| codesign max | ${seconds(percentile(durations, 100))} |`,
        `| codesign failures | ${failures} |`,
        `| codesign slowest | ${slowest.length === 0 ? "<none>" : truncate(redact(slowest.map((call) => call.target).join(", ")), 400)} |`,
        "",
      ].join("\n");
      try {
        appendFileSync(stepSummary, markdown);
      } catch (error) {
        process.stderr.write(
          `[sign] error: cannot append to GITHUB_STEP_SUMMARY: ${redact(error.message)}\n`,
        );
      }
    }
  }

  function finishOnce(exitCode, signal) {
    if (finished) return;
    finished = true;
    if (tickTimer !== null) clearInterval(tickTimer);
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    if (killTimer !== null) clearTimeout(killTimer);
    if (settleTimer !== null) clearTimeout(settleTimer);
    tickTimer = null;
    timeoutTimer = null;
    killTimer = null;
    settleTimer = null;

    for (const reader of readers) reader.flush();

    let code;
    if (state.timedOut) {
      code = 124;
    } else if (typeof exitCode === "number") {
      code = exitCode;
    } else if (typeof signal === "string" && signal !== "") {
      code = 128 + signalNumber(signal);
    } else {
      code = state.spawnError === null ? 1 : 127;
    }

    writeSummary(code);

    if (shimRoot !== "") {
      try {
        rmSync(shimRoot, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover temp directory is harmless.
      }
    }

    process.exitCode = code;
  }

  function onTimeout() {
    if (finished) return;
    state.timedOut = true;
    process.stdout.write(
      `[sign] TIMEOUT after ${options.timeoutSeconds}s (phase=${state.phase}, last file: ${state.lastFile === "" ? "unknown" : state.lastFile})\n`,
    );
    // Same diagnostic dump as a stall, so the stuck stage is still on record.
    writeDiagnostics();
    killChildGroup("SIGTERM");
    killTimer = setTimeout(() => {
      killChildGroup("SIGKILL");
      settleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finishOnce(124, null);
      }, SIGKILL_SETTLE_MS);
    }, KILL_GRACE_MS);
  }

  const child = spawn(options.command[0], options.command.slice(1), {
    env: childEnv,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so a timeout can terminate codesign children too.
    detached: true,
  });

  const readers = [
    child.stdout === null
      ? null
      : createLineReader(child.stdout, (line) => handleLine(line, process.stdout)),
    child.stderr === null
      ? null
      : createLineReader(child.stderr, (line) => handleLine(line, process.stderr)),
  ].filter((reader) => reader !== null);

  tickTimer = setInterval(onTick, tickIntervalMs);
  timeoutTimer = setTimeout(onTimeout, options.timeoutSeconds * 1000);

  child.on("error", (error) => {
    state.spawnError = error;
    process.stderr.write(
      `[sign] error: cannot start ${redact(options.command[0])}: ${redact(error.message)}\n`,
    );
    finishOnce(null, null);
  });

  child.on("close", (code, signal) => {
    finishOnce(code, signal);
  });

  const forwardSignal = (signal) => {
    killChildGroup(signal);
    finishOnce(null, signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
}

run();
