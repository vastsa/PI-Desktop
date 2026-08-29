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

test("advanced settings expose three-state image and document overrides", () => {
  assert.match(pickerSource, /settings\.imageInput/);
  assert.match(pickerSource, /settings\.documentInput/);
  assert.match(pickerSource, /supportsImages: next/);
  assert.match(pickerSource, /supportsDocuments: next/);
  // "Follow the catalog" must stay representable, so the reset writes null
  // rather than freezing the current effective value into a boolean.
  assert.match(pickerSource, /onChange\(null\)/);
  assert.match(pickerSource, /settings\.followPublished/);
  assert.match(pickerSource, /const overridden = typeof value === "boolean"/);
  assert.match(
    pickerSource,
    /const effective = overridden \? value : \(published \?\? false\)/,
  );
  // The panel states how PDFs actually travel instead of implying inline bytes.
  assert.match(pickerSource, /settings\.documentInputHint/);
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
  assert.match(styles, /\.provider-chosen-capability-reset \{/);
  assert.match(styles, /\.provider-chosen-thinking-select \{/);
  // Keyboard users must see focus on both new controls.
  assert.match(styles, /\.provider-chosen-thinking-select:focus-visible \{/);
  assert.match(styles, /\.provider-chosen-capability-reset:focus-visible \{/);
});

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);

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
  assert.match(pickerSource, /const enabled = sortThinkingLevels\(thinkingLevels\)/);
  assert.match(pickerSource, /: \(enabled\[0\] \?\? null\)/);
});
