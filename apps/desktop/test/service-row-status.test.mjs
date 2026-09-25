/**
 * Behavior of the unified AI service row (D625): API services, plugin services
 * and vendor subscription accounts share one list, so each row derives its
 * title, badges and meta line from the provider row alone plus, for accounts,
 * the vendor entry the runtime reports.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  hostFromBaseUrl,
  monogramLetter,
  serviceRowBadges,
  serviceRowKind,
  serviceRowMeta,
  serviceRowTitle,
} from "../src/components/settings/service-row-status.ts";

// Echoes the key and its options, so assertions see which string was chosen.
const t = (key, options) => (options ? `${key}${JSON.stringify(options)}` : key);

const provider = (over = {}) => ({
  id: "p1",
  name: "OpenAI",
  vendorKey: "openai",
  enabled: true,
  hasSecret: true,
  hasOauth: false,
  authKind: "api_key",
  baseUrl: "https://api.openai.com/v1",
  models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
  ...over,
});

const account = (over = {}) =>
  provider({
    id: "acct-1",
    name: "Claude Pro/Max",
    vendorKey: "anthropic",
    authKind: "oauth",
    hasOauth: true,
    baseUrl: "https://api.anthropic.com",
    oauthAccountLabel: "me@example.com",
    ...over,
  });

const entry = (over = {}) => ({
  vendor: { vendorId: "anthropic", name: "Claude Pro/Max", isSubscription: true, accounts: [] },
  account: { providerId: "acct-1", accountLabel: "me@example.com", connected: true },
  ordinal: 1,
  totalForVendor: 1,
  ...over,
});

const badgeKeys = (row, context) =>
  serviceRowBadges(row, { isDefault: false, ...context }, t).map((badge) => badge.key);

test("a row's kind follows its credential and its owner", () => {
  assert.equal(serviceRowKind(provider()), "api");
  assert.equal(serviceRowKind(provider({ ownerPluginId: "acme" })), "plugin");
  assert.equal(serviceRowKind(account()), "account");
});

test("an API service is titled by its own name, exactly", () => {
  // The drag-order E2E reads the name span, so nothing may be appended to it.
  assert.deepEqual(serviceRowTitle(provider(), null, t), {
    name: "OpenAI",
    account: null,
    label: "OpenAI",
  });
});

test("an account reads vendor · account, with an ordinal only when needed", () => {
  assert.deepEqual(serviceRowTitle(account(), entry(), t), {
    name: "Claude Pro/Max",
    account: "me@example.com",
    label: "Claude Pro/Max · me@example.com",
  });
  const second = serviceRowTitle(account(), entry({ ordinal: 2, totalForVendor: 2 }), t);
  assert.equal(second.account, 'me@example.com · settings.vendorAccountNumber{"number":2}');
  // Before the vendor list loads the row still names itself.
  assert.equal(serviceRowTitle(account(), null, t).label, "Claude Pro/Max · me@example.com");
});

test("an account label that repeats the vendor name is not shown twice", () => {
  const unlabeled = account({ oauthAccountLabel: undefined });
  const repeated = account({ oauthAccountLabel: "Claude Pro/Max" });
  const noLabel = entry({ account: { providerId: "acct-1", connected: true } });
  assert.equal(serviceRowTitle(unlabeled, noLabel, t).label, "Claude Pro/Max");
  assert.equal(
    serviceRowTitle(repeated, entry({ account: { providerId: "acct-1", accountLabel: "Claude Pro/Max", connected: true } }), t).label,
    "Claude Pro/Max",
  );
});

test("badges appear only when they say something about the row", () => {
  assert.deepEqual(badgeKeys(provider()), []);
  assert.deepEqual(badgeKeys(provider(), { isDefault: true }), ["default"]);
  assert.deepEqual(badgeKeys(provider({ hasSecret: false })), ["no-secret"]);
  // A keyless local gateway is not missing anything.
  assert.deepEqual(badgeKeys(provider({ hasSecret: false, authKind: "none" })), []);
  assert.deepEqual(badgeKeys(provider({ enabled: false })), ["disabled"]);
});

test("a plugin row names its owner in the badge's tooltip", () => {
  const [badge] = serviceRowBadges(provider({ ownerPluginId: "acme" }), { isDefault: false }, t);
  assert.equal(badge.key, "plugin");
  assert.equal(badge.title, 'settings.pluginProviderManaged{"plugin":"acme"}');
});

test("an account reports sign-in state and subscription, never a missing key", () => {
  assert.deepEqual(badgeKeys(account(), { entry: entry() }), ["subscription"]);
  assert.deepEqual(
    badgeKeys(account({ hasOauth: false, hasSecret: false }), { entry: entry() }),
    ["signed-out", "subscription"],
  );
  const payAsYouGo = entry({ vendor: { ...entry().vendor, isSubscription: false } });
  assert.deepEqual(badgeKeys(account(), { entry: payAsYouGo, isDefault: true }), ["default"]);
});

test("the meta line shows endpoint and model count for services, count for accounts", () => {
  assert.deepEqual(serviceRowMeta(provider(), t), [
    "api.openai.com",
    'settings.providerModelCount{"count":2}',
  ]);
  assert.deepEqual(serviceRowMeta(provider({ ownerPluginId: "acme" }), t), [
    "api.openai.com",
    'settings.providerModelCount{"count":2}',
    'settings.pluginProviderBy{"plugin":"acme"}',
  ]);
  assert.deepEqual(serviceRowMeta(account(), t), ['settings.providerModelCount{"count":2}']);
  assert.deepEqual(serviceRowMeta(account({ hasOauth: false }), t), [
    "settings.vendorDisconnectedDesc",
  ]);
});

test("the monogram is the first letter or digit of the name", () => {
  assert.equal(monogramLetter("openai"), "O");
  assert.equal(monogramLetter("  (beta) gateway"), "B");
  assert.equal(monogramLetter("01.AI"), "0");
  assert.equal(monogramLetter("月之暗面"), "月");
  assert.equal(monogramLetter("—"), "");
});

test("the endpoint host survives an unparseable or missing base URL", () => {
  assert.equal(hostFromBaseUrl("https://api.openai.com/v1"), "api.openai.com");
  assert.equal(hostFromBaseUrl("api.example.com/v1"), "api.example.com");
  assert.equal(hostFromBaseUrl(undefined), "—");
});
