/**
 * Loader for trusted extension modules (spec 07-plugins/16 §4.2).
 *
 * Uses `jiti/static` so the babel transform is bundled into the sidecar's
 * single-file build and no path resolution happens at runtime. Kernel
 * packages reach extensions through jiti `virtualModules`: the same module
 * objects the sidecar already holds, plus a shim for
 * `@earendil-works/pi-coding-agent` and an inert stub for
 * `@earendil-works/pi-tui` so a top-level import never fails.
 */
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";

export type ExtensionFactory = (api: unknown) => unknown;

export type StubSymbolReporter = (symbol: string) => void;

/** Callable, constructible, property-bearing nothing. */
function inertValue(): unknown {
  const target = function inert() {};
  const proxy: unknown = new Proxy(target, {
    apply: () => proxy,
    construct: () => proxy as object,
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined;
      if (prop === "toString" || prop === "valueOf") return () => "";
      return proxy;
    },
    set: () => true,
    has: () => true,
  });
  return proxy;
}

/**
 * `@earendil-works/pi-tui` stand-in. Every export exists and does nothing;
 * the first use of each symbol is reported so the diagnostics drawer can list
 * which terminal-UI features an extension expected.
 */
export function createTuiStub(onUse: StubSymbolReporter): Record<string, unknown> {
  const inert = inertValue();
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        if (typeof prop !== "string") return undefined;
        if (prop === "default") return inert;
        // A thenable module would hang `await import()`.
        if (prop === "then") return undefined;
        onUse(prop);
        return inert;
      },
      has: () => true,
      ownKeys: () => ["default"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: inert }),
    },
  );
}

/** Runtime surface of `@earendil-works/pi-coding-agent` that extensions import. */
export function createCodingAgentShim(): Record<string, unknown> {
  return {
    defineTool: <T>(tool: T): T => tool,
    /** Result type guards from the pi CLI's built-in tools. Trusted extensions
     * run beside the desktop's own tools, so these never match here. */
    isBashToolResult: () => false,
    isEditToolResult: () => false,
    isFindToolResult: () => false,
    isGrepToolResult: () => false,
    isLsToolResult: () => false,
    isReadToolResult: () => false,
    isWriteToolResult: () => false,
    isPowerShellToolResult: () => false,
    isToolCallEventType: (type: unknown) =>
      type === "tool_call" || type === "tool_result",
    VERSION: "0.85.1",
  };
}

export type CreateVirtualModulesOptions = {
  /** Extension the modules are built for; stub reports route to whichever
   * Runner most recently registered a reporter for it. */
  extensionId: string;
};

/**
 * Module factories are cached across Runners, so a cached module keeps the
 * virtual modules from its first load. Routing stub reports through this
 * registry keeps diagnostics attached to the Runner that is alive now.
 */
const stubReporters = new Map<string, StubSymbolReporter>();
/** Symbols each cached module touched at import time; replayed to later Runners. */
const stubSymbolsByExtension = new Map<string, Set<string>>();

export function setStubSymbolReporter(extensionId: string, reporter: StubSymbolReporter | undefined): void {
  if (reporter) stubReporters.set(extensionId, reporter);
  else stubReporters.delete(extensionId);
}

/** pi-tui symbols a cached module already touched, for Runners that reuse it. */
export function knownStubSymbols(extensionId: string): string[] {
  return [...(stubSymbolsByExtension.get(extensionId) ?? [])];
}

export function createVirtualModules(
  options: CreateVirtualModulesOptions,
): Record<string, unknown> {
  const tui = createTuiStub((symbol) => {
    let known = stubSymbolsByExtension.get(options.extensionId);
    if (!known) {
      known = new Set();
      stubSymbolsByExtension.set(options.extensionId, known);
    }
    known.add(symbol);
    stubReporters.get(options.extensionId)?.(symbol);
  });
  const codingAgent = createCodingAgentShim();
  return {
    typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": typeboxCompile,
    "@sinclair/typebox/value": typeboxValue,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-ai/compat": piAi,
    "@earendil-works/pi-coding-agent": codingAgent,
    "@earendil-works/pi-tui": tui,
    "@mariozechner/pi-agent-core": piAgentCore,
    "@mariozechner/pi-ai": piAi,
    "@mariozechner/pi-ai/compat": piAi,
    "@mariozechner/pi-coding-agent": codingAgent,
    "@mariozechner/pi-tui": tui,
  };
}

/**
 * Import an extension module and return its default export when it is a
 * factory function. A module without a default function resolves to
 * `undefined`; the caller reports that as a load error.
 */
export async function loadExtensionFactory(
  entry: string,
  virtualModules: Record<string, unknown>,
): Promise<ExtensionFactory | undefined> {
  // Lazy so Electron main, which bundles this package for discovery, never
  // pulls jiti into its own bundle; the sidecar bundle inlines it.
  const { createJiti } = await import("jiti/static");
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules,
  });
  const loaded = await jiti.import(entry, { default: true });
  return typeof loaded === "function" ? (loaded as ExtensionFactory) : undefined;
}
