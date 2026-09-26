import { describe, expect, it } from "vitest";
import { isSyncableProvider } from "./provider-sync.js";

const base = { enabled: true, authKind: "api_key", hasSecret: true } as const;

describe("isSyncableProvider", () => {
  it("accepts an enabled user row with a key, or one that needs none", () => {
    expect(isSyncableProvider(base)).toBe(true);
    expect(isSyncableProvider({ ...base, authKind: "none", hasSecret: false })).toBe(true);
  });

  it("refuses disabled, plugin-owned, OAuth, and keyless rows", () => {
    expect(isSyncableProvider({ ...base, enabled: false })).toBe(false);
    expect(isSyncableProvider({ ...base, ownerPluginId: "plugin" })).toBe(false);
    expect(isSyncableProvider({ ...base, hasOauth: true })).toBe(false);
    expect(isSyncableProvider({ ...base, authKind: "oauth" })).toBe(false);
    expect(isSyncableProvider({ ...base, hasSecret: false })).toBe(false);
  });
});
