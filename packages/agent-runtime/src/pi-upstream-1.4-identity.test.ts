import {
  formatUserAgent,
  getIdentityHeaders,
  mergeClientIdentity,
  PI_ATTRIBUTION,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DESKTOP_AGENT_IDENTITY } from "./agent-identity.js";

describe("Pi 1.4 client identity", () => {
  it("clears agent-core attribution while retaining pi-ai's detailed User-Agent", () => {
    const identity = mergeClientIdentity(
      { attribution: PI_ATTRIBUTION },
      DESKTOP_AGENT_IDENTITY,
    );

    expect(identity?.attribution).toBeNull();
    expect(formatUserAgent(identity)).toMatch(/^pi\/1\.4\.0 \(/);
    for (const target of [
      { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      { provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" },
      { provider: "opencode", baseUrl: "https://opencode.ai/zen/v1" },
    ]) {
      expect(getIdentityHeaders(target, identity)).toEqual({
        "User-Agent": formatUserAgent(identity),
      });
    }
  });
});
