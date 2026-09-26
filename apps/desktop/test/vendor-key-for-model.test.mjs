/**
 * Vendor-owner resolution contract (issue #1028, follow-up).
 *
 * A custom OpenAI-compatible row serves several vendors at once, so its own
 * endpoint resolves to no catalog provider, and yet each id it serves is
 * published somewhere under a vendor route such as `openai/gpt-6-astra`. The
 * mark on a Composer row is keyed on that owner, so these assertions run
 * against the shipped snapshot rather than a fixture: a fixture would only prove
 * that the resolver agrees with itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

const catalog = new ModelsDevCatalog({
  catalogPath: fileURLToPath(
    new URL("../resources/models.dev/api.json", import.meta.url),
  ),
});

// A private deployment: nobody else's endpoint, so the row's own provider key
// cannot resolve — the exact case that used to leave every mark generic.
const gateway = { vendorKey: "custom", baseUrl: "http://127.0.0.1:3000/v1" };

await catalog.ensureLoaded();

test("the row's own endpoint resolves to no provider at all", () => {
  assert.equal(catalog.providerKeyForRow(gateway), undefined);
});

test("each model still names the vendor that owns it", () => {
  const owner = (modelId) => catalog.vendorProviderKeyForModel({ ...gateway, modelId });
  assert.equal(owner("gpt-6-astra"), "openai");
  assert.equal(owner("Qwen3.8-Flash-Next"), "alibaba-cn");
  assert.equal(owner("deepseek-v4-flash-stable"), "deepseek");
  // `moonshotai` and `moonshotai-cn` are two catalog rows of one vendor, and
  // the resolver lands on whichever spelling a publisher kept in the id. The
  // mark table maps both to one artwork, so either answer is the same vendor.
  for (const key of ["kimi-k3", "moonshotai/Kimi-K3"]) {
    assert.ok(
      ["moonshotai", "moonshotai-cn"].includes(owner(key) ?? ""),
      `expected a moonshot key for ${key}, got ${owner(key)}`,
    );
  }
  for (const key of ["MiniMax-M3", "minimax/minimax-m3"]) {
    assert.ok(
      ["minimax", "minimax-cn"].includes(owner(key) ?? ""),
      `expected a minimax key for ${key}, got ${owner(key)}`,
    );
  }

test("an id a vendor publishes without a route still names that vendor", () => {
  // Xiaomi publishes `mimo-v2.6-pro` under its own key with no `xiaomi/`
  // prefix, so the id alone carries no route. The publisher's own key is the
  // vendor, which is the same claim a route would make — the second signal.
  const owner = (modelId) => catalog.vendorProviderKeyForModel({ ...gateway, modelId });
  assert.equal(owner("mimo-v2.6-pro"), "xiaomi");
  assert.equal(owner("MiMo-V2.6-Pro"), "xiaomi");
  // A publisher that DID keep the route still resolves through it.
  assert.equal(owner("xiaomi/mimo-v2.5"), "xiaomi");
  assert.equal(owner("XiaomiMiMo/MiMo-V2.5"), "xiaomi");
  // A spelling no catalog record owns (a reseller's dashed variant) resolves to
  // nothing rather than being guessed at — the mark falls back.
  assert.equal(owner("mimo-v2-6-pro"), undefined);
  // The second signal is only sound if a gateway cannot claim the mark. These
  // publishers republish the id but are not in the vendor set, so they must be
  // skipped and the vendor's own row (or its route) must decide.
  const resellers = ["nano-gpt", "opencode-go", "requesty", "kilo", "vercel", "empiriolabs", "deepinfra"];
  for (const key of resellers) {
    assert.ok(
      !catalog.vendorProviderKeyForModel({
        vendorKey: "custom",
        baseUrl: `http://${key}.example/v1`,
        modelId: "gpt-6-astra",
      })?.startsWith(key),
      `${key} must not become the owner of a model it republishes`,
    );
  }
  assert.equal(
    catalog.vendorProviderKeyForModel({
      vendorKey: "custom",
      baseUrl: "http://nano-gpt.example/v1",
      modelId: "openai/gpt-6-astra",
    }),
    "openai",
  );
});

test("a vendor's own publication can own an id nobody routed", () => {
  // Muse Spark is published by `meta` with a bare id and no `meta/` route, so
  // without the publisher signal it would stay generic. This is the same rule
  // working, not a special case.
  assert.equal(
    catalog.vendorProviderKeyForModel({ ...gateway, modelId: "muse-spark-1.3-contributor" }),
    "meta",
  );
});
  assert.equal(owner("deepseek-v4-flash-stable"), "deepseek");
});

test("a row that names no vendor stays nameless instead of borrowing one", () => {
  // These ids carry no vendor route the catalog recognizes, so the resolver
  // must answer nothing and the UI must fall back — not pick a plausible vendor.
  assert.equal(catalog.vendorProviderKeyForModel({ ...gateway, modelId: "hy4-preview" }), undefined);
  assert.equal(catalog.vendorProviderKeyForModel({ ...gateway, modelId: "" }), undefined);
});

test("the owner never depends on which host published the record", () => {
  // Two endpoints that publish the same id under the same vendor route must
  // resolve to the same owner, so a user's choice of gateway changes nothing.
  const a = catalog.vendorProviderKeyForModel({
    vendorKey: "custom",
    baseUrl: "http://alpha.example/v1",
    modelId: "openai/gpt-6-astra",
  });
  const b = catalog.vendorProviderKeyForModel({
    vendorKey: "custom",
    baseUrl: "http://beta.example/v1",
    modelId: "gpt-6-astra",
  });
  assert.equal(a, "openai");
  assert.equal(b, "openai");
});

test("a published vendor's own row keeps resolving to itself", () => {
  // The row-level answer must not regress the provider-level one: a real
  // vendor's configured row still names that vendor.
  assert.equal(catalog.providerKeyForRow({ vendorKey: "openai" }), "openai");
  assert.equal(
    catalog.vendorProviderKeyForModel({ vendorKey: "openai", modelId: "gpt-6-astra" }),
    "openai",
  );
});
