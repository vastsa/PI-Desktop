import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTranscriptSource } from "./helpers/source-contracts.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, followScroll, anchorControl, scrollInput] = await Promise.all([
  readTranscriptSource(),
  read("../src/hooks/use-follow-scroll.ts"),
  read("../src/hooks/use-disclosure-anchor.ts"),
  read("../src/lib/scroll-input.ts"),
]);

test("a manual disclosure hands over its title before the state changes", () => {
  // The scroller has to measure the title while the layout still matches what
  // the reader clicked, so the notification comes before `setOpen` (#324).
  assert.match(
    transcript,
    /const notifyAnchor = useDisclosureAnchorNotifier\(\);\s*const titleRef = useRef<HTMLButtonElement \| null>\(null\);/,
  );
  assert.match(
    transcript,
    /const toggle = useCallback\(\(\) => \{\s*claim\(\);\s*notifyAnchor\?\.\(titleRef\.current\);\s*setOpen\(\(value\) => !value\);/,
  );
  assert.match(
    transcript,
    /const collapse = useCallback\(\(\) => \{\s*claim\(\);\s*notifyAnchor\?\.\(titleRef\.current\);\s*setOpen\(false\);/,
  );
  assert.match(transcript, /return \{ open, toggle, collapse, claim, titleRef \};/);
});

test("the automatic open/close never claims a reading position", () => {
  // Only a user click holds the viewport. The running/settled transition keeps
  // going through `setOpen` directly, so the automatic rules are unchanged.
  const automatic = transcript.match(
    /useLayoutEffect\(\(\) => \{\s*if \(userInteractedRef\.current\) return;([\s\S]*?)\n  \}, \[automaticOpen\]\);/,
  )?.[1];
  assert.ok(automatic, "the automatic disclosure effect is missing");
  assert.doesNotMatch(automatic, /notifyAnchor/);
  assert.match(automatic, /setOpen\(automaticOpen\);/);
});

test("every manual title hands over the element the reader clicked", () => {
  // The collapse rail lives inside the collapsing body, so both paths anchor on
  // the header the reader sees, not on the control that was pressed.
  assert.match(
    transcript,
    /ref=\{titleRef\}\s*className="tool-activity-header"/,
  );
  assert.match(transcript, /onClick=\{toggleDisclosure\}/);
  const toolHeaders = transcript.match(
    /ref=\{titleRef\}\s*className="tool-row-header"/g,
  );
  assert.equal(
    toolHeaders?.length,
    2,
    "the thinking row and the tool row must both anchor their own header",
  );
  assert.match(transcript, /onCollapse=\{collapseDisclosure\}/);
  const collapseWrappers = transcript.match(
    /onUserInteraction\?\.\(\);\s*collapseDisclosure\(\);\s*\}, \[collapseDisclosure, onUserInteraction\]\);/g,
  );
  assert.equal(
    collapseWrappers?.length,
    2,
    "the thinking row and the tool row must both anchor when their rail collapses them",
  );
});

test("the transcript scroller provides its own anchor notifier", () => {
  assert.match(
    transcript,
    /\n    disclosureAnchorNotifier,\n  \} = useTranscriptScroll\(\{/,
  );
  assert.match(
    transcript,
    /<DisclosureAnchorContext\.Provider value=\{disclosureAnchorNotifier\}>/,
  );
  assert.match(transcript, /data-scroll-owner="transcript"/);
});

test("the transcript restores the held title inside its resize observer", () => {
  // The height of an animated activity group keeps changing for several frames,
  // so the correction has to run from the observer, before follow.
  assert.match(
    transcript,
    /const followScrollNow = useCallback\(\(\) => \{\s*if \(paneVisibleRef\.current && restoreDisclosureAnchor\(\)\) return;\s*if \(!paneVisibleRef\.current \|\| !pinnedRef\.current\) return;\s*cancelFollowScroll\(\);\s*scrollToBottom\(\);/,
  );
  assert.match(transcript, /new ResizeObserver\(followScrollNow\)/);
  assert.match(transcript, /ro\.observe\(content, \{ box: "border-box" \}\)/);
});

test("holding a disclosure leaves follow without a delayed grab-back", () => {
  assert.match(
    transcript,
    /const enterDisclosureReading = useCallback\(\(\) => \{\s*cancelFollowScroll\(\);\s*pinnedRef\.current = false;\s*setShowJump\(true\);/,
  );
  assert.match(
    transcript,
    /const recordScrollPosition = useCallback\(\(top: number\) => \{\s*lastScrollTopRef\.current = top;/,
  );
  // No timer, no animation frame: the hold ends on real input or on an explicit
  // re-pin, never by taking the bottom back later.
  assert.doesNotMatch(anchorControl, /requestAnimationFrame|setTimeout/);
});

test("real input, a new turn and every navigation drop the held position", () => {
  assert.match(
    transcript,
    /lastScrollGestureAtRef\.current = performance\.now\(\);\s*\/\/ Real input takes the viewport back from a held disclosure position\.\s*releaseDisclosureAnchor\(\);/,
  );
  assert.match(
    transcript,
    /releaseDisclosureAnchor\(\);\s*cancelFollowScroll\(\);\s*pinnedRef\.current = true;\s*setShowJump\(false\);\s*scrollToBottom\(\);/,
  );
  assert.match(
    transcript,
    /const jumpToLatest = useCallback\(\(\) => \{\s*releaseDisclosureAnchor\(\);\s*pinnedRef\.current = true;/,
  );
  assert.match(
    transcript,
    /if \(becameHidden\) \{\s*releaseDisclosureAnchor\(\);/,
  );
});

test("follow records the position the scroller actually reached", () => {
  // The intended target minus a fractional device pixel ratio was enough to
  // make the next scroll event look like the reader scrolling up.
  assert.match(
    transcript,
    /if \(behavior === "auto"\) lastScrollTopRef\.current = el\.scrollTop;/,
  );
  assert.equal(
    transcript.match(
      /if \(behavior === "auto"\) lastScrollTopRef\.current = el\.scrollTop;/g,
    )?.length,
    1,
  );
  assert.match(
    transcript,
    /tolerancePx: gesturing \? 0 : TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,/,
  );
  assert.doesNotMatch(transcript, /lastScrollTopRef\.current = targetTop/);
});

test("scroll input is attributed to the scroller that can consume it", () => {
  assert.match(
    transcript,
    /const input = readScrollInputContext\(\s*event,\s*scrollRef\.current,\s*contentRef\.current,\s*\);/,
  );
  assert.match(
    transcript,
    /if \(!isScrollGestureInput\(event\.type as ScrollInputType, input\)\) return;/,
  );
  // A press on a control, a keystroke in a field and a nested scroller's input
  // are read from the DOM, not guessed from the event type.
  assert.match(scrollInput, /target\.closest\(`\[\$\{SCROLL_OWNER_ATTRIBUTE\}\]`\)/);
  // Ownership is about the vertical axis only: an element with horizontal
  // overflow alone lets the gesture chain to the scroller behind it, and
  // treating it as consumed would leave the outer viewport un-followed and
  // then re-bottomed.
  assert.match(scrollInput, /consumesVerticalScroll\(nearestOwner\)/);
  assert.doesNotMatch(scrollInput, /scrollWidth/);
  assert.match(scrollInput, /target\.closest\(CONTROL_SELECTOR\)/);
  assert.match(
    scrollInput,
    /context\.pointerOnScrollSurface =\s*inside &&\s*!\(target instanceof Element && target\.closest\(CONTROL_SELECTOR\) !== null\);/,
  );
});

test("a nested owner holds its own position and passes the hold outward", () => {
  assert.match(
    followScroll,
    /const followScrollNow = useCallback\(\(\) => \{\s*if \(restoreDisclosureAnchor\(\)\) return;\s*if \(!pinnedRef\.current\) return;\s*cancelFollowScroll\(\);\s*scrollToBottom\(\);/,
  );
  assert.match(followScroll, /disclosureAnchorNotifier,/);
  assert.match(
    transcript,
    /<DisclosureAnchorContext\.Provider value=\{disclosureAnchorNotifier\}>[\s\S]{0,400}?data-scroll-owner="follow"/,
  );
  // Growing the dock grows the transcript's content too, so an outer scroller
  // still in follow mode would drag the same title away.
  assert.match(anchorControl, /outerNotifier\?\.\(title\);/);
});
