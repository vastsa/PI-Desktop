import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const pickerSource = await readFile(
  new URL("../src/components/settings/ModelSelectionPanes.tsx", import.meta.url),
  "utf8",
);
const capabilitiesSource = await readFile(
  new URL(
    "../../../packages/agent-runtime/src/model-capabilities.ts",
    import.meta.url,
  ),
  "utf8",
);
const catalogSource = await readFile(
  new URL("../../../packages/shared/src/model-catalog.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("advanced settings choose the default thinking level among the enabled ones", () => {
  // Offering the published ladder instead of the enabled subset would store a
  // default the runtime clamps away on the next request.
  assert.match(pickerSource, /settings\.defaultThinkingLevel/);
  assert.match(pickerSource, /const enabledLevels = sortThinkingLevels\(/);
  assert.match(pickerSource, /enabledLevels\.map\(\(level\) => \(/);
  assert.match(pickerSource, /defaultThinkingLevel: event\.target/);
  // Nothing to choose when a binding enables one level or none.
  assert.match(pickerSource, /enabledLevels\.length > 1 \?/);
});

test("the capability checkboxes show and follow the published value", () => {
  assert.match(pickerSource, /settings\.imageInput/);
  assert.match(pickerSource, /settings\.documentInput/);
  assert.match(pickerSource, /supportsImages: next/);
  assert.match(pickerSource, /supportsDocuments: next/);
  // Agreeing with models.dev stores "follow the catalog" instead of an
  // equal-valued override, so a later catalog correction still lands and no
  // separate reset control is needed.
  assert.match(
    pickerSource,
    /onChange\(event\.target\.checked === published \? null : event\.target\.checked\)/,
  );
  assert.match(
    pickerSource,
    /const effective = typeof value === "boolean" \? value : published/,
  );
  // The published baseline is models.dev, never the stored override.
  assert.match(pickerSource, /modelMatchesFilter\(info, "vision"\) : false/);
  assert.match(pickerSource, /modelMatchesFilter\(info, "pdf"\) : false/);
});

test("the capability row carries no explanatory copy or extra controls", () => {
  // The panel is a dense list of per-model rows; a hint paragraph and a reset
  // link per capability crowded it without telling the user anything the
  // checkbox state does not already say.
  assert.doesNotMatch(pickerSource, /documentInputHint/);
  assert.doesNotMatch(pickerSource, /followPublished/);
  assert.doesNotMatch(pickerSource, /capabilityPublished|capabilityUnknown/);
  assert.doesNotMatch(styles, /provider-chosen-capability-(reset|state|hint)/);
});

test("capability overrides reach the transport modality arrays", () => {
  assert.match(capabilitiesSource, /function modalityOverride\(/);
  assert.match(capabilitiesSource, /nextInput\.add\("image"\)/);
  assert.match(capabilitiesSource, /nextInput\.add\("pdf"\)/);
  // Text input can never be dropped by an attachment override.
  assert.match(capabilitiesSource, /nextInput\.add\("text"\)/);
  // The adapter subset carries only blocks pi-ai can encode.
  assert.match(capabilitiesSource, /modality === "text" \|\| modality === "image"/);
  assert.match(catalogSource, /export function bindingSupportsImages\(/);
  assert.match(catalogSource, /export function bindingSupportsDocuments\(/);
});

test("the capability controls and default selector are styled", () => {
  assert.match(styles, /\.provider-chosen-capability-rows \{/);
  assert.match(styles, /\.provider-chosen-capability \{/);
  assert.match(styles, /\.provider-chosen-thinking-select \{/);
  assert.match(styles, /\.provider-chosen-thinking-select:focus-visible \{/);
});

test("thinking levels use a compact accessible grouped control", () => {
  assert.match(
    pickerSource,
    /className="provider-chosen-thinking-head">[\s\S]*?provider-chosen-thinking-hint[\s\S]*?<\/div>\s*<div[\s\S]*?className="provider-chosen-thinking-chips"/,
  );
  assert.match(pickerSource, /role="group"/);
  assert.match(styles, /\.provider-chosen-thinking-head \{/);
  assert.match(styles, /\.provider-chosen-thinking-hint \{/);
  assert.match(
    styles,
    /\.provider-chosen-thinking-chips \{[\s\S]*?width: fit-content;[\s\S]*?max-width: 100%;/,
  );
  assert.match(
    styles,
    /\.provider-thinking-chip \{[\s\S]*?border: 0;[\s\S]*?transition:/,
  );
  assert.match(
    styles,
    /\.provider-thinking-chip:focus-visible \{[\s\S]*?outline:/,
  );
});

test("a configured model keeps its published record when discovery omits it", () => {
  // The checkboxes read models.dev through this record. The live branch used to
  // return only what the endpoint listed, so a configured model the service no
  // longer advertises lost its capabilities and both boxes read as unpublished.
  assert.match(mainSource, /const withConfiguredBindings =/);
  const unions = mainSource.match(/withConfiguredBindings\(/g) ?? [];
  assert.ok(unions.length >= 3, `expected 3+ union sites, saw ${unions.length}`);
  // Discovery stays the authority on what the service offers: only the rows it
  // returned are cached as discovered.
  const liveReturn = mainSource.slice(
    mainSource.indexOf("await cacheForCurrentProvider(models);"),
  );
  assert.match(liveReturn.slice(0, 260), /models: withConfiguredBindings\(models\)/);
});

test("the published record is not shaped by the stored override", () => {
  // ModelInfo.modalities is the baseline the panel compares against. Applying
  // the binding to it would make an override its own justification.
  assert.match(
    mainSource,
    /modalities: catalogModelConfig\.modalities \?\? \{ input: \["text"\], output: \["text"\] \}/,
  );
  const decorate = mainSource.slice(
    mainSource.indexOf("const decorate ="),
    mainSource.indexOf("const withConfiguredBindings"),
  );
  assert.doesNotMatch(decorate, /reasoning: capabilities\.supportsReasoning/);
  assert.doesNotMatch(
    decorate,
    /supportedThinkingLevels: \[\.\.\.capabilities\.supportedThinkingLevels\]/,
  );
});

test("every image gate reads the override-shaped model config", () => {
  // Five independent reads used to answer "can this model see an image": the two
  // enrichment helpers, the sidecar launch params, the prompt transport gate and
  // history replay. A raw input.includes("image") on any of them would disagree
  // with the settings switch for exactly the models the override exists for.
  assert.doesNotMatch(mainSource, /modelConfig\?\.input\.includes\("image"\)/);
  assert.doesNotMatch(sidecarSource, /modelConfig\?\.input\.includes\("image"\)/);
  const gates = mainSource.match(/visionFromModelConfig\(/g) ?? [];
  assert.ok(gates.length >= 4, `expected 4+ vision gates, saw ${gates.length}`);
  assert.match(sidecarSource, /visionFromModelConfig\(params\.provider\.modelConfig\)/);
});

test("a model the catalog does not describe still reports its binding overrides", () => {
  // Both enrichment helpers fall back to the generic shape and then apply the
  // binding, matching the launch path; returning undefined instead would report
  // no image support for a hand-typed id whose transport does inline images.
  const enrichments = mainSource.match(
    /modelConfigWithBinding\(\s*\n\s*modelsDevModel\s*\n?\s*\?\s*modelConfigFromModelsDev/g,
  ) ?? [];
  assert.equal(enrichments.length, 2);
  assert.doesNotMatch(
    mainSource,
    /const modelConfig = catalogModelConfig\s*\n\s*\? modelConfigWithBinding/,
  );
});

test("the offered default and the saved default use one order", () => {
  // The panel lists enabled levels in canonical order; the save path must fall
  // back to the same first entry, or the user is shown one default and another
  // is persisted for a binding whose levels were toggled out of order.
  const orderings = pickerSource.match(/sortThinkingLevels\(/g) ?? [];
  assert.ok(orderings.length >= 3, `expected 3+ orderings, saw ${orderings.length}`);
  assert.match(pickerSource, /: \(sortThinkingLevels\(next\)\[0\] \?\? null\)/);
  assert.match(
    pickerSource,
    /const thinkingLevels = sortThinkingLevels\(binding\.thinkingLevels\)/,
  );
  assert.match(pickerSource, /const enabled = thinkingLevels/);
  assert.match(pickerSource, /: \(enabled\[0\] \?\? null\)/);
});
