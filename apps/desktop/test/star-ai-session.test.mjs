import assert from "node:assert/strict";
import test from "node:test";
import { STARAI_ORIGIN, STARAI_REFRESH, StarAiSession } from "../electron/main/star-ai-session.ts";
import { starAiModelFamily } from "../../../packages/shared/src/star-ai-model-family.ts";

import { STARAI_SERVICES, starAiGroupService, sortStarAiGroupsByRatio } from "../../../packages/shared/src/star-ai-services.ts";

const sessionReply = (id = 42) => Response.json({ success: true, data: {
  access_token: "session-token", access_expires_at: Math.floor(Date.now() / 1000) + 900,
  user: { id, username: "user" }, session: { sid: "test-session" },
} });

test("a new profile does not contact the relay, and simultaneous requests rotate only once", async () => {
  let cookie = false;
  let requests = 0;
  const account = new StarAiSession(async (url, init) => {
    assert.equal(url, STARAI_ORIGIN + STARAI_REFRESH);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("Origin"), STARAI_ORIGIN);
    assert.equal(init.credentials, "include");
    requests++;
    return sessionReply();
  }, async () => cookie);
  assert.equal(await account.session(), null);
  assert.equal(requests, 0);
  cookie = true;
  const [first, second] = await Promise.all([account.session(), account.session()]);
  assert.equal(first.account.id, 42);
  assert.equal(first, second);
  assert.equal(requests, 1);
});

test("directory binds each group to its own models, including Unicode and reserved URL characters", async () => {
  const group = "group / 中文&+";
  const account = new StarAiSession(async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, STARAI_ORIGIN);
    if (target.pathname === STARAI_REFRESH) return sessionReply();
    assert.equal(init.headers.get("Authorization"), "Bearer session-token");
    if (target.pathname === "/api/user/self/groups") {
      return Response.json({ success: true, data: {
        [group]: { desc: "  Group\n \tA\u0000 ", ratio: 0.125 },
        free: { desc: "Group A", ratio: 0 }, auto: { ratio: "自动" }, missing: { ratio: null },
      } });
    }
    if (target.pathname === "/api/pricing") return Response.json({ success: true,
      group_ratio: { [group]: 99, auto: 1 },
      data: [
        { model_name: "a", vendor_id: 2, enable_groups: [group] },
        { model_name: "forbidden", vendor_id: 2, enable_groups: [group] },
        { model_name: "b", enable_groups: ["free"] },
        { model_name: "movie", tags: "视频", enable_groups: [group] },
        { model_name: "rank", supported_endpoint_types: ["rerank"], enable_groups: [group] },
        { model_name: "all-only", enable_groups: ["all"] },
        { model_name: "zero", enable_groups: ["free"] },
        { model_name: "auto-listed", enable_groups: ["auto"] },
      ],
      vendors: [{ id: 2, name: "Anthropic" }],
    });
    assert.equal(target.pathname, "/api/user/models");
    return Response.json({ success: true, data: target.searchParams.get("group") === group ? ["b", "a", "a", "hidden", "movie", "rank", "all-only"] : ["zero", "auto-listed"] });
  }, async () => true);
  assert.deepEqual(await account.groups(await account.session()), [
    { id: group, label: group, description: "Group A", ratio: 0.125, models: ["a", "movie", "rank"], chatModels: ["a"], modelVendors: { a: "Anthropic" } },
    { id: "free", label: "free", description: "Group A", ratio: 0, models: ["zero"], chatModels: ["zero"] },
    { id: "auto", label: "auto", ratio: "auto", models: ["auto-listed"], chatModels: ["auto-listed"] },
  ]);
});

test("site vendor names resolve aliases and group descriptions never assign model families", () => {
  assert.equal(starAiModelFamily("deployment-42", "Anthropic"), "Claude");
  assert.equal(starAiModelFamily("eu.anthropic.claude-opus-4-6-v1"), "Claude");
  assert.equal(starAiModelFamily("gateway/o3-mini"), "GPT");
  assert.equal(starAiModelFamily("deepseek/deepseek-v4-flash"), "DeepSeek");
  assert.equal(starAiModelFamily("custom", "Site publisher"), "Site publisher");
  assert.equal(starAiModelFamily("custom"), "other");
});

test("unavailable marketplace never falls back to raw authorized model names", async () => {
  const account = new StarAiSession(async (url) => {
    const path = new URL(url).pathname;
    if (path === STARAI_REFRESH) return sessionReply();
    if (path === "/api/pricing") return new Response(null, { status: 503 });
    assert.equal(path, "/api/user/self/groups");
    return Response.json({ success: true, data: { live: { ratio: 0 } } });
  }, async () => true);
  await assert.rejects(account.groups(await account.session()), { errorCode: "STARAI_UNAVAILABLE" });
});

test("marketplace services follow the site's group names, precedence and stable ratio ordering", () => {
  assert.deepEqual(STARAI_SERVICES, ["gpt", "claude", "gemini", "domestic", "grok", "media", "other"]);
  const names = ["vip用户gpt", "claude满血cc渠道", "Gemini分组", "DeepSeek【高级渠道】", "Kimi分组", "GLM分组", "grok满血", "gpt-image专用", "绘图组", "XC"];
  assert.deepEqual(names.map(starAiGroupService), ["gpt", "claude", "gemini", "domestic", "domestic", "domestic", "grok", "media", "media", "other"]);
  const groups = ["auto", 0, 0.2, 3, 0.2].map((ratio, id) => ({id, ratio}));
  assert.deepEqual(sortStarAiGroupsByRatio(groups).map(g => g.id), [3, 2, 4, 1, 0]);
});

test("chat pins the origin, route, account and selected group", async () => {
  const requests = [];
  const account = new StarAiSession(async (url, init) => {
    if (url.endsWith(STARAI_REFRESH)) return sessionReply();
    requests.push([url, init]);
    return new Response("data: [DONE]\n\n");
  }, async () => true);
  const route = { accountId: 42, group: "group-a", model: "model-a" };
  const body = { group: "other", model: "other", messages: [], stream: true };
  const signal = new AbortController().signal;
  await assert.rejects(account.submitChat({ ...route, accountId: 99 }, body, signal), {errorCode: "STARAI_LOGIN_REQUIRED"});
  assert.equal(requests.length, 0);
  assert.match(await (await account.submitChat(route, body, signal)).text(), /DONE/);
  const [[url, init]] = requests;
  assert.equal(url, STARAI_ORIGIN + "/pg/chat/completions");
  assert.deepEqual(JSON.parse(init.body), { ...body, group: route.group, model: route.model });
  assert.equal(init.signal, signal);
  assert.equal(init.redirect, "error");
});

test("an expired or malformed account and a refresh completing after logout cannot authorize", async () => {
  const expired = new StarAiSession(async () => new Response(null, { status: 401 }), async () => true);
  assert.equal(await expired.session(), null);
  const corrupted = new StarAiSession(async () => Response.json({success:true,data:{access_token:"value"}}), async () => true);
  await assert.rejects(corrupted.session(), { errorCode: "STARAI_INVALID_RESPONSE" });
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const account = new StarAiSession(async () => { started.resolve(); return response.promise; }, async () => true);
  const reading = account.session();
  await started.promise;
  account.forget();
  response.resolve(sessionReply());
  await assert.rejects(reading, { errorCode: "STARAI_LOGIN_REQUIRED" });
});
