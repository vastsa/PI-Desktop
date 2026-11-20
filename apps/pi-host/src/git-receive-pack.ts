/**
 * The command section of a `git-receive-pack` request body.
 *
 * A push over smart HTTP starts with pkt-lines, one ref update each
 * (`<old-id> SP <new-id> SP <ref>`, the first followed by NUL and the client's
 * capabilities), ended by a flush packet. Everything after that flush is pack
 * data. The credential proxy reads only this section to decide whether the
 * push may be forwarded.
 *
 * The parser is deliberately stricter than git: anything it does not
 * recognize is `malformed`, so the proxy and the server can never read the
 * same bytes as two different sets of ref updates.
 */

const FLUSH = 0;
const LENGTH_PREFIX = 4;
const OBJECT_ID = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const COMMAND = new RegExp(`^(${OBJECT_ID}) (${OBJECT_ID}) ([^ \\n\\u0000]+)$`, "u");
const SHALLOW = new RegExp(`^shallow ${OBJECT_ID}$`, "u");

export type ReceivePackCommands = {
  /** The flush packet that ends the command section has been read. */
  complete: boolean;
  /** Ref names of the commands read so far, in order; a delete names its ref too. */
  refs: string[];
  /** The bytes are not a receive-pack command section. Never set with `complete`. */
  malformed?: true;
};

function packetLength(prefix: Buffer, offset: number): number | null {
  let length = 0;
  for (let index = 0; index < LENGTH_PREFIX; index += 1) {
    const byte = prefix[offset + index]!;
    const digit = byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x61 && byte <= 0x66 ? byte - 0x57 : byte >= 0x41 && byte <= 0x46 ? byte - 0x37 : -1;
    if (digit < 0) return null;
    length = length * 16 + digit;
  }
  return length;
}

/**
 * Parse the start of a receive-pack request body. `complete` is false while
 * more bytes are needed; the caller bounds how many it is willing to read.
 */
export function parseReceivePackCommands(prefix: Buffer): ReceivePackCommands {
  const refs: string[] = [];
  const malformed = (): ReceivePackCommands => ({ complete: false, refs, malformed: true });
  let offset = 0;
  for (;;) {
    if (prefix.length - offset < LENGTH_PREFIX) return { complete: false, refs };
    const length = packetLength(prefix, offset);
    if (length === null) return malformed();
    if (length === FLUSH) return { complete: true, refs };
    // 0001 to 0003 are delimiters that do not belong here; 0004 is an empty line.
    if (length <= LENGTH_PREFIX) return malformed();
    if (prefix.length - offset < length) return { complete: false, refs };
    const payload = prefix.subarray(offset + LENGTH_PREFIX, offset + length);
    offset += length;
    // Capabilities follow a NUL; they never carry a ref update.
    const nul = payload.indexOf(0);
    let line = payload.subarray(0, nul < 0 ? payload.length : nul).toString("latin1");
    if (nul < 0 && line.endsWith("\n")) line = line.slice(0, -1);
    const command = COMMAND.exec(line);
    if (command) {
      // Both ids are of one hash algorithm.
      if (command[1]!.length !== command[2]!.length) return malformed();
      refs.push(command[3]!);
      continue;
    }
    if (SHALLOW.test(line)) continue;
    // A signed push (`push-cert`) or anything else unknown is not forwarded.
    return malformed();
  }
}
