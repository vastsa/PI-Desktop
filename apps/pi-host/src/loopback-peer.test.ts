import { describe, expect, it } from "vitest";

import { createLoopbackPeerUidLookup, parseLoopbackPeerUid } from "./loopback-peer.js";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (index: number, local: string, remote: string, uid: number, state = "01") =>
  `   ${index}: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${40000 + index} 1 0000000000000000 20 4 30 10 -1\n`;
const port = (value: number) => value.toString(16).toUpperCase().padStart(4, "0");
const V4 = "0100007F";
const MAPPED = "0000000000000000FFFF00000100007F";

// A client on port 50000 talking to a proxy on port 8080.
const CLIENT = 50000;
const PROXY = 8080;

describe("parseLoopbackPeerUid", () => {
  it("returns the uid of the client's end of the connection", () => {
    const table = HEADER
      + row(0, `${V4}:${port(PROXY)}`, "00000000:0000", 1000, "0A") // the listener
      + row(1, `${V4}:${port(PROXY)}`, `${V4}:${port(CLIENT)}`, 1000) // the proxy's accepted end
      + row(2, `${V4}:${port(CLIENT)}`, `${V4}:${port(PROXY)}`, 1001) // the client's end
      + row(3, `${V4}:${port(50001)}`, `${V4}:${port(PROXY)}`, 1002) // another client
      + row(4, `${V4}:${port(CLIENT)}`, `${V4}:${port(9090)}`, 1003); // same client port, another server
    expect(parseLoopbackPeerUid(table, CLIENT, PROXY)).toBe(1001);
    expect(parseLoopbackPeerUid(table, 50001, PROXY)).toBe(1002);
    expect(parseLoopbackPeerUid(table, CLIENT, 9090)).toBe(1003);
  });

  it("never mistakes the proxy's own end, or a non-loopback row, for the client", () => {
    const own = HEADER + row(0, `${V4}:${port(PROXY)}`, `${V4}:${port(CLIENT)}`, 1000);
    expect(parseLoopbackPeerUid(own, CLIENT, PROXY)).toBeNull();
    const remote = HEADER + row(0, `0A00000A:${port(CLIENT)}`, `${V4}:${port(PROXY)}`, 1000) + row(1, `0200007F:${port(CLIENT)}`, `${V4}:${port(PROXY)}`, 1000);
    expect(parseLoopbackPeerUid(remote, CLIENT, PROXY)).toBeNull();
  });

  it("reads the IPv4-mapped form of the IPv6 table", () => {
    const table = HEADER + row(0, `${MAPPED}:${port(CLIENT)}`, `${MAPPED}:${port(PROXY)}`, 1001)
      + row(1, `00000000000000000000000001000000:${port(50002)}`, `${MAPPED}:${port(PROXY)}`, 1002);
    expect(parseLoopbackPeerUid(table, CLIENT, PROXY)).toBe(1001);
    // `::1` is not the address the proxy listens on.
    expect(parseLoopbackPeerUid(table, 50002, PROXY)).toBeNull();
  });

  it("returns null when there is no row or the row cannot be read", () => {
    expect(parseLoopbackPeerUid("", CLIENT, PROXY)).toBeNull();
    expect(parseLoopbackPeerUid(HEADER, CLIENT, PROXY)).toBeNull();
    expect(parseLoopbackPeerUid(HEADER + row(0, `${V4}:${port(50001)}`, `${V4}:${port(PROXY)}`, 1001), CLIENT, PROXY)).toBeNull();
    const truncated = `${HEADER}   0: ${V4}:${port(CLIENT)} ${V4}:${port(PROXY)} 01 00000000:00000000\n`;
    expect(parseLoopbackPeerUid(truncated, CLIENT, PROXY)).toBeNull();
    const garbled = `${HEADER}   0: ${V4}:${port(CLIENT)} ${V4}:${port(PROXY)} 01 00000000:00000000 00:00000000 00000000  root        0 1 1\n`;
    expect(parseLoopbackPeerUid(garbled, CLIENT, PROXY)).toBeNull();
    expect(parseLoopbackPeerUid(HEADER + row(0, `${V4}:${port(CLIENT)}`, `${V4}:${port(PROXY)}`, 1001), Number.NaN, PROXY)).toBeNull();
    expect(parseLoopbackPeerUid(HEADER + row(0, `${V4}:${port(CLIENT)}`, `${V4}:${port(PROXY)}`, 1001), 70000, PROXY)).toBeNull();
  });
});

describe("createLoopbackPeerUidLookup", () => {
  it("searches both tables and tolerates a missing one", () => {
    const files: Record<string, string> = {
      "/proc/net/tcp": HEADER + row(0, `${V4}:${port(50001)}`, `${V4}:${port(PROXY)}`, 1002),
      "/proc/net/tcp6": HEADER + row(0, `${MAPPED}:${port(CLIENT)}`, `${MAPPED}:${port(PROXY)}`, 1001),
    };
    const read = (path: string) => { if (!(path in files)) throw new Error("ENOENT"); return files[path]!; };
    const lookup = createLoopbackPeerUidLookup(read);
    expect(lookup(CLIENT, PROXY)).toBe(1001);
    expect(lookup(50001, PROXY)).toBe(1002);
    expect(lookup(50009, PROXY)).toBeNull();
    delete files["/proc/net/tcp6"];
    expect(lookup(50001, PROXY)).toBe(1002);
    expect(lookup(CLIENT, PROXY)).toBeNull();
    delete files["/proc/net/tcp"];
    expect(lookup(50001, PROXY)).toBeNull();
  });
});
