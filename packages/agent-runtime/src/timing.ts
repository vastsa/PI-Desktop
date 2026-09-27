/**
 * Timing instrumentation for the agent turn loop (D137).
 *
 * A user reporting "running a command is slow" is almost never describing the
 * command: the wait is the approval prompt, the host round trip, or the model
 * round trip that follows every tool result. host-core logs its own three
 * segments; these lines cover the two the host cannot see — how long the
 * sidecar waited on `tools.execute` (approval included) and how long the
 * provider took before and during the next assistant message.
 *
 * Lines go to stderr, which the Electron main `Logger` wraps into the
 * `agent/timing.log` category file under `~/.pi-desktop/logs/`.
 */

export type TimingFields = Record<
  string,
  string | number | boolean | undefined
>;

export const TIMING_PREFIX = "[timing]";

/** `[timing] kind=tool tool=Bash hostRttMs=11842` — undefined fields drop out. */
export function formatTimingLine(kind: string, fields: TimingFields): string {
  const parts = [`kind=${kind}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "number" ? Math.round(value) : value}`);
  }
  return `${TIMING_PREFIX} ${parts.join(" ")}`;
}

/** Opt out with PI_DESKTOP_TIMING=0 — one line per tool call and per
 * assistant message is cheap, but a long unattended run need not pay it. */
export function timingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.PI_DESKTOP_TIMING;
  return raw !== "0" && raw !== "off" && raw !== "false";
}

export function logTiming(kind: string, fields: TimingFields): void {
  if (!timingEnabled()) return;
  process.stderr.write(`${formatTimingLine(kind, fields)}\n`);
}
