/**
 * QuickJS-WASI sandbox loading for codemode. Nothing here runs until a script
 * executes: the pi-codemode module, its worker, and the WASM binary load on
 * the first call and are cached for the life of the sidecar.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CodemodeResult,
  CodemodeSandboxOptions,
  CodemodeTool,
} from "@earendil-works/pi-codemode";
import { CODEMODE_LIMITS } from "./limits.js";

declare const PI_BUNDLED_NODE: string | boolean | undefined;

/** File names of the assets the sidecar bundle ships next to its chunks. */
export const CODEMODE_WORKER_FILE = "codemode-worker.js";
export const CODEMODE_WASM_FILE = "quickjs.wasm";

export type CodemodeAssets = { wasmPath: string; workerUrl: URL };

function bundled(): boolean {
  return typeof PI_BUNDLED_NODE !== "undefined" && String(PI_BUNDLED_NODE) === "true";
}

/**
 * Locate the bundled worker and WASM. esbuild may emit this module into the
 * bundle root or into `chunks/`; the assets always live in `chunks/`. A
 * missing asset fails the script instead of silently using node_modules,
 * which does not exist in a packaged app.
 */
export function resolveBundledCodemodeAssets(moduleUrl: string): CodemodeAssets {
  const directory = dirname(fileURLToPath(moduleUrl));
  const chunks = basename(directory) === "chunks" ? directory : join(directory, "chunks");
  const workerPath = join(chunks, CODEMODE_WORKER_FILE);
  const wasmPath = join(chunks, CODEMODE_WASM_FILE);
  if (!existsSync(workerPath) || !existsSync(wasmPath)) {
    throw new Error(`The codemode sandbox assets are missing from this build (${chunks}).`);
  }
  return { wasmPath, workerUrl: pathToFileURL(workerPath) };
}

type CodemodeModule = typeof import("@earendil-works/pi-codemode");
let modulePromise: Promise<CodemodeModule> | undefined;

function loadCodemodeModule(): Promise<CodemodeModule> {
  modulePromise ??= import("@earendil-works/pi-codemode").catch((error: unknown) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

// Shared by every session in this process. Admission waits in arrival order.
let activeWorkers = 0;
const waiters: Array<() => void> = [];

function admit(): void {
  while (waiters.length > 0 && activeWorkers < CODEMODE_LIMITS.maxWorkers) {
    activeWorkers += 1;
    waiters.shift()?.();
  }
}

function release(): void {
  activeWorkers -= 1;
  admit();
}

/** Reserve one worker slot. Resolves with why none was reserved, if so. */
function reserveWorker(signal: AbortSignal | undefined, timeoutMs: number): Promise<"reserved" | "aborted" | "timeout"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const settle = (outcome: "reserved" | "aborted" | "timeout") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      resolve(outcome);
    };
    const grant = () => settle("reserved");
    const onAbort = () => settle("aborted");
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    waiters.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
    admit();
  });
}

export type SandboxRunRequest = {
  code: string;
  tools: CodemodeTool[];
  globals: CodemodeTool[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Test seam; production resolves assets from the build layout. */
  assets?: CodemodeAssets;
};

export type SandboxRunOutcome =
  | { started: true; result: CodemodeResult }
  | { started: false; reason: "aborted" | "timeout" };

/**
 * Run one script in a fresh worker. The worker slot is held until the worker
 * actually exits, not merely until the result settles.
 */
export async function runInSandbox(request: SandboxRunRequest): Promise<SandboxRunOutcome> {
  const startedAt = performance.now();
  const admission = await reserveWorker(request.signal, Math.min(request.timeoutMs, CODEMODE_LIMITS.workerWaitMs));
  if (admission !== "reserved") return { started: false, reason: admission };
  let reserved = true;
  const releaseReservation = () => {
    if (!reserved) return;
    reserved = false;
    release();
  };
  let sandbox: InstanceType<CodemodeModule["CodemodeSandbox"]> | undefined;
  try {
    const codemode = await loadCodemodeModule();
    const assets = request.assets ?? (bundled() ? resolveBundledCodemodeAssets(import.meta.url) : undefined);
    const options: CodemodeSandboxOptions = {
      tools: request.tools,
      globals: request.globals,
      timeoutMs: Math.max(1, Math.round(request.timeoutMs - (performance.now() - startedAt))),
      memoryLimitBytes: CODEMODE_LIMITS.memoryLimitBytes,
      ...(assets ? { wasm: codemode.loadQuickJSWasm(assets.wasmPath), workerUrl: assets.workerUrl } : {}),
      acquireWorker: () => {
        if (!reserved) throw new Error("The script already settled");
        // From here the sandbox releases the slot when the worker exits.
        reserved = false;
        return release;
      },
    };
    sandbox = new codemode.CodemodeSandbox(options);
    const result = await sandbox.execute(request.code, request.signal ? { signal: request.signal } : {});
    return { started: true, result };
  } finally {
    await sandbox?.close();
    releaseReservation();
  }
}
