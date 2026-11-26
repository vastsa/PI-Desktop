import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

const electron = "data:text/javascript," + encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const app = Object.assign(new EventEmitter(), {commandLine: {hasSwitch: () => false}});
`);
const relay = "data:text/javascript," + encodeURIComponent(`
  let partition;
  export function setPartition(value) { partition = value; }
  export function starAiPartition() { return partition; }
  export function hasStarAiCookie(profile) { return profile.signedIn; }
  export async function openStarAiLogin(_parent, profile) {
    profile.prompts++;
    await profile.onOpen?.();
    profile.signedIn = true;
  }
`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "electron") return { url: electron, shortCircuit: true };
  if (specifier === "./star-ai-login") return { url: relay, shortCircuit: true };
  if (context.parentURL?.includes("/electron/main/") && /^\.\/star-ai-[\w-]+$/.test(specifier)) {
    return next(specifier + ".ts", context);
  }
  return next(specifier, context);
} });
const { watchStarAiStartup } = await import("../electron/main/star-ai-startup.ts");
const { createStarAiAccount } = await import("../electron/main/star-ai-account.ts");
const { app } = await import(electron);
const { setPartition } = await import(relay);
hooks.deregister();

test("only a visible, ready main window prompts, once per visit or explicit relaunch", async () => {
  let ready = false;
  let visible = false;
  let attempts = 0;
  let finish;
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => visible, isMinimized: () => false, isDestroyed: () => false, isFocused: () => visible,
  });
  const catalog = { account: { id: 1, name: "Example" }, groups: [], selection: null };
  const setups = [];
  const check = watchStarAiStartup(window, { setupOnOpen: () => {
    attempts++;
    return new Promise((resolve, reject) => { finish = { resolve, reject }; });
  } }, () => ready, (value) => setups.push(value), assert.fail);
  try {
    check();
    ready = true;
    check();
    assert.equal(attempts, 0);
    visible = true;
    window.emit("show");
    check();
    app.emit("activate");
    assert.equal(attempts, 1);
    finish.reject(Object.assign(new Error("closed"), { errorCode: "STARAI_LOGIN_CANCELLED" }));
    await setImmediate();
    window.emit("focus");
    check();
    assert.equal(attempts, 1);
    assert.deepEqual(setups, []);
    app.emit("second-instance");
    assert.equal(attempts, 2);
    finish.resolve(catalog);
    await setImmediate();
    assert.deepEqual(setups, [catalog]);
    visible = false;
    window.emit("hide");
    app.emit("activate");
    assert.equal(attempts, 2);
    visible = true;
    window.emit("show");
    assert.equal(attempts, 3);
    finish.resolve(null);
    await setImmediate();
  } finally {
    window.emit("closed");
  }
  app.emit("activate");
  assert.equal(attempts, 3);
});

test("returning to the app resumes a sign-in deferred before its window opened", async () => {
  let focused = true;
  let attempts = 0;
  const ready = Promise.withResolvers();
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => true, isMinimized: () => false, isDestroyed: () => false, isFocused: () => focused,
  });
  const check = watchStarAiStartup(window, { async setupOnOpen() {
    if (++attempts === 1) await ready.promise;
    return null;
  } }, () => true, assert.fail, assert.fail);
  try {
    check();
    focused = false;
    ready.reject(Object.assign(new Error(), { errorCode: "STARAI_LOGIN_DEFERRED" }));
    await setImmediate();
    assert.equal(attempts, 1);
    focused = true;
    window.emit("focus");
    await setImmediate();
    assert.equal(attempts, 2);
  } finally {
    window.emit("closed");
  }
});

test("a single login configures every group, routes repeated models and preserves defaults", async () => {
  let snapshot = null;
  let settings = { defaultProviderId: "custom", defaultModelId: "my-chat" };
  let bindings = [];
  let groups = ["default", "premium"];
  const chats = [];
  let published = ["shared", "gpt-image-2.6"];
  let outage = false;
  const profile = {
    signedIn: false, prompts: 0, cookies: { flushStore: async () => {} },
    async fetch(url, init) {
      const path = new URL(url).pathname;
      if (path === "/api/user/auth/refresh") return Response.json({ success: true, data: {
        access_token: "fixture", access_expires_at: Date.now() / 1000 + 900,
        user: { id: 1, username: "Example" }, session: { sid: "fixture" },
      } });
      if (path === "/api/user/self/groups") return Response.json({ success: true, data: Object.fromEntries(groups.map(g => [g, {desc:"Chat"}])) });
      if (path === "/api/pricing") return outage ? new Response(null, { status: 503 }) : Response.json({
        success: true, vendors: [], data: published.map(model_name => ({ model_name, enable_groups: groups })),
      });
      if (path === "/api/user/models") return Response.json({ success: true, data: [
        "shared", "gpt-image-2.6", "gk-video-3.5-lk", "minimax_h3_768p", "grok-imagine-video-1.5（按次）",
        "gpt-4o-mini-transcribe", "embedding-small", "gemini-3-pro-image-preview",
      ] });
      assert.equal(path, "/pg/chat/completions");
      chats.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    },
  };
  setPartition(profile);
  const account = createStarAiAccount(() => ({ async call(method, args) {
    if (method === "settings.get") return settings;
    if (method === "providers.starAiSelection") return { selection: snapshot };
    if (method === "providers.starAiSuspend") {
      bindings = [];
      return {ok:true};
    }
    assert.equal(method, "providers.starAiConfigure");
    bindings = args.groups;
    snapshot = { accountId: args.accountId, groups: bindings.map(({baseUrl,secretValue,...row}) => row), selection: args.selection };
  } }), () => null);
  try {
    const opened = Promise.withResolvers();
    const release = Promise.withResolvers();
    profile.onOpen = () => { opened.resolve(); return release.promise; };
    const startup = account.setupOnOpen(() => true);
    await opened.promise;
    const manual = account.login();
    release.resolve();
    assert.equal(await startup, null);
    const { selection } = await manual;
    assert.deepEqual([selection.group, selection.model], ["default", "shared"]);
    const initial = [...bindings];
    assert.equal(initial.length, 2);
    assert.deepEqual(initial[0].models, ["gpt-image-2.6", "shared"]);
    assert.deepEqual(initial[0].chatModels, ["shared"]);
    assert.notEqual(initial[0].providerId, initial[1].providerId);
    for (const b of initial) {
      const response = await fetch(b.baseUrl + "/chat/completions", { method: "POST",
        headers: { Authorization: "Bearer " + b.secretValue, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "shared", group: "forged" }),
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    assert.deepEqual(chats.map(c => [c.group,c.model]), [["default","shared"],["premium","shared"]]);
    settings = { defaultProviderId: initial[1].providerId, defaultModelId: "shared" };
    assert.equal((await account.setupOnOpen(() => true)).selection.group, "premium");
    assert.equal(bindings[1].secretValue, initial[1].secretValue);
    groups = ["default"];
    assert.equal((await account.catalog()).selection.group, "default");
    assert.deepEqual(bindings.map(b => b.id), ["default"]);
    published = ["gpt-image-2.6"];
    await assert.rejects(account.activate({ group: "default", model: "shared" }), {errorCode:"STARAI_MODEL_UNAVAILABLE"});
    assert.deepEqual(bindings.map(b => b.chatModels), [[]]);
    assert.equal(snapshot.selection, null);
    const media = bindings[0];
    const rejected = await fetch(media.baseUrl + "/chat/completions", { method:"POST",
      headers: { Authorization: "Bearer " + media.secretValue, "Content-Type": "application/json" },
      body: JSON.stringify({ model:"gpt-image-2.6" }),
    });
    assert.equal(rejected.status, 403);
    await rejected.text();
    outage = true;
    await assert.rejects(account.catalog(), {errorCode:"STARAI_UNAVAILABLE"});
    assert.deepEqual(bindings, []);
    outage = false;
    published = ["shared"];
    assert.equal((await account.activate({ group: "default", model: "shared" })).catalog.selection.model, "shared");
    await account.restore();
    assert.deepEqual(bindings, []);
    assert.equal((await account.catalog()).selection.model, "shared");
    groups = [];
    assert.equal((await account.catalog()).selection, null);
    assert.equal(bindings.length, 0);
    assert.equal(profile.prompts, 1);
  } finally { account.close(); }
});
