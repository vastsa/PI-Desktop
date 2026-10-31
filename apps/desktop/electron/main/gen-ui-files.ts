import {
  GEN_UI_MAX_FRAGMENT_BYTES,
  isGenUiFileName,
  isGenUiFragmentReadResult,
  isGenUiSessionId,
  type GenUiLocation,
} from "@pi-desktop/shared";

export type GenUiFragmentResult =
  | { ok: true; fragment: string }
  | { ok: false; status: 404 | 413 | 500; code: "not-found" | "too-large" | "runtime-unavailable" };
export type GenUiFragmentReader = (location: GenUiLocation) => Promise<GenUiFragmentResult>;
export type GenUiFragmentHost = {
  call(method: "visualizations.readFragment", params: GenUiLocation, timeoutMs?: number): Promise<unknown>;
};

const NOT_FOUND = { ok: false, status: 404, code: "not-found" } as const;
const TOO_LARGE = { ok: false, status: 413, code: "too-large" } as const;
const UNAVAILABLE = { ok: false, status: 500, code: "runtime-unavailable" } as const;

/**
 * Main never resolves or opens model-written paths. Host Core pins native
 * directory handles and returns only bounded bytes for a validated identity.
 * Resolve the active Host per request so restart and profile relocation do not
 * retain a stale process. This RPC is not exposed through renderer IPC.
 */
export function createGenUiFragmentReader(getHost: () => GenUiFragmentHost | null): GenUiFragmentReader {
  return async (location) => {
    if (!isGenUiSessionId(location.sessionId) || !isGenUiFileName(location.fileName)) return NOT_FOUND;
    const host = getHost();
    if (!host) return UNAVAILABLE;
    try {
      const result = await host.call("visualizations.readFragment", location, 5_000);
      if (!isGenUiFragmentReadResult(result)) {
        console.warn("[gen-ui] invalid native fragment response");
        return UNAVAILABLE;
      }
      if (!result.ok) return result.code === "too-large" ? TOO_LARGE : NOT_FOUND;
      const bytes = Buffer.from(result.base64, "base64");
      if (bytes.length > GEN_UI_MAX_FRAGMENT_BYTES) return TOO_LARGE;
      if (bytes.toString("base64") !== result.base64) {
        console.warn("[gen-ui] non-canonical native fragment encoding");
        return UNAVAILABLE;
      }
      return { ok: true, fragment: bytes.toString("utf8") };
    } catch {
      // Preserve a diagnosable fixed failure without logging filesystem paths
      // or fragment bytes from a transport exception.
      console.warn("[gen-ui] native fragment read failed");
      return UNAVAILABLE;
    }
  };
}
