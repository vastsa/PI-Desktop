/**
 * Contract test for the GitHub REST client behind the connector (ADR
 * github-connector).
 *
 * The client is the only code that spends the user's GitHub token, so this
 * pins what it may send and where: one fixed host, a fixed header set, no
 * redirects, validated path segments. It also pins the failure vocabulary the
 * rest of the app relies on — a revoked token, a rate limit, and an outage
 * must each be told apart, and none of them may look like "no repositories".
 *
 * Every request goes to the scripted `fetchImpl`; nothing here reaches GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError, createGitHubApi } from "../electron/main/github/github-api.ts";

const TOKEN = "gho_apiFixtureToken0123456789";
const REPO = { owner: "octo-org", name: "hello.world" };

/** A fetch stand-in that answers from a handler and records each request. */
function scriptedFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const request = { url: String(url), init };
    requests.push(request);
    return handler(request, requests.length);
  };
  return { fetchImpl, requests };
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function repository(index) {
  return {
    name: `repo-${index}`,
    full_name: `octo-org/repo-${index}`,
    owner: { login: "octo-org" },
    private: index % 2 === 0,
    default_branch: "main",
    archived: false,
    pushed_at: "2026-11-19T10:00:00Z",
    description: index === 0 ? "first" : null,
  };
}

function repositoryPage(page, size) {
  return Array.from({ length: size }, (_, index) => repository((page - 1) * 100 + index));
}

function pageOf(url) {
  return Number(new URL(url).searchParams.get("page") ?? "1");
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    html_url: "https://github.com/octo-org/hello.world/pull/7",
    title: "Add a feature",
    draft: false,
    state: "open",
    merged_at: null,
    created_at: "2026-11-18T10:00:00Z",
    head: { ref: "pi-desktop/abc123" },
    base: { ref: "main" },
    ...overrides,
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

function assertGitHubHeaders(request) {
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("user-agent"), "pi-desktop");
  assert.equal(request.init.redirect, "error");
  assert.ok(request.init.signal instanceof AbortSignal, "the request carries a timeout signal");
  assert.equal(new URL(request.url).origin, "https://api.github.com");
}

test("viewer asks /user with the fixed header set and reads the token's scopes", async () => {
  const { fetchImpl, requests } = scriptedFetch(() =>
    json(
      { login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/u/1" },
      { headers: { "x-oauth-scopes": "repo, read:org ,workflow" } },
    ),
  );
  const api = createGitHubApi({ fetchImpl });

  assert.deepEqual(await api.viewer(TOKEN), {
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.example/u/1",
    scopes: ["repo", "read:org", "workflow"],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/user");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.body, undefined);
  assertGitHubHeaders(requests[0]);
});

test("a token that reports no scope header has no scopes", async () => {
  const { fetchImpl } = scriptedFetch(() => json({ login: "octocat", name: null }));
  const viewer = await createGitHubApi({ fetchImpl }).viewer(TOKEN);
  assert.deepEqual(viewer, { login: "octocat", scopes: [] });

  const empty = scriptedFetch(() => json({ login: "octocat" }, { headers: { "x-oauth-scopes": "" } }));
  assert.deepEqual((await createGitHubApi({ fetchImpl: empty.fetchImpl }).viewer(TOKEN)).scopes, []);
});

test("repositories are read page by page until a short page", async () => {
  const { fetchImpl, requests } = scriptedFetch((request) => {
    const page = pageOf(request.url);
    return json(repositoryPage(page, page < 3 ? 100 : 50));
  });
  const result = await createGitHubApi({ fetchImpl }).listRepositories(TOKEN);

  assert.equal(result.repositories.length, 250);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.repositories[0], {
    owner: "octo-org",
    name: "repo-0",
    fullName: "octo-org/repo-0",
    private: true,
    defaultBranch: "main",
    archived: false,
    pushedAt: "2026-11-19T10:00:00Z",
    description: "first",
  });
  assert.equal("description" in result.repositories[1], false);
  assert.equal(result.repositories[249].name, "repo-249");

  assert.equal(requests.length, 3);
  requests.forEach((request, index) => {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/user/repos");
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("sort"), "pushed");
    assert.equal(
      url.searchParams.get("affiliation"),
      "owner,collaborator,organization_member",
    );
    assert.equal(url.searchParams.get("page"), String(index + 1));
    assertGitHubHeaders(request);
  });
});

test("an exactly full last page costs one more request and is not truncated", async () => {
  const { fetchImpl, requests } = scriptedFetch((request) =>
    json(repositoryPage(pageOf(request.url), pageOf(request.url) === 1 ? 100 : 0)),
  );
  const result = await createGitHubApi({ fetchImpl }).listRepositories(TOKEN);
  assert.equal(result.repositories.length, 100);
  assert.equal(result.truncated, false);
  assert.equal(requests.length, 2);
});

test("repositories stop at ten pages and say the list is truncated", async () => {
  const { fetchImpl, requests } = scriptedFetch((request) =>
    json(repositoryPage(pageOf(request.url), 100)),
  );
  const result = await createGitHubApi({ fetchImpl }).listRepositories(TOKEN);

  assert.equal(result.repositories.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(requests.length, 10);
});

test("a rate limit on a later page rejects instead of returning a partial list", async () => {
  const { fetchImpl, requests } = scriptedFetch((request) => {
    if (pageOf(request.url) === 1) return json(repositoryPage(1, 100));
    return json(
      { message: "API rate limit exceeded for user ID 1." },
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795168800" },
      },
    );
  });
  const error = await rejection(createGitHubApi({ fetchImpl }).listRepositories(TOKEN));

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.errorCode, "GITHUB_RATE_LIMITED");
  assert.equal(error.retriable, true);
  assert.equal(error.status, 403);
  assert.equal(error.resetAt, new Date(1795168800 * 1000).toISOString());
  assert.equal(requests.length, 2);
  // The shape `wrap()` in the IPC registrar reads to mark an error retriable.
  assert.equal(error.data.errorCode, "GITHUB_RATE_LIMITED");
  assert.equal(error.data.retriable, true);
  assert.equal(error.data.resetAt, error.resetAt);
});

test("a secondary rate limit reports when to retry from retry-after", async () => {
  const { fetchImpl } = scriptedFetch(() =>
    json({ message: "You have exceeded a secondary rate limit." }, {
      status: 429,
      headers: { "retry-after": "30" },
    }),
  );
  const api = createGitHubApi({ fetchImpl, now: () => Date.parse("2026-11-20T08:00:00.000Z") });
  const error = await rejection(api.viewer(TOKEN));

  assert.equal(error.errorCode, "GITHUB_RATE_LIMITED");
  assert.equal(error.retriable, true);
  assert.equal(error.status, 429);
  assert.equal(error.resetAt, "2026-11-20T08:00:30.000Z");
});

test("a 403 with retry-after and quota left is still a rate limit", async () => {
  const { fetchImpl } = scriptedFetch(() =>
    json({ message: "abuse detection" }, {
      status: 403,
      headers: { "retry-after": "60", "x-ratelimit-remaining": "4999" },
    }),
  );
  const error = await rejection(createGitHubApi({ fetchImpl }).viewer(TOKEN));
  assert.equal(error.errorCode, "GITHUB_RATE_LIMITED");
});

test("a 429 without rate-limit headers is a rate limit with no reset time", async () => {
  const { fetchImpl } = scriptedFetch(() => json({ message: "slow down" }, { status: 429 }));
  const error = await rejection(createGitHubApi({ fetchImpl }).viewer(TOKEN));
  assert.equal(error.errorCode, "GITHUB_RATE_LIMITED");
  assert.equal(error.retriable, true);
  assert.equal(error.resetAt, undefined);
});

test("a rejected token is an authentication failure", async () => {
  const { fetchImpl } = scriptedFetch(() => json({ message: "Bad credentials" }, { status: 401 }));
  const error = await rejection(createGitHubApi({ fetchImpl }).listRepositories(TOKEN));

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.errorCode, "GITHUB_AUTH_FAILED");
  assert.equal(error.retriable, false);
  assert.equal(error.status, 401);
});

test("an organization SSO refusal is forbidden, with GitHub's own explanation", async () => {
  const message =
    "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.";
  const { fetchImpl } = scriptedFetch(() =>
    json({ message }, { status: 403, headers: { "x-ratelimit-remaining": "4990" } }),
  );
  const error = await rejection(createGitHubApi({ fetchImpl }).listBranches(TOKEN, REPO));

  assert.equal(error.errorCode, "GITHUB_FORBIDDEN");
  assert.equal(error.retriable, false);
  assert.equal(error.status, 403);
  assert.match(error.message, /SAML enforcement/);
});

test("a missing repository is not found", async () => {
  const { fetchImpl } = scriptedFetch(() => json({ message: "Not Found" }, { status: 404 }));
  const error = await rejection(createGitHubApi({ fetchImpl }).listBranches(TOKEN, REPO));
  assert.equal(error.errorCode, "GITHUB_NOT_FOUND");
  assert.equal(error.retriable, false);
});

test("a GitHub outage and an unreadable answer are retriable network failures", async () => {
  const outage = scriptedFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
  const outageError = await rejection(createGitHubApi({ fetchImpl: outage.fetchImpl }).viewer(TOKEN));
  assert.equal(outageError.errorCode, "GITHUB_NETWORK");
  assert.equal(outageError.retriable, true);
  assert.equal(outageError.status, 502);

  // A captive portal answers 200 with a page that is not GitHub's JSON.
  const portal = scriptedFetch(() => new Response("<html>sign in to wifi</html>", { status: 200 }));
  const portalError = await rejection(
    createGitHubApi({ fetchImpl: portal.fetchImpl }).listRepositories(TOKEN),
  );
  assert.equal(portalError.errorCode, "GITHUB_NETWORK");
  assert.equal(portalError.retriable, true);

  const wrongShape = scriptedFetch(() => json({ message: "not a list" }));
  const shapeError = await rejection(
    createGitHubApi({ fetchImpl: wrongShape.fetchImpl }).listRepositories(TOKEN),
  );
  assert.equal(shapeError.errorCode, "GITHUB_NETWORK");
});

test("a fetch that throws is a retriable network failure", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const error = await rejection(createGitHubApi({ fetchImpl }).viewer(TOKEN));

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.errorCode, "GITHUB_NETWORK");
  assert.equal(error.retriable, true);
  assert.equal(error.status, undefined);
});

test("a request that outlives the timeout is aborted and reported as a network failure", async () => {
  let aborted = false;
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal.reason);
      });
    });
  // `AbortSignal.timeout` does not keep the event loop alive on its own; in
  // the app the process does, here a referenced timer stands in for it.
  const keepAlive = setTimeout(() => {}, 5_000);
  let error;
  try {
    error = await rejection(createGitHubApi({ fetchImpl, timeoutMs: 20 }).viewer(TOKEN));
  } finally {
    clearTimeout(keepAlive);
  }

  assert.equal(aborted, true);
  assert.equal(error.errorCode, "GITHUB_NETWORK");
  assert.equal(error.retriable, true);
});

test("owner, repository, and branch names are checked before any request", async () => {
  const { fetchImpl, requests } = scriptedFetch(() => json({}));
  const api = createGitHubApi({ fetchImpl });
  const pull = { head: "feature", base: "main", title: "t", body: "", draft: false };

  const refused = [
    api.listBranches(TOKEN, { owner: "octo-org", name: ".." }),
    api.listBranches(TOKEN, { owner: "octo-org", name: "." }),
    api.listBranches(TOKEN, { owner: "octo-org", name: "a/b" }),
    api.listBranches(TOKEN, { owner: "octo-org", name: "repo?x=1" }),
    api.listBranches(TOKEN, { owner: "octo-org", name: "repo.git" }),
    api.listBranches(TOKEN, { owner: "octo-org", name: "" }),
    api.listBranches(TOKEN, { owner: "octo-org", name: "r".repeat(101) }),
    api.listBranches(TOKEN, { owner: "octo/org", name: "repo" }),
    api.listBranches(TOKEN, { owner: "..", name: "repo" }),
    api.listBranches(TOKEN, { owner: "-octo", name: "repo" }),
    api.listBranches(TOKEN, { owner: "octo-", name: "repo" }),
    api.listBranches(TOKEN, { owner: "o".repeat(40), name: "repo" }),
    api.listBranches(TOKEN, { owner: 7, name: "repo" }),
    api.findPullRequest(TOKEN, { owner: "octo-org", name: ".." }, "feature"),
    api.findPullRequest(TOKEN, REPO, "-x"),
    api.findPullRequest(TOKEN, REPO, "a..b"),
    api.findPullRequest(TOKEN, REPO, "feature&state=open"),
    api.findPullRequest(TOKEN, REPO, "branch.lock"),
    api.findPullRequest(TOKEN, REPO, ""),
    api.createPullRequest(TOKEN, { owner: "octo-org", name: ".." }, pull),
    api.createPullRequest(TOKEN, REPO, { ...pull, head: "a b" }),
    api.createPullRequest(TOKEN, REPO, { ...pull, base: "main\n" }),
    api.createPullRequest(TOKEN, REPO, { ...pull, base: "/main" }),
  ];
  for (const call of refused) {
    const error = await rejection(call);
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.errorCode, "INVALID_ARGUMENT");
    assert.equal(error.retriable, false);
  }
  assert.equal(requests.length, 0);
});

test("branches come with the default branch, read page by page", async () => {
  const { fetchImpl, requests } = scriptedFetch((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/repos/octo-org/hello.world") {
      return json({ default_branch: "trunk" });
    }
    const page = pageOf(request.url);
    const size = page === 1 ? 100 : 2;
    return json(
      Array.from({ length: size }, (_, index) => ({
        name: `branch-${page}-${index}`,
        protected: index === 0,
      })),
    );
  });
  const result = await createGitHubApi({ fetchImpl }).listBranches(TOKEN, REPO);

  assert.equal(result.defaultBranch, "trunk");
  assert.equal(result.branches.length, 102);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.branches[0], { name: "branch-1-0", protected: true });
  assert.deepEqual(result.branches[101], { name: "branch-2-1", protected: false });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "https://api.github.com/repos/octo-org/hello.world");
  assert.equal(
    requests[1].url,
    "https://api.github.com/repos/octo-org/hello.world/branches?per_page=100&page=1",
  );
  assert.equal(new URL(requests[2].url).searchParams.get("page"), "2");
  requests.forEach(assertGitHubHeaders);
});

test("branches stop at five pages and say the list is truncated", async () => {
  const { fetchImpl, requests } = scriptedFetch((request) => {
    if (!new URL(request.url).pathname.endsWith("/branches")) return json({ default_branch: "main" });
    return json(
      Array.from({ length: 100 }, (_, index) => ({ name: `b-${pageOf(request.url)}-${index}`, protected: false })),
    );
  });
  const result = await createGitHubApi({ fetchImpl }).listBranches(TOKEN, REPO);

  assert.equal(result.branches.length, 500);
  assert.equal(result.truncated, true);
  assert.equal(requests.length, 6);
});

test("findPullRequest asks for the head branch and prefers an open pull request", async () => {
  const { fetchImpl, requests } = scriptedFetch(() =>
    json([
      pullRequest({ number: 9, state: "closed", created_at: "2026-11-19T10:00:00Z" }),
      pullRequest({ number: 7, state: "open", draft: true, created_at: "2026-11-18T10:00:00Z" }),
    ]),
  );
  const found = await createGitHubApi({ fetchImpl }).findPullRequest(TOKEN, REPO, "pi-desktop/abc123");

  assert.deepEqual(found, {
    number: 7,
    url: "https://github.com/octo-org/hello.world/pull/7",
    title: "Add a feature",
    draft: true,
    state: "open",
    head: "pi-desktop/abc123",
    base: "main",
  });
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/repos/octo-org/hello.world/pulls");
  assert.equal(url.searchParams.get("state"), "all");
  assert.equal(url.searchParams.get("head"), "octo-org:pi-desktop/abc123");
  assert.equal(url.searchParams.get("per_page"), "5");
  assert.equal(requests[0].init.method, "GET");
  assertGitHubHeaders(requests[0]);
});

test("findPullRequest falls back to the most recent one and reports a merge", async () => {
  const { fetchImpl } = scriptedFetch(() =>
    json([
      pullRequest({ number: 3, state: "closed", created_at: "2026-11-10T10:00:00Z" }),
      pullRequest({
        number: 5,
        state: "closed",
        merged_at: "2026-11-17T10:00:00Z",
        created_at: "2026-11-16T10:00:00Z",
      }),
    ]),
  );
  const found = await createGitHubApi({ fetchImpl }).findPullRequest(TOKEN, REPO, "feature");
  assert.equal(found.number, 5);
  assert.equal(found.state, "merged");

  const closed = scriptedFetch(() => json([pullRequest({ number: 3, state: "closed" })]));
  const closedFound = await createGitHubApi({ fetchImpl: closed.fetchImpl }).findPullRequest(
    TOKEN,
    REPO,
    "feature",
  );
  assert.equal(closedFound.state, "closed");
});

test("findPullRequest answers null when the branch has no pull request", async () => {
  const { fetchImpl } = scriptedFetch(() => json([]));
  assert.equal(await createGitHubApi({ fetchImpl }).findPullRequest(TOKEN, REPO, "feature"), null);
});

test("createPullRequest posts the JSON body and returns the new pull request", async () => {
  const { fetchImpl, requests } = scriptedFetch(() =>
    json(pullRequest({ number: 12, draft: true, html_url: "https://github.com/octo-org/hello.world/pull/12" }), {
      status: 201,
    }),
  );
  const created = await createGitHubApi({ fetchImpl }).createPullRequest(TOKEN, REPO, {
    head: "pi-desktop/abc123",
    base: "main",
    title: "Add a feature",
    body: "Why this exists.",
    draft: true,
  });

  assert.deepEqual(created, {
    number: 12,
    url: "https://github.com/octo-org/hello.world/pull/12",
    title: "Add a feature",
    draft: true,
    state: "open",
    head: "pi-desktop/abc123",
    base: "main",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/repos/octo-org/hello.world/pulls");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(new Headers(requests[0].init.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    title: "Add a feature",
    head: "pi-desktop/abc123",
    base: "main",
    body: "Why this exists.",
    draft: true,
  });
  assertGitHubHeaders(requests[0]);
});

test("a refused pull request carries GitHub's first validation message", async () => {
  const { fetchImpl } = scriptedFetch(() =>
    json(
      {
        message: "Validation Failed",
        errors: [
          { resource: "PullRequest", code: "custom", message: "A pull request already exists for octo-org:feature." },
          { message: "second" },
        ],
      },
      { status: 422 },
    ),
  );
  const error = await rejection(
    createGitHubApi({ fetchImpl }).createPullRequest(TOKEN, REPO, {
      head: "feature",
      base: "main",
      title: "t",
      body: "",
      draft: false,
    }),
  );

  assert.equal(error.errorCode, "GITHUB_VALIDATION_FAILED");
  assert.equal(error.retriable, false);
  assert.equal(error.status, 422);
  assert.match(error.message, /A pull request already exists for octo-org:feature\./);

  const bare = scriptedFetch(() => json({ message: "Validation Failed" }, { status: 422 }));
  const bareError = await rejection(
    createGitHubApi({ fetchImpl: bare.fetchImpl }).createPullRequest(TOKEN, REPO, {
      head: "feature",
      base: "main",
      title: "t",
      body: "",
      draft: false,
    }),
  );
  assert.match(bareError.message, /Validation Failed/);
});

test("no failure message or error field ever contains the token", async () => {
  const echo = `echoing ${TOKEN} back`;
  const scenarios = [
    () => json({ message: echo }, { status: 401 }),
    () => json({ message: echo }, { status: 403 }),
    () => json({ message: echo }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    () => json({ message: echo }, { status: 404 }),
    () => json({ message: "Validation Failed", errors: [{ message: echo }] }, { status: 422 }),
    () => json({ message: echo }, { status: 400 }),
    () => new Response(echo, { status: 500 }),
    () => new Response(echo, { status: 200 }),
    () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    },
  ];
  for (const scenario of scenarios) {
    const { fetchImpl } = scriptedFetch(scenario);
    const api = createGitHubApi({ fetchImpl });
    const calls = [
      () => api.viewer(TOKEN),
      () => api.listRepositories(TOKEN),
      () => api.listBranches(TOKEN, REPO),
      () => api.findPullRequest(TOKEN, REPO, "feature"),
      () => api.createPullRequest(TOKEN, REPO, { head: "feature", base: "main", title: "t", body: "", draft: false }),
    ];
    for (const call of calls) {
      const error = await rejection(call());
      assert.ok(error instanceof GitHubApiError);
      const serialized = JSON.stringify({
        message: error.message,
        stack: error.stack,
        fields: { ...error },
        cause: String(error.cause ?? ""),
      });
      assert.equal(serialized.includes(TOKEN), false, `${error.errorCode} leaked the token`);
    }
  }
});

test("the default transport is the process fetch, resolved at call time", async () => {
  const original = globalThis.fetch;
  const seen = [];
  const api = createGitHubApi();
  // Installed after the client was built, as the proxy-aware fetch is in main.
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return json({ login: "octocat" });
  };
  try {
    assert.equal((await api.viewer(TOKEN)).login, "octocat");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.github.com/user");
});
