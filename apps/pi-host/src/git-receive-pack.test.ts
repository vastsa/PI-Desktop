import { describe, expect, it } from "vitest";

import { parseReceivePackCommands } from "./git-receive-pack.js";

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

function pkt(line: string): Buffer {
  const body = Buffer.from(line, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}
const FLUSH = Buffer.from("0000", "ascii");
const PACK = Buffer.from("PACK\u0000\u0000\u0000\u0002rest-of-the-pack", "latin1");

describe("parseReceivePackCommands", () => {
  it("reads a single command with capabilities after the NUL", () => {
    const body = Buffer.concat([pkt(`${A} ${B} refs/heads/pi-desktop/8b54618f6bc1\u0000 report-status side-band-64k agent=git/2.43.0\n`), FLUSH, PACK]);
    expect(parseReceivePackCommands(body)).toEqual({ complete: true, refs: ["refs/heads/pi-desktop/8b54618f6bc1"] });
  });

  it("reads several commands in order and stops at the first flush", () => {
    const body = Buffer.concat([
      pkt(`${A} ${B} refs/heads/pi-desktop/8b54618f6bc1\u0000report-status\n`),
      pkt(`${ZERO} ${B} refs/tags/v1\n`),
      pkt(`${A} ${B} refs/heads/main`),
      FLUSH,
      // Anything after the flush is pack data, even if it looks like a command.
      pkt(`${A} ${B} refs/heads/after-flush\n`),
    ]);
    expect(parseReceivePackCommands(body)).toEqual({ complete: true, refs: ["refs/heads/pi-desktop/8b54618f6bc1", "refs/tags/v1", "refs/heads/main"] });
  });

  it("reports a delete as a command on its ref", () => {
    const body = Buffer.concat([pkt(`${A} ${ZERO} refs/heads/main\u0000report-status delete-refs\n`), FLUSH]);
    expect(parseReceivePackCommands(body)).toEqual({ complete: true, refs: ["refs/heads/main"] });
  });

  it("accepts SHA-256 object ids and skips shallow lines", () => {
    const long = "c".repeat(64);
    const body = Buffer.concat([pkt(`shallow ${A}\n`), pkt(`${long} ${long} refs/heads/x\u0000object-format=sha256\n`), FLUSH]);
    expect(parseReceivePackCommands(body)).toEqual({ complete: true, refs: ["refs/heads/x"] });
  });

  it("is incomplete until the flush packet has arrived", () => {
    const command = pkt(`${A} ${B} refs/heads/x\u0000report-status\n`);
    expect(parseReceivePackCommands(Buffer.alloc(0))).toEqual({ complete: false, refs: [] });
    expect(parseReceivePackCommands(Buffer.from("00", "ascii"))).toEqual({ complete: false, refs: [] });
    expect(parseReceivePackCommands(command.subarray(0, 30))).toEqual({ complete: false, refs: [] });
    expect(parseReceivePackCommands(command)).toEqual({ complete: false, refs: ["refs/heads/x"] });
    expect(parseReceivePackCommands(Buffer.concat([command, Buffer.from("000", "ascii")]))).toEqual({ complete: false, refs: ["refs/heads/x"] });
    expect(parseReceivePackCommands(Buffer.concat([command, FLUSH]))).toEqual({ complete: true, refs: ["refs/heads/x"] });
  });

  it("marks a malformed length or command as malformed, never as complete", () => {
    const good = pkt(`${A} ${B} refs/heads/x\n`);
    const cases: Buffer[] = [
      Buffer.from("zzzz", "ascii"),
      Buffer.from("00g1abc", "ascii"),
      Buffer.from("0003", "ascii"),
      Buffer.from("0001", "ascii"),
      Buffer.from("0002", "ascii"),
      Buffer.from("0004", "ascii"),
      Buffer.from("+012abcdefgh", "ascii"),
      Buffer.from(" 12 abcdefghijklmnop", "ascii"),
      Buffer.concat([pkt("push-cert\u0000report-status\n"), FLUSH]),
      Buffer.concat([pkt(`${A} ${B}\n`), FLUSH]),
      Buffer.concat([pkt(`${A} ${B} \n`), FLUSH]),
      Buffer.concat([pkt(`${A}  ${B} refs/heads/x\n`), FLUSH]),
      Buffer.concat([pkt(`${A.slice(1)} ${B} refs/heads/x\n`), FLUSH]),
      Buffer.concat([pkt(`${A} ${"c".repeat(64)} refs/heads/x\n`), FLUSH]),
      Buffer.concat([pkt(`${A.toUpperCase()} ${B} refs/heads/x\n`), FLUSH]),
      Buffer.concat([pkt(`${A} ${B} refs/heads/x y\n`), FLUSH]),
      Buffer.concat([pkt(`${A} ${B} refs/heads/x\nextra\n`), FLUSH]),
      Buffer.concat([good, Buffer.from("zzzz", "ascii")]),
    ];
    for (const body of cases) {
      const parsed = parseReceivePackCommands(body);
      expect(parsed.malformed, body.toString("latin1")).toBe(true);
      expect(parsed.complete).toBe(false);
    }
  });

  it("never treats an empty command section as a push of nothing", () => {
    expect(parseReceivePackCommands(FLUSH)).toEqual({ complete: true, refs: [] });
  });
});
