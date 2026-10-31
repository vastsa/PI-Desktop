import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import { readTranscriptModule } from "./helpers/transcript-source.mjs";

const stylesSource = await loadStyles();
const turnProcessSource = await readTranscriptModule("TurnProcess.tsx");

test("the top-level disclosure is a hairline row with an inline caret", () => {
  const header = stylesSource.match(
    /\.turn-process > \.tool-activity-header \{([^}]*)\}/,
  )?.[1];
  assert.ok(header);
  assert.match(header, /border-bottom:\s*1px solid var\(--ds-border-subtle\);/);
  assert.match(header, /margin:\s*0;/);
  assert.doesNotMatch(header, /background/);

  const hover = stylesSource.match(
    /\.turn-process > \.tool-activity-header:hover \{([^}]*)\}/,
  )?.[1];
  assert.ok(hover);
  assert.match(hover, /background:\s*transparent;/);
  assert.doesNotMatch(hover, /--ds-bg-hover/);

  const caret = stylesSource.match(
    /\.turn-process > \.tool-activity-header > \.tool-activity-caret \{([^}]*)\}/,
  )?.[1];
  assert.ok(caret);
  assert.match(caret, /margin-inline-start:\s*0;/);
});

test("nested disclosure headers keep their hover fill", () => {
  // Only the top-level turn fold is a hairline row. Activity-group and subagent
  // headers keep the released chip hover, so this change cannot flatten the
  // hierarchy below it.
  assert.match(
    stylesSource,
    /\.tool-activity-header:hover \{[\s\S]*?background:\s*var\(--ds-bg-hover\);/,
  );
});

test("the header carries status, duration and tool count but no issue count", () => {
  assert.match(turnProcessSource, /className=\{`tool-activity-label/);
  assert.match(turnProcessSource, /className="turn-sep"/);
  assert.match(turnProcessSource, /className="turn-duration"/);
  assert.match(turnProcessSource, /className="tool-activity-count"/);
  assert.match(turnProcessSource, /className="tool-activity-caret"/);
  assert.doesNotMatch(turnProcessSource, /turn-process-error|activityFailures/);
  assert.doesNotMatch(
    turnProcessSource,
    /processCompletedFor|processFailedFor|processStoppedFor/,
  );
  assert.doesNotMatch(stylesSource, /\.turn-process-error/);
});
