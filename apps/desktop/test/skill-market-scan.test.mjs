import assert from "node:assert/strict";
import test from "node:test";
import { createSkillMarketAggregator } from "../electron/main/skill-market-scan.ts";
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
  assert.match(src, /import \{ createPublicHttpsClient \} from "\.\/public-https-fetch"/);
  assert.match(src, /createPublicHttpsClient\(\{ fetchImpl: \(url, init\) => net\.fetch\(url, init\) \}\)/);
  assert.match(src, /createSkillMarketAggregator\(client\.request\)/);
  assert.doesNotMatch(src, /node:https|node:http|axios|got\(/);
});

test("a failed source reports whether the policy or the transport refused it", async () => {
  const aggregator = createSkillMarketAggregator(async (url) => {
    if (url.includes("blocked.example")) {
      throw new PublicNetworkPolicyError(
        "hostname resolves to a private address: blocked.example -> 198.18.0.4",
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
});
