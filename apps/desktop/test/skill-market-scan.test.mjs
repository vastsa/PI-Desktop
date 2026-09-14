import assert from "node:assert/strict";
import test from "node:test";
import { createSkillMarketAggregator } from "../electron/main/skill-market-scan.ts";

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
