import { matchNamedPreset } from "@pi-desktop/shared";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

/**
 * pi-ai built-in providers that intentionally have no named API-key preset here.
 * Every entry must explain why; the guard fails once an entry goes stale.
 */
const UNSUPPORTED: Record<string, string> = {
  "amazon-bedrock":
    "requires SigV4 request signing plus a region, not a base URL and API key",
  "azure-openai-responses":
    "requires a per-resource endpoint and a deployment id",
  "cloudflare-ai-gateway": "the base URL embeds the account and gateway id",
  "cloudflare-workers-ai": "the base URL embeds the account id",
  "github-copilot": "offered as a vendor account (OAuth) service in this app",
  "google-vertex": "requires a project and location instead of a fixed base URL",
  "openai-codex":
    "offered as a vendor account (ChatGPT subscription) service in this app",
  radius:
    "pi_messages is an account-only style here and the gateway publishes no model list",
};

const providers = builtinProviders();

describe("pi-ai built-in provider sync", () => {
  it("keeps the documented exception list current", () => {
    const ids = new Set(providers.map((provider) => provider.id));
    expect(Object.keys(UNSUPPORTED).filter((id) => !ids.has(id))).toEqual([]);
    for (const [id, reason] of Object.entries(UNSUPPORTED)) {
      expect(reason.length, id).toBeGreaterThan(20);
      expect(matchNamedPreset({ vendorKey: id }), id).toBeUndefined();
    }
  });

  it("covers every other built-in provider with a named preset", () => {
    const unmatched = providers
      .filter((provider) => !(provider.id in UNSUPPORTED))
      .filter(
        (provider) =>
          !matchNamedPreset({
            vendorKey: provider.id,
            baseUrl: provider.baseUrl,
          }),
      )
      .map((provider) => provider.id);
    expect(unmatched).toEqual([]);
  });
});
