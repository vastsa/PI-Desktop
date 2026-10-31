import { readTranscriptModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const activityGroupSource = await readTranscriptModule("ActivityGroup.tsx");
const activityItemsSource = await readTranscriptModule("ActivityItems.tsx");
const assistantTurnSource = await readTranscriptModule("AssistantTurn.tsx");
const thinkingRowSource = await readTranscriptModule("shared.tsx");
const shimmerSource = await readFile(
  new URL("../src/features/chat/transcript/TextShimmer.tsx", import.meta.url),
  "utf8",
);
const turnProcessSource = await readFile(
  new URL("../src/lib/turn-process.ts", import.meta.url),
  "utf8",
);
const stylesSource = await loadStyles();

test("flat mode renders one outer process and no activity-group wrapper", () => {
  assert.match(assistantTurnSource, /resolveTranscriptDisplayMode/);
  assert.match(assistantTurnSource, /segmentTurnProcess\(process, displayMode\)/);
  assert.match(activityGroupSource, /displayMode === "flat"/);
  assert.match(activityGroupSource, /return <>\{renderedItems\}<\/>/);
  assert.match(turnProcessSource, /mode === "flat"/);
  assert.match(turnProcessSource, /parts: \[\.\.\.parts\]/);
});

test("command-first and fully-folded use distinct process segmentation", () => {
  assert.match(turnProcessSource, /mode === "fully-folded"/);
  assert.match(turnProcessSource, /coalesceProcessActivityParts\(parts\)/);
  assert.match(turnProcessSource, /isStandaloneRunActivity\(item\)/);
});

test("thinking rows expand by default in every transcript display mode", () => {
  assert.doesNotMatch(activityGroupSource, /thinkingDefaultOpen/);
  assert.match(activityItemsSource, /<ThinkingRow[\s\S]*?\n\s*autoOpen\n/);
});

test("thinking collapsed state uses the whole-run TextShimmer, not a spinner", () => {
  assert.match(thinkingRowSource, /import \{ TextShimmer \} from "\.\/TextShimmer"/);
  assert.match(thinkingRowSource, /active=\{streaming && !open\}/);
  assert.match(thinkingRowSource, /thinking-compact[\s\S]*?<TextShimmer/);
  assert.doesNotMatch(thinkingRowSource, /tool-row-name running/);
  assert.match(shimmerSource, /text-shimmer-base/);
  assert.match(shimmerSource, /text-shimmer-peak/);
  assert.match(shimmerSource, /data-active/);
  assert.match(stylesSource, /\.text-shimmer \{/);
  assert.match(stylesSource, /animation: text-shimmer-sweep 1\.2s linear infinite/);
  assert.match(stylesSource, /transition: opacity 220ms ease-out/);
  assert.match(stylesSource, /prefers-reduced-motion: reduce[\s\S]*?\.text-shimmer-peak/);
});
