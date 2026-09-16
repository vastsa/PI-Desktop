import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifySkillMarketFailure,
  createSkillMarketAggregator,
  skillMarketFailureDetail,
  skillMarketHost,
} from "../electron/main/skill-market-scan.ts";
import { PublicNetworkPolicyError } from "../electron/main/public-https-fetch.ts";

const source = {
  id: "anthropics-skills",
  name: "anthropics/skills",
  url: "https://github.com/anthropics/skills",
};

function makeRequest(files) {
  return async (url, kind) => {
    if (url === "https://api.github.com/repos/anthropics/skills") {
      return { default_branch: "main" };
    }
    if (url.includes("/git/trees/main")) {
      return {
        tree: [
          { path: "skills/pdf/SKILL.md" },
          { path: "skills/Frontend_Design/SKILL.md" },
          { path: "skills/pdf/FORMS.md" },
          { path: "skills/pdf/REFERENCE.md" },
          { path: "skills/pdf/scripts/run.py" },
        ],
      };
    }
    if (url.includes("data.jsdelivr.com")) {
      return {
        files: [
          { name: "skills/pdf/SKILL.md" },
          { name: "skills/pdf/FORMS.md" },
          { name: "skills/pdf/REFERENCE.md" },
          { name: "skills/pdf/scripts/run.py" },
        ],
      };
    }
    if (kind === "text") {
      const name = decodeURIComponent(url.split("/").pop());
      return files[name] ?? `# ${name}\n`;
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test("GitHub scan sanitizes ids to host-valid slugs and skips collisions", async () => {
  const aggregator = createSkillMarketAggregator(makeRequest({}));
  const { entries, failedSources } = await aggregator.search("", [source]);
  assert.deepEqual(failedSources, []);
  const ids = entries.map((entry) => entry.id);
  assert.ok(ids.includes("pdf"));
  assert.ok(ids.includes("frontend-design"));
  assert.equal(new Set(ids).size, ids.length);
  assert.match(entries.find((entry) => entry.id === "pdf").url, /cdn\.jsdelivr\.net/);
});

test("jsDelivr listing inlines adjacent markdown only", async () => {
  const aggregator = createSkillMarketAggregator(
    makeRequest({
      "SKILL.md": "---\nname: pdf\n---\nRead FORMS.md and REFERENCE.md.\n",
      "FORMS.md": "# Forms\n",
      "REFERENCE.md": "# Reference\n",
    }),
  );
  const { entries } = await aggregator.search("", [source]);
  const pdf = entries.find((entry) => entry.id === "pdf");
  const document = await aggregator.fetchEntryDocument(pdf);
  assert.equal(document.name, "pdf");
  assert.equal(document.resources?.length, 2);
  assert.deepEqual(
    document.resources.map((resource) => resource.path).sort(),
    ["FORMS.md", "REFERENCE.md"],
  );
});

test("unsafe source URLs fail closed without a request", async () => {
  let called = 0;
  const aggregator = createSkillMarketAggregator(async () => {
    called += 1;
    throw new Error("should not fetch");
  });
  const result = await aggregator.search("", [
    { id: "local", name: "local", url: "https://127.0.0.1/catalog.json" },
  ]);
  assert.equal(called, 0);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.failedSources, ["local"]);
});

test("main-process aggregator routes through the public-network client", async () => {
  // Review round 2 (#290): the containment lives in the main-process wiring —
  // the aggregator must consume the injected policy client, and the module
  // must build that client over Electron's net.fetch with no direct renderer
  // egress.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL("../electron/main/skill-market-catalog.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /import \{ net, session \} from "electron"/);
  assert.match(src, /fetchImpl: \(url, init\) => net\.fetch\(url, init\)/);
  assert.match(
    src,
    /routeImpl: \(url\) => session\.defaultSession\.resolveProxy\(url\)/,
  );
  assert.match(src, /createSkillMarketAggregator\(client\.request\)/);
  assert.doesNotMatch(src, /node:https|node:http|axios|got\(/);
});

test("a failed source reports whether the policy or the transport refused it", async () => {
  const aggregator = createSkillMarketAggregator(async (url) => {
    if (url.includes("blocked.example")) {
      throw new PublicNetworkPolicyError(
        "hostname resolves to a non-public address: blocked.example -> 198.18.0.4 (benchmark)",
        {
          reason: "non-public-address",
          host: "blocked.example",
          address: "198.18.0.4",
          addressKind: "benchmark",
        },
      );
    }
    throw new Error("responded 502");
  });
  const result = await aggregator.search("", [
    { id: "blocked", name: "blocked/repo", url: "https://blocked.example/catalog.json" },
    { id: "down", name: "down/repo", url: "https://down.example/catalog.json" },
    { id: "local", name: "local", url: "https://127.0.0.1/catalog.json" },
  ]);
  assert.deepEqual(result.entries, []);
  assert.deepEqual([...result.failedSources].sort(), ["blocked/repo", "down/repo", "local"]);
  // Issue #419: a policy refusal must not be indistinguishable from a dead host
  // or from a source that never left the syntactic guard.
  assert.deepEqual(result.failureKinds, {
    "blocked/repo": "policy",
    "down/repo": "network",
    local: "policy",
  });
  // …and each name now carries what it was about, not just which bucket it
  // landed in. A transport failure answers a 502 with a bare host.
  assert.deepEqual(result.failureDetails["blocked/repo"], {
    kind: "policy",
    host: "blocked.example",
    reason: "non-public-address",
    addressKind: "benchmark",
  });
  assert.deepEqual(result.failureDetails.local, {
    kind: "policy",
    host: "127.0.0.1",
    reason: "url-syntax",
  });
  assert.deepEqual(result.failureDetails["down/repo"], { kind: "network", host: "down.example" });
});

test("a repeated display name keeps the refusal, and a hostile name stays own", async () => {
  const aggregator = createSkillMarketAggregator(async () => {
    throw new Error("responded 502");
  });
  const result = await aggregator.search("", [
    { id: "a", name: "same", url: "https://127.0.0.1/catalog.json" },
    { id: "b", name: "same", url: "https://down.example/catalog.json" },
    { id: "c", name: "__proto__", url: "https://127.0.0.1/catalog.json" },
  ]);
  // `failedSources` cannot tell the two "same" sources apart, so the kind that
  // is worth surfacing (the refusal) must survive the merge.
  assert.equal(result.failureKinds.same, "policy");
  // A source named `__proto__` must land as an own property, not vanish into
  // the prototype where `Object.values` would never see it.
  assert.equal(Object.hasOwn(result.failureKinds, "__proto__"), true);
  assert.equal(result.failureKinds.__proto__, "policy");
  assert.deepEqual(Object.values(result.failureKinds), ["policy", "policy"]);
  // `failureDetails` is keyed the same way, and inherits the same hazard.
  assert.equal(Object.hasOwn(result.failureDetails, "__proto__"), true);
  assert.deepEqual(Object.keys(result.failureDetails).sort(), ["__proto__", "same"]);
});

test("the most specific failure survives a shared display name", async () => {
  // One label can hide three causes, and `failedSources` cannot tell them apart.
  // The merge keeps the most specific: a judged address beats a resolver with no
  // answer, which beats a plain transport failure. Surfacing the weaker one
  // would send the user after the wrong problem.
  const request = async (url) => {
    if (url.includes("judged.example")) {
      throw new PublicNetworkPolicyError("hostname resolves to a non-public address", {
        reason: "non-public-address",
        host: "judged.example",
        addressKind: "benchmark",
      });
    }
    if (url.includes("silent.example")) {
      throw new PublicNetworkPolicyError("hostname does not resolve: silent.example", {
        reason: "resolve-failed",
        host: "silent.example",
      });
    }
    throw new Error("responded 502");
  };
  const withJudged = await createSkillMarketAggregator(request).search("", [
    { id: "a", name: "shared", url: "https://silent.example/catalog.json" },
    { id: "b", name: "shared", url: "https://down.example/catalog.json" },
    { id: "c", name: "shared", url: "https://judged.example/catalog.json" },
  ]);
  assert.equal(withJudged.failureKinds.shared, "policy");
  assert.equal(withJudged.failureDetails.shared.reason, "non-public-address");

  const withoutJudged = await createSkillMarketAggregator(request).search("", [
    { id: "a", name: "shared", url: "https://silent.example/catalog.json" },
    { id: "b", name: "shared", url: "https://down.example/catalog.json" },
  ]);
  assert.equal(withoutJudged.failureKinds.shared, "unresolved");
  assert.equal(withoutJudged.failureDetails.shared.reason, "resolve-failed");
});

test("a diagnostics record names the host, never the URL or its credentials", async () => {
  // Issue #419: the market's failures wrote nothing to the app log, so a user
  // behind a proxy had no way to report which host was refused — or whether the
  // resolver had answered at all. The record is built here so its shape is fixed
  // and its redaction is testable.
  assert.deepEqual(
    skillMarketFailureDetail(
      { name: "anthropics/skills", url: "https://user:secret@github.com:8443/org/repo?token=abc#x" },
      new PublicNetworkPolicyError("hostname resolves to a non-public address", {
        reason: "non-public-address",
        host: "api.github.com",
        address: "198.18.0.4",
        addressKind: "benchmark",
      }),
    ),
    {
      source: "anthropics/skills",
      // The host the guard classified wins over the source's own host: a GitHub
      // `owner/repo` source is scanned through `api.github.com`, and naming the
      // repository host there would point at a host that was never refused.
      host: "api.github.com",
      kind: "policy",
      reason: "non-public-address",
      addressKind: "benchmark",
    },
  );
  // The class travels, the address never does.
  const judged = skillMarketFailureDetail(
    { name: "anthropics/skills", url: "https://github.com/anthropics/skills" },
    new PublicNetworkPolicyError("hostname resolves to a non-public address: api.github.com -> 198.18.0.4", {
      reason: "non-public-address",
      host: "api.github.com",
      address: "198.18.0.4",
      addressKind: "benchmark",
    }),
  );
  assert.equal(JSON.stringify(judged).includes("198.18.0.4"), false);
  // A resolver that answered nothing is not an address verdict, and the record
  // must not claim one.
  assert.deepEqual(
    skillMarketFailureDetail(
      { name: "anthropics/skills", url: "https://github.com/anthropics/skills" },
      new PublicNetworkPolicyError("hostname does not resolve: api.github.com (ENOTFOUND)", {
        reason: "resolve-failed",
        host: "api.github.com",
      }),
    ),
    {
      source: "anthropics/skills",
      host: "api.github.com",
      kind: "unresolved",
      reason: "resolve-failed",
    },
  );
  // A transport failure is not a refusal — including a 403, which is what a
  // rate-limited GitHub scan answers with.
  assert.equal(skillMarketFailureDetail(source, new Error("responded 502")).kind, "network");
  assert.equal(skillMarketFailureDetail(source, new Error("responded 403")).kind, "network");
  // A source the syntactic guard never let out still logs its name.
  assert.deepEqual(
    skillMarketFailureDetail({ name: "broken", url: "http://insecure.example" }, undefined),
    { source: "broken", host: "insecure.example", kind: "network" },
  );
  // An unparseable or missing URL must not produce a host field, and must not
  // throw while a failure is being reported.
  assert.equal(skillMarketHost(undefined), undefined);
  assert.equal(skillMarketHost("not a url"), undefined);
  assert.equal(skillMarketHost(42), undefined);
  assert.deepEqual(skillMarketFailureDetail({}, new Error("x")), { kind: "network" });
});

test("the classifier matches the aggregator's own classification", async () => {
  // One classifier, so the log line and the panel can never disagree.
  const unresolved = new PublicNetworkPolicyError("hostname does not resolve: x.example", {
    reason: "resolve-failed",
    host: "x.example",
  });
  const judged = new PublicNetworkPolicyError("hostname resolves to a non-public address: x.example", {
    reason: "non-public-address",
    host: "x.example",
    addressKind: "benchmark",
  });
  assert.equal(classifySkillMarketFailure(unresolved), "unresolved");
  assert.equal(classifySkillMarketFailure(judged), "policy");
  assert.equal(classifySkillMarketFailure(new Error("fetch failed")), "network");
  const aggregator = createSkillMarketAggregator(async () => {
    throw unresolved;
  });
  const result = await aggregator.search("", [source]);
  assert.equal(result.failureKinds["anthropics/skills"], classifySkillMarketFailure(unresolved));
  assert.equal(result.failureDetails["anthropics/skills"].reason, "resolve-failed");
});

test("both market channels report their failures to the app log", () => {
  // `skills-ipc.ts` imports Electron, so the wiring is asserted on the source:
  // the host, the guard's own reason and the class of address must all reach the
  // log, and the log must never carry the full URL.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../electron/main/ipc/skills-ipc.ts"),
    "utf8",
  );
  assert.match(src, /import type \{ Logger \} from "\.\.\/logger"/);
  assert.match(src, /logger: Pick<Logger, "app">/);
  assert.match(src, /logger\.app\("diagnostics", "warn", "skill market source produced no entries"/);
  assert.match(src, /logger\.app\("diagnostics", "warn", "skill market document fetch failed"/);
  assert.match(src, /event: "skillMarket\.sourceFailed"/);
  assert.match(src, /event: "skillMarket\.documentFailed"/);
  // Two codes, because only one of the two refusals judged an address.
  assert.match(src, /ErrorCodes\.NETWORK_POLICY_BLOCKED/);
  assert.match(src, /ErrorCodes\.NETWORK_RESOLVE_FAILED/);
  // The record carries the guard's own reason and the address class — the two
  // fields that tell "the resolver answered nothing" from "the address is not
  // public" (§09 diagnostics).
  assert.match(src, /reason: detail\.reason/);
  assert.match(src, /addressKind: detail\.addressKind/);
  assert.doesNotMatch(src, /data: \{ url|url: source\.url/);
  // The registration site must supply the logger, or the wiring above is dead.
  const register = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../electron/main/ipc/register.ts"),
    "utf8",
  );
  assert.match(register, /registerSkillsIpc\(\{[\s\S]*?logger,[\s\S]*?\}\)/);
});
