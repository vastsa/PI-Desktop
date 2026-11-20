/**
 * Who is on the other end of a loopback TCP connection.
 *
 * The git credential proxy listens on `127.0.0.1`, and its per-session handle
 * is not a secret from other local users: git puts the proxy URL in the
 * arguments of its `git remote-http` helper, in `.git/FETCH_HEAD`, and in its
 * own output. What keeps another user from using a handle they read there is
 * this check: the proxy serves a connection only when the process that opened
 * it runs as the same user.
 *
 * Linux publishes every TCP socket with its owner's uid in `/proc/net/tcp`
 * (and `/proc/net/tcp6` for a socket opened as IPv6, where a loopback IPv4
 * address appears in its IPv4-mapped form).
 */
import { readFileSync } from "node:fs";

/** `127.0.0.1` as the kernel prints it: network byte order, as a little-endian hex word. */
const LOOPBACK_V4 = "0100007F";
/** `::ffff:127.0.0.1`. */
const LOOPBACK_MAPPED = "0000000000000000FFFF00000100007F";
const TABLES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
/** Columns: `sl local rem st tx:rx tr:when retrnsmt uid ...`. */
const UID_COLUMN = 7;

function endpoint(text: string): { loopback: boolean; port: number } | null {
  const colon = text.lastIndexOf(":");
  if (colon < 0) return null;
  const address = text.slice(0, colon).toUpperCase();
  const port = Number.parseInt(text.slice(colon + 1), 16);
  if (!Number.isInteger(port)) return null;
  return { loopback: address === LOOPBACK_V4 || address === LOOPBACK_MAPPED, port };
}

/**
 * The uid that owns the client end of the connection from
 * `127.0.0.1:<clientPort>` to `127.0.0.1:<serverPort>`, or `null` when the
 * table has no such row or the row cannot be read. The server's own accepted
 * end (local and remote swapped) is never returned.
 */
export function parseLoopbackPeerUid(table: string, clientPort: number, serverPort: number): number | null {
  const validPort = (port: number) => Number.isInteger(port) && port > 0 && port <= 65_535;
  if (!validPort(clientPort) || !validPort(serverPort)) return null;
  for (const line of table.split("\n")) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length <= UID_COLUMN) continue;
    const local = endpoint(columns[1]!);
    const remote = endpoint(columns[2]!);
    if (!local?.loopback || !remote?.loopback || local.port !== clientPort || remote.port !== serverPort) continue;
    const uid = columns[UID_COLUMN]!;
    return /^\d+$/u.test(uid) ? Number(uid) : null;
  }
  return null;
}

export type LoopbackPeerUidLookup = (clientPort: number, serverPort: number) => number | null;

/** A lookup over the kernel's socket tables; a table that is absent is skipped. */
export function createLoopbackPeerUidLookup(read: (path: string) => string = (path) => readFileSync(path, "utf8")): LoopbackPeerUidLookup {
  return (clientPort, serverPort) => {
    for (const path of TABLES) {
      let table: string;
      try { table = read(path); } catch { continue; }
      const uid = parseLoopbackPeerUid(table, clientPort, serverPort);
      if (uid !== null) return uid;
    }
    return null;
  };
}
