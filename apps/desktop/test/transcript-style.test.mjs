import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const stylesSource = await loadStyles();
const transcriptSource = await readFile(
  new URL("../src/components/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const inspectorSource = await readFile(
  new URL("../src/components/ContextUsageInspector.tsx", import.meta.url),
  "utf8",
);
const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const minimapSource = await readFile(
  new URL("../src/components/ConversationMinimap.tsx", import.meta.url),
  "utf8",
);

test("user turns keep a compact right-aligned plate", () => {
  const userBubbleStyles = stylesSource.match(
    /\.message-row\.user \.message-bubble \{([^}]*)\}/,
  )?.[1];
  assert.ok(userBubbleStyles);
  assert.match(stylesSource, /\.message-row\.user \{\s*justify-content:\s*flex-end;/);
  assert.match(
    stylesSource,
    /\.message-row\.user \.message-col \{[\s\S]*?width:\s*min\(max-content,\s*82%,\s*600px\);[\s\S]*?max-width:\s*min\(82%,\s*600px\);[\s\S]*?align-items:\s*flex-end;/,
  );
  // The wrap constraint lives on the column; the bubble is max-content so a
  // percentage chip cap cannot stretch it to the 82%/600px ceiling.
  assert.match(
    userBubbleStyles,
    /width:\s*max-content;[\s\S]*?max-width:\s*100%;[\s\S]*?background:\s*color-mix\(in oklab,\s*var\(--ds-text-primary\) 8%,\s*transparent\);/,
  );
  assert.doesNotMatch(userBubbleStyles, /var\(--ds-accent\)/);
});

test("fork tools use the branch icon", () => {
  assert.match(transcriptSource, /case "fork":\s*return <IconBranch/);
});

test("tool rows render structured blocks instead of dumping JSON", async () => {
  const detailsSource = await readFile(
    new URL("../src/components/ToolDetails.tsx", import.meta.url),
    "utf8",
  );
  const permissionSource = await readFile(
    new URL("../src/components/PermissionCard.tsx", import.meta.url),
    "utf8",
  );
  // No JSON stringify path is left in either surface.
  assert.doesNotMatch(transcriptSource, /getToolSections|hasToolSections/);
  assert.doesNotMatch(permissionSource, /JSON\.stringify|formatToolValue/);
  assert.match(transcriptSource, /buildToolPresentation\(message, \{\n\s+hideSummaryArg: true,/);
  // Blocks stay behind the open guard so streaming ticks stay cheap.
  assert.match(transcriptSource, /open && hasDetails\s*\?\s*buildToolPresentation/);
  assert.match(transcriptSource, /<ToolChips chips=\{chips\} \/>/);
  assert.match(transcriptSource, /<ToolDetailBlocks blocks=\{blocks\} plain=\{runHead\} \/>/);
  assert.match(permissionSource, /<ToolDetailBlocks blocks=\{argBlocks\} \/>/);
  // Code bodies share the transcript highlighter rather than a second cache.
  assert.match(detailsSource, /<HighlightedCode code=\{block\.text\} lang=\{block\.lang\} \/>/);
  // Diffs reuse the review card rails; hits and paths open in the work panel.
  assert.match(detailsSource, /className="diff-hunk"/);
  assert.match(detailsSource, /openTarget\(\{ kind: "file", path: rel \}\)/);
});

test("tool block bodies stay bounded and role-coded", () => {
  for (const selector of [
    "\\.tool-row-chips",
    "\\.tool-chip",
    "\\.tool-block \\+ \\.tool-block",
    "\\.tool-diff",
    "\\.tool-fields",
    "\\.tool-block-more",
  ]) {
    assert.match(stylesSource, new RegExp(`${selector}\\s*\\{`), selector);
  }
  // Long payloads scroll inside the row instead of stretching the transcript.
  assert.match(stylesSource, /\.tool-row-content \{[\s\S]*?max-height:\s*260px;/);
  assert.match(
    stylesSource,
    /\.tool-file-list,\s*\.tool-match-list \{[\s\S]*?max-height:\s*260px;[\s\S]*?overflow:\s*auto;/,
  );
  // Stretched <button> paths stay start-aligned; Chromium must not justify
  // the path glyphs across the row (same contract as Grep path headings).
  const fileItem = stylesSource.match(/\.tool-file-item \{([^}]*)\}/)?.[1];
  assert.ok(fileItem);
  assert.match(fileItem, /display:\s*block;/);
  assert.match(fileItem, /width:\s*100%;/);
  // stderr and error notes carry the error hue, host notices stay neutral.
  assert.match(stylesSource, /\.tool-row-content\.is-error \{[\s\S]*?var\(--ds-error\)/);
  assert.match(stylesSource, /\.tool-chip\.is-error \{[\s\S]*?var\(--ds-error\)/);
  assert.match(stylesSource, /\.tool-note\.is-error \{[\s\S]*?var\(--ds-error\)/);
  const note = stylesSource.match(/\.tool-note \{([^}]*)\}/)?.[1];
  assert.ok(note);
  assert.doesNotMatch(note, /--ds-error/);
  // The permission card is a block container now, not a <pre>.
  const permissionArgs = stylesSource.match(/\.permission-card-args \{([^}]*)\}/)?.[1];
  assert.ok(permissionArgs);
  assert.doesNotMatch(permissionArgs, /white-space|font-family/);
});

test("assistant turns stay transparent full-width prose", () => {
  assert.match(
    stylesSource,
    /\.message-row\.assistant \.message-bubble[\s\S]*?background:\s*transparent;/,
  );
  assert.match(
    stylesSource,
    /\.message-row\.assistant[\s\S]*?\.message-col[\s\S]*?width:\s*min\(100%,\s*720px\);/,
  );
  // D323: the live parent turn stays transparent; no rail, no reserved
  // inset, no whole-turn tile. The tile belongs only to the delegation card.
  assert.doesNotMatch(
    stylesSource,
    /\.message-row\.assistant-turn \.message-col\s*\{[^}]*padding-left:\s*14px/,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.message-row\.assistant-turn \.message-col\s*\{[^}]*border-left/,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.message-row\.assistant-turn\.streaming \.message-col\s*\{[^}]*background:\s*var\(--ds-tile\)/,
  );
  assert.match(
    stylesSource,
    /\.tool-activity-group\.has-subagents\s*\{[^}]*background:\s*var\(--ds-tile\)/,
  );
});

test("transcript density and hover actions are quiet", () => {
  assert.match(stylesSource, /\.message-row \{[\s\S]*?padding:\s*12px 0;/);
  assert.match(
    stylesSource,
    /\.thread-content \{[\s\S]*?padding:\s*20px 32px calc\(var\(--composer-dock-height, 228px\) \+ 16px\);/,
  );
  assert.match(
    stylesSource,
    /\.message-actions \{[\s\S]*?opacity:\s*0;[\s\S]*?\.message-row:hover \.message-actions/,
  );
  assert.match(stylesSource, /\.message-row\.user \.message-actions \{[\s\S]*?justify-content:\s*flex-end;/);
});

test("transcript markup uses dedicated user text and assistant turn surfaces", () => {
  assert.match(transcriptSource, /className="message-user-text selectable"/);
  assert.match(transcriptSource, /streaming \? " streaming" : ""/);
  assert.match(transcriptSource, /CopyButton text=\{message\.content\}/);
  assert.match(transcriptSource, /className=\{`message-row assistant assistant-turn/);
  assert.match(transcriptSource, /CopyButton text=\{content\}/);
});

test("user plaintext preserves hard newlines without forced mid-word breaks", () => {
  assert.match(
    stylesSource,
    /\.message-user-text \{\s*\/\* Preserve hard newlines; wrap long tokens without splitting every CJK glyph\. \*\/\s*white-space:\s*pre-wrap;\s*overflow-wrap:\s*break-word;\s*word-break:\s*normal;/,
  );
  assert.doesNotMatch(stylesSource, /\.message-user-text br \{/);
  // Newlines come from `white-space: pre-wrap`; no manual <br> splitting.
  assert.doesNotMatch(transcriptSource, /user-line-/);
});

test("wrapped user links keep plaintext alignment", () => {
  const userLinkStyles = stylesSource.match(/\.chat-text-link \{([^}]*)\}/)?.[1];
  assert.ok(userLinkStyles);
  assert.match(userLinkStyles, /text-align:\s*start;/);
  assert.match(userLinkStyles, /overflow-wrap:\s*anywhere;/);
});

test("user-message file chips reuse the composer chip node", () => {
  assert.match(transcriptSource, /className=\"composer-chip chat-file-chip\"/);
  assert.match(transcriptSource, /composer-chip-name/);
  assert.match(stylesSource, /\.chat-file-chip[\s\S]*?appearance:\s*none/);
  // Definite cap inside the shrink-to-fit plate; `min(100%, 240px)` stretches it.
  assert.match(
    stylesSource,
    /\.message-row\.user \.composer-chip \{[\s\S]*?max-width:\s*240px;/,
  );
});

test("stopping a turn undoes an unanswered prompt or settles the partial reply", async () => {
  const storeSource = await readFile(
    new URL("../src/stores/app-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(storeSource, /const submittedDraft = submittedComposerDrafts\.get\(sessionId\)/);
  assert.match(storeSource, /resolveComposerSmartStop\(state\.messages, submittedDraft\)/);
  assert.match(storeSource, /composerPrefill:\s*\{ \.\.\.fullStop\.draft, sessionId \}/);
  assert.match(storeSource, /submittedDraft\?\.resolveAbort\?\.\(true\)/);
  assert.match(storeSource, /submittedDraft\?\.resolveAbort\?\.\(false\)/);
  assert.match(storeSource, /submittedComposerDrafts\.delete\(sessionId\)/);
  assert.match(storeSource, /smartStop\.kind === "restore"/);
  assert.match(storeSource, /status:\s*"aborted" as const/);
  // The undo rewrite starts from the full durable transcript merged with the
  // live rows, never from the renderer's paged, display-capped window (D299).
  assert.match(
    storeSource,
    /const merged = mergeLiveSessionMessages\(fullMessages, get\(\)\.messages\)/,
  );
  assert.match(storeSource, /resolveComposerSmartStop\(merged, submittedDraft\)/);
  assert.match(
    storeSource,
    /replaceSessionMessages\(sessionId,\s*fullStop\.kept\)/,
  );
  // Settling a partial reply is renderer-only: the runtime's aborted final row
  // (or its checkpoint) is the durable copy, and a rewrite from this snapshot
  // could delete it.
  assert.doesNotMatch(storeSource, /replaceSessionMessages\(sessionId,\s*settled\)/);
  assert.doesNotMatch(storeSource, /replaceSessionMessages\(sessionId,\s*smartStop\.kept\)/);
});

test("delete remains on user turns and is removed from assistant toolbar", async () => {
  const storeSource = await readFile(
    new URL("../src/stores/app-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(storeSource, /deleteMessage:\s*async \(messageId\)/);
  assert.match(storeSource, /replaceSessionMessages\(sessionId,\s*next\)/);
  assert.match(transcriptSource, /deleteMessage\(message\.id\)/);
  assert.match(transcriptSource, /chat\.deleteMessage/);
  assert.match(transcriptSource, /\{isUser \? \(/);
  assert.match(stylesSource, /\.copy-btn\.danger:hover/);
});

test("editing a user prompt regenerates it and keeps the old branch reachable", async () => {
  const storeSource = await readFile(
    new URL("../src/stores/app-store.ts", import.meta.url),
    "utf8",
  );
  // Edit lives on the user turn (the prompt is what gets rewritten), not on
  // the assistant answer.
  assert.match(transcriptSource, /editUserMessage\(message\.id, next, message\.attachments\)/);
  assert.match(transcriptSource, /className="message-edit-input selectable"/);
  assert.match(transcriptSource, /chat\.editMessage/);
  assert.match(transcriptSource, /const retryEdit = async \(\)/);
  assert.match(transcriptSource, /void retryEdit\(\)/);
  assert.match(transcriptSource, /chat\.retryEdit/);
  assert.match(transcriptSource, /chat\.retryingEdit/);
  assert.doesNotMatch(transcriptSource, /next === editSeed\.trim\(\)/);
  assert.doesNotMatch(transcriptSource, /editAssistantMessage/);
  assert.doesNotMatch(storeSource, /editAssistantMessage/);
  // Slash prompts edit their typed form so the resend re-expands the template.
  assert.match(transcriptSource, /const editSeed = \(isUser && message\.command\) \|\| message\.content/);
  // Same branch mechanics as regenerate, so main archives the replaced turn
  // as a revision the pager can walk back to.
  assert.match(storeSource, /editUserMessage:\s*async \(messageId, content, attachments\)/);
  // The cut is named by message identity: a window offset plus an index into
  // the deduplicated renderer array are different coordinate spaces.
  assert.match(storeSource, /truncateFromMessageId,/);
  assert.match(
    storeSource,
    /const truncateFromMessageId = state\.messages\[userIndex\]\.id/,
  );
  assert.doesNotMatch(storeSource, /truncateBefore:\s*transcriptOffset/);
  assert.match(
    storeSource,
    /editUserMessage\(root\.id, root\.content, root\.attachments\)/,
  );
  assert.match(stylesSource, /\.message-edit-input/);
  assert.match(
    stylesSource,
    /\.message-row\.user \.message-col:has\(\.message-edit\)/,
  );
});

test("message toolbars are icon-only with hover tooltips", () => {
  // No worded chips in the toolbar: labels ride on tooltip + aria-label.
  assert.doesNotMatch(
    transcriptSource,
    /<span>\{(?:forkLabel|retryLabel|editLabel|copyLabel)\}<\/span>/,
  );
  for (const label of ["editLabel", "deleteLabel"]) {
    assert.ok(
      transcriptSource.includes(`ariaLabel={${label}}`),
      `${label} needs an aria-label`,
    );
    assert.ok(
      transcriptSource.includes(`tooltip={${label}}`),
      `${label} needs a hover tooltip`,
    );
  }
  for (const key of ["chat.forkResponse", "chat.retry"]) {
    assert.match(transcriptSource, new RegExp(`ariaLabel=\\{t\\("${key}"\\)\\}`));
    assert.match(transcriptSource, new RegExp(`tooltip=\\{t\\("${key}"\\)\\}`));
  }
  assert.ok(transcriptSource.includes("label={copyLabel}"));
  assert.match(transcriptSource, /className="copy-btn icon"/);
  assert.match(transcriptSource, /tooltip=\{t\("chat\.forkResponse"\)\}/);
  assert.match(transcriptSource, /import \{ TooltipButton \} from "\.\/ui"/);
  assert.match(transcriptSource, /<TooltipButton/);
  assert.match(stylesSource, /\.ui-tooltip\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(stylesSource, /\.ui-tooltip\s*\{[\s\S]*?z-index:\s*1000;/);
  assert.match(stylesSource, /\.ui-tooltip\s*\{[\s\S]*?transform:\s*translate\(-50%,\s*-100%\)/);
  // Worded surfaces (error details) keep their label.
  assert.match(transcriptSource, /withLabel/);
});

test("streaming assistant turns hide answer copy until idle", () => {
  assert.ok(transcriptSource.includes("{complete ? ("));
  assert.ok(
    transcriptSource.includes(
      '<CopyButton text={content} label={t("chat.copy")} />',
    ),
  );
});

test("assistant context inspector keeps a compact summary and retry action wired", () => {
  assert.match(transcriptSource, /function MessageMeta/);
  assert.match(transcriptSource, /message-meta-chip/);
  assert.doesNotMatch(transcriptSource, /ContextUsageInspector/);
  assert.match(transcriptSource, /showThroughput/);
  assert.match(composerSource, /latest-turn-context/);
  assert.match(composerSource, /latestTurnContextInspector/);
  assert.match(composerSource, /sessionCompactions/);
  assert.match(inspectorSource, /export function ContextUsageInspector/);
  assert.match(inspectorSource, /className="context-inspector"/);
  assert.match(inspectorSource, /chat\.usageTools/);
  assert.match(inspectorSource, /aggregateToolTokenUsage/);
  assert.match(inspectorSource, /context-inspector-summary/);
  assert.match(inspectorSource, /context-inspector-summary-row/);
  assert.match(inspectorSource, /chat\.usageToolsSummary/);
  assert.match(inspectorSource, /context-inspector-kpis/);
  assert.match(inspectorSource, /context-inspector-window-percent/);
  assert.match(inspectorSource, /chat\.usageContextLeft/);
  assert.match(inspectorSource, /chat\.usageThroughput/);
  assert.match(inspectorSource, /calculateCacheRate/);
  assert.match(inspectorSource, /chat\.usageCacheRate/);
  assert.match(inspectorSource, /contextOccupancyTokens\(usage\)/);
  assert.match(inspectorSource, /usage\.cacheReadTokens/);
  assert.doesNotMatch(inspectorSource, /turnUsage\.cacheReadTokens/);
  assert.match(inspectorSource, /createPortal\(popover, document\.body\)/);
  assert.match(inspectorSource, /getBoundingClientRect\(\)/);
  assert.match(inspectorSource, /addEventListener\("scroll", handleViewportChange, true\)/);
  assert.match(inspectorSource, /ResizeObserver\(updatePopoverPosition\)/);
  assert.match(inspectorSource, /aria-controls=\{open \? panelId : undefined\}/);
  assert.match(transcriptSource, /retryAssistantMessage/);
  assert.match(transcriptSource, /chat\.retry/);
  assert.match(stylesSource, /\.context-inspector-ring-progress/);
  assert.match(stylesSource, /\.context-inspector-ring-value/);
  assert.match(stylesSource, /\.context-inspector-summary/);
  assert.match(stylesSource, /\.context-inspector-summary-values/);
  assert.doesNotMatch(
    stylesSource,
    /\.context-inspector-(window|kpis|summary|compaction)[^{]*\{[^}]*border-top:/,
  );
  assert.doesNotMatch(inspectorSource, /context-inspector-source-badge/);
  assert.doesNotMatch(inspectorSource, /context-inspector-tool-meta/);
  assert.doesNotMatch(stylesSource, /\.context-inspector-meter\s*\{/);
  assert.doesNotMatch(stylesSource, /\.context-inspector-source-badge/);
  assert.doesNotMatch(stylesSource, /\.context-inspector-tool-/);
  assert.match(
    stylesSource,
    /\.context-inspector-popover\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*60;/,
  );
  assert.match(stylesSource, /\.context-inspector-popover\.is-open/);
});

test("context inspector keeps generation speed completion-only", () => {
  assert.doesNotMatch(inspectorSource, /useLiveElapsedMs|usageThroughputLive/);
  assert.doesNotMatch(transcriptSource, /useLiveElapsedMs|usageThroughputLive/);
  assert.doesNotMatch(transcriptSource, /assistantTurnStreamingMessage/);
  assert.doesNotMatch(stylesSource, /message-meta-live-rate|live-rate-pulse/);
});

test("context inspector panel opens on click, not hover (D225)", () => {
  // The trigger toggles; pointer enter/leave and focus/blur no longer open or
  // close the panel, so no hover-grace timer is needed.
  assert.match(inspectorSource, /onClick=\{toggleInspector\}/);
  assert.match(inspectorSource, /aria-haspopup="dialog"/);
  assert.match(inspectorSource, /role="dialog"/);
  assert.doesNotMatch(inspectorSource, /onPointerEnter=\{(openInspector|cancelClose)\}/);
  assert.doesNotMatch(inspectorSource, /onPointerLeave=\{scheduleClose\}/);
  assert.doesNotMatch(inspectorSource, /onFocus=\{openInspector\}/);
  assert.doesNotMatch(inspectorSource, /closeTimerRef/);
  // Explicit dismissal: outside pointerdown and Escape, which refocuses.
  assert.match(
    inspectorSource,
    /addEventListener\("pointerdown", handlePointerDown, true\)/,
  );
  assert.match(inspectorSource, /event\.key !== "Escape"/);
  assert.match(inspectorSource, /triggerRef\.current\?\.focus\(\)/);
});

test("regenerate rewrites the current turn instead of appending", async () => {
  const storeSource = await readFile(
    new URL("../src/stores/app-store.ts", import.meta.url),
    "utf8",
  );
  const mainSource = await readFile(
    new URL("../electron/main/index.ts", import.meta.url),
    "utf8",
  );
  const protocolSource = await readFile(
    new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
    "utf8",
  );
  // The cut is named by message identity: a window offset plus an index into
  // the deduplicated renderer array are different coordinate spaces.
  assert.match(storeSource, /truncateFromMessageId,/);
  assert.match(
    storeSource,
    /const truncateFromMessageId = state\.messages\[userIndex\]\.id/,
  );
  assert.doesNotMatch(storeSource, /truncateBefore:\s*transcriptOffset/);
  assert.match(storeSource, /messages:\s*kept/);
  assert.match(mainSource, /session\.replaceMessages/);
  assert.match(mainSource, /agent\.disposeSession/);
  assert.match(mainSource, /truncateFromMessageId/);
  // The host resolves the boundary against its own transcript, and an
  // unresolvable identity is rejected instead of truncating at a guessed position.
  assert.match(
    mainSource,
    /"session\.truncateFrom",\s*\{\s*sessionId:\s*req\.sessionId/,
  );
  assert.doesNotMatch(
    mainSource,
    /resolveTranscriptTruncation|truncation\.kind === "unknown-message"/,
  );
  assert.match(protocolSource, /sessionReplaceMessages/);
});

test("conversation minimap hides until content overflows one viewport", () => {
  assert.match(minimapSource, /OVERFLOW_EPSILON_PX/);
  assert.match(
    minimapSource,
    /scrollHeight - el\.clientHeight > OVERFLOW_EPSILON_PX/,
  );
  // D269: overflow still gates a fully loaded transcript, but withheld earlier
  // history keeps the outline (and its continuation control) reachable.
  assert.match(
    minimapSource,
    /!shouldRenderConversationMinimap\(\{[\s\S]*?markerCount: markers\.length,[\s\S]*?overflows,[\s\S]*?hasEarlier,[\s\S]*?\}\)/,
  );
  assert.match(
    minimapSource,
    /window\.addEventListener\("resize", scheduleResize\)/,
  );
  assert.match(minimapSource, /new ResizeObserver\(scheduleResize\)/);
  assert.match(minimapSource, /updateOverflow/);
});

test("thread scroll reserves stable gutters before overflow appears", () => {
  assert.match(
    stylesSource,
    /\.thread-scroll\s*\{[\s\S]*?overflow:\s*auto;[\s\S]*?scrollbar-gutter:\s*stable;/,
  );
});

test("conversation minimap stays centered below titlebar at high density", () => {
  assert.match(
    minimapSource,
    /"--minimap-marker-count": markers\.length/,
  );
  assert.match(
    stylesSource,
    /\.minimap-rail \{[\s\S]*?top:\s*var\(--ds-toolbar-height\);[\s\S]*?bottom:\s*calc\(var\(--composer-dock-height, 200px\) \+ 16px\);[\s\S]*?justify-content:\s*center;/,
  );
  assert.match(
    stylesSource,
    /\.minimap-rail \{[\s\S]*?gap:\s*clamp\([\s\S]*?var\(--minimap-marker-count\)[\s\S]*?-webkit-app-region:\s*no-drag;/,
  );
  assert.match(
    stylesSource,
    /\.minimap-marker \{[\s\S]*?min-height:\s*0;/,
  );
  assert.match(
    stylesSource,
    /\.minimap-marker::before \{[\s\S]*?height:\s*min\(2px,\s*100%\);/,
  );
});

test("regenerate history pager and stable revision family are wired", async () => {
  const storeSource = await readFile(
    new URL("../src/stores/app-store.ts", import.meta.url),
    "utf8",
  );
  const mainSource = await readFile(
    new URL("../electron/main/index.ts", import.meta.url),
    "utf8",
  );
  const sharedSource = await readFile(
    new URL("../../../packages/shared/src/types.ts", import.meta.url),
    "utf8",
  );
  assert.match(transcriptSource, /message-revision-pager/);
  assert.match(transcriptSource, /activateMessageRevision/);
  assert.match(transcriptSource, /chat\.revisionPager/);
  assert.match(
    transcriptSource,
    /const showRevisionPager = isUser && revisionCount > 1;/,
  );
  assert.match(
    transcriptSource,
    /activateMessageRevision\(message\.id, Math\.max\(1, activeRevision - 1\)\)/,
  );
  assert.doesNotMatch(transcriptSource, /showRevisionPagerHere|revisionOwner/);
  assert.match(stylesSource, /\.message-revision-pager/);
  assert.doesNotMatch(
    stylesSource,
    /\.message-actions:has\(\.message-revision-pager\)[\s\S]*?opacity:\s*1/,
  );
  assert.match(storeSource, /revisionRootId \|\| root\.id/);
  assert.match(storeSource, /activateSessionRevision/);
  assert.match(mainSource, /session\.saveRevision/);
  assert.match(mainSource, /revisionRootId/);
  assert.match(mainSource, /revisionCount: revision\.revisionCount/);
  assert.match(
    mainSource,
    /truncate regenerate transcript failed[\s\S]*?throw error;/,
  );
  assert.match(sharedSource, /revisionRootId\?: string/);
  assert.match(sharedSource, /MessageRevisionSummary/);
});
