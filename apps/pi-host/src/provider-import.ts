import { ADMIN_MAX_BYTES, AdminError, adminSocketPath, sendAdminRequest } from "./admin-socket.js";
import { parseArgs, resolveDataDir } from "./config.js";

/** Read stdin up to the cap; the payload holds keys and is never logged. */
export async function readCapped(stream: NodeJS.ReadableStream, maxBytes = ADMIN_MAX_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes) throw new AdminError("PAYLOAD_TOO_LARGE", "stdin exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `pi-host provider-import [--data-dir <dir>]`. stdout carries exactly one of
 *   PI_HOST_PROVIDERS {summary}
 *   PI_HOST_FAILED {"code":..}
 * Returns the process exit code.
 */
export async function runProviderImport(
  argv: string[],
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = { stdin: process.stdin, stdout: process.stdout },
): Promise<number> {
  const fail = (code: string) => {
    io.stdout.write(`PI_HOST_FAILED ${JSON.stringify({ code })}\n`);
    return 1;
  };
  try {
    const dataDir = resolveDataDir(parseArgs(argv));
    const raw = await readCapped(io.stdin);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return fail("INVALID_REQUEST");
    }
    const response = await sendAdminRequest(adminSocketPath(dataDir), JSON.stringify({ op: "providers.import", payload }));
    if (!response.ok) return fail(response.code);
    io.stdout.write(`PI_HOST_PROVIDERS ${JSON.stringify(response.summary)}\n`);
    return 0;
  } catch (error) {
    return fail(error instanceof AdminError ? error.code : "INTERNAL");
  }
}
