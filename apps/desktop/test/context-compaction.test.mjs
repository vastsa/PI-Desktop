import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  protocol,
  types,
  main,
  api,
  store,
  runtime,
  commands,
  hostRpc,
  hostPermissions,
  hostSessions,
  hostTranscripts,
  transcript,
  turns,
  styles,
  enLocale,
] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/shared/src/types.ts"),
  read("../electron/main/index.ts"),
  read("../src/lib/api.ts"),
  read("../src/stores/app-store.ts"),
  read("../../../packages/agent-runtime/src/runtime.ts"),
  read("../electron/main/builtin-commands.ts"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
  read("../../../crates/host-core/src/permissions.rs"),
  read("../../../crates/host-core/src/sessions.rs"),
  read("../../../crates/host-core/src/transcripts.rs"),
  read("../src/components/ChatTranscript.tsx"),
  read("../src/lib/assistant-turns.ts"),
  loadStyles(),
  read("../../../packages/i18n/src/locales/en/index.ts"),
]);

test("context compaction is wired through protocol v9 and the manual IPC path", () => {
  assert.match(protocol, /PROTOCOL_VERSION = 9/);
  assert.match(protocol, /agentCompact:\s*"pi-desktop\/agent\/compact"/);
  assert.match(types, /type ContextCompactionRecord/);
  assert.match(types, /type: "compaction_start"/);
  assert.match(types, /type: "compaction_end"/);
  assert.match(types, /fallback\?: ContextCompactionFallback/);
  assert.match(main, /handle\(IPC\.invoke\.agentCompact/);
  assert.match(
    main,
    /handle\(IPC\.invoke\.agentCompact[\s\S]*activeTurns\.has\(req\.sessionId\)/,
  );
  assert.match(main, /sidecar\.call\("agent\.compact"/);
  assert.match(api, /compact:\s*\(req: AgentCompactRequest\)/);
  assert.match(commands, /slash:\s*"compact"/);
  assert.match(hostRpc, /"session\.appendCompaction"/);
});

test("turn_end remains a per-tool-turn boundary rather than a terminal run state", () => {
  assert.match(
    store,
    /event\.type === "agent_end" \|\|\s*event\.type === "error"/,
  );
  assert.doesNotMatch(
    store,
    /event\.type === "agent_end" \|\|\s*event\.type === "turn_end"/,
  );
  assert.match(store, /case "agent_end":[\s\S]*?set\(\{ isRunning: false \}\)/);
  assert.match(store, /case "turn_end":\s*break/);
});

test("the hard boundary is enforced by the host, with a model-side escape hatch", () => {
  assert.match(runtime, /prepareNextTurnWithContext/);
  assert.match(runtime, /budget\.tokens >= budget\.hardLimit/);
  assert.match(runtime, /CONTEXT_COMPACTION_FAILED: unable to create a checkpoint/);
  assert.match(runtime, /checkpoint truncated: this message crossed the retained context budget/);
  assert.match(runtime, /pendingOverflow/);
  assert.match(runtime, /runCompaction\(\s*"overflow",\s*true,\s*"active_turn",?\s*\)/);
  assert.match(runtime, /fallback: "retained_tail"/);
  // Codex's tool, verbatim and parameterless, plus its two-tier reminder.
  assert.match(runtime, /CONTEXT_COMPACTION_TOOL_NAME = "new_context"/);
  assert.match(
    runtime,
    /"Start a new context window\. Does not clear, reset, or otherwise affect environment state\."/,
  );
  assert.match(runtime, /pendingModelCompaction = true/);
  assert.match(runtime, /function contextBudgetReminder\(/);
  assert.match(runtime, /function contextFallbackReminder\(/);
  assert.match(runtime, /contextReminderClaimed/);
  assert.match(runtime, /contextFallbackReminderClaimed/);
  // The reminder is a per-turn append, so it never reaches the transcript.
  assert.match(
    runtime,
    /systemPrompt: `\$\{context\.systemPrompt\}\\n\\n\$\{reminder\}`/,
  );
  assert.match(hostPermissions, /"new_context"/);
});

test("every checkpoint is durable, not just the newest one", () => {
  // One transcript row per compaction needs the whole chain to survive a
  // restart, a rewrite, and a fork.
  assert.match(types, /compactions\?: ContextCompactionRecord\[\]/);
  assert.match(hostTranscripts, /pub fn read_compactions\(/);
  assert.match(hostTranscripts, /pub fn write_transcript_with_compactions\(/);
  assert.doesNotMatch(hostTranscripts, /pub fn read_latest_compaction\(/);
  assert.match(hostSessions, /pub compactions: Vec<CompactionRecord>/);
  assert.match(hostSessions, /compaction: compactions\.last\(\)\.cloned\(\)/);
  assert.match(
    hostSessions,
    /\.filter\(\|record\| compaction_valid_for_records\(record, &records\)\)/,
  );
  assert.match(
    hostSessions,
    /\.filter_map\(\|record\| clone_compaction_for_fork\(record, &message_ids, &tool_call_ids\)\)/,
  );
});

test("a checkpoint carries only the active user message past the boundary", () => {
  // The summary covers the whole boundary range. An in-progress turn carries
  // only its latest user message, while a completed turn carries no naked
  // historical user messages into the next task.
  assert.match(runtime, /COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000/);
  assert.match(runtime, /type CompactionRetentionMode = "active_turn" \| "completed_turn"/);
  assert.match(runtime, /retainedTailMode: retentionMode/);
  assert.match(runtime, /private codexShapedPreparation\(/);
  assert.match(
    runtime,
    /const messagesToSummarize = \[\s*\.\.\.preparation\.messagesToSummarize,\s*\.\.\.preparation\.turnPrefixMessages,\s*\.\.\.preparation\.retainedTail,\s*\]/,
  );
  assert.match(runtime, /turnPrefixMessages: \[\],\s*isSplitTurn: false/);
  assert.match(runtime, /const latestUser = messagesToSummarize[\s\S]*?\.at\(-1\)/);
  assert.match(
    runtime,
    /retentionMode === "active_turn" && latestUser \? \[latestUser\] : \[\]/,
  );
  // Newest-first selection with the boundary message truncated, not dropped.
  assert.match(runtime, /function selectRetainedUserMessages\(/);
  assert.match(runtime, /truncateUserMessageForCheckpoint\(message, remaining\)/);
  assert.match(runtime, /return selected\.reverse\(\)/);
  // Full tool-result batches are no longer retained, so nothing bounds them.
  assert.doesNotMatch(runtime, /fairToolResultTokenBudgets/);
  assert.doesNotMatch(runtime, /CHECKPOINT_TAIL_SAFETY_TOKENS/);
});

test("the no-summary rollover family stays an internal switch", () => {
  // Codex's second path: a fresh context window with no summary request. It is
  // selectable for development only, so it reaches neither settings nor i18n.
  assert.match(runtime, /type CompactionStrategy = "summary" \| "fresh_window"/);
  assert.match(runtime, /PI_DESKTOP_COMPACTION_STRATEGY === "fresh_window"/);
  assert.match(runtime, /private buildRolloverCheckpoint\(/);
  assert.match(runtime, /CONTEXT_ROLLOVER_SUMMARY/);
  assert.match(runtime, /strategy: "fresh_window" satisfies CompactionStrategy/);
  assert.match(runtime, /strategy: "summary" satisfies CompactionStrategy/);
  assert.doesNotMatch(types, /compactionStrategy/);
  assert.doesNotMatch(enLocale, /compactionStrategy/);
});

test("compaction runs inline at the hard boundary, never ahead of it", () => {
  // Codex has no off-critical-path compaction: the summary is paid for at the
  // turn boundary the user is already waiting on.
  assert.doesNotMatch(runtime, /maybeStartBackgroundCompaction/);
  assert.doesNotMatch(runtime, /pendingBackgroundCheckpoint/);
  assert.doesNotMatch(runtime, /BACKGROUND_COMPACTION_LIMIT_RATIO/);
  assert.doesNotMatch(runtime, /phase: "background"/);
  assert.match(
    runtime,
    /const budget = this\.contextBudget\(context\.messages\);\s*const hardLimitReached = budget\.tokens >= budget\.hardLimit;/,
  );
  // Generation stays separate from installation so a failed build can still
  // fall through to the retained-tail recovery path.
  assert.match(
    runtime,
    /private async buildCheckpoint\(\s*signal: AbortSignal,\s*retentionMode: CompactionRetentionMode,?\s*\)/,
  );
  assert.match(runtime, /private async installCheckpoint\(/);
});

test("compaction lifecycle keeps the renderer busy until its actual terminal event", () => {
  assert.doesNotMatch(types, /ContextCompactionPhase/);
  assert.match(
    store,
    /event\.type === "compaction_start"\s*\)/,
  );
  assert.match(
    store,
    /event\.type === "compaction_end" && event\.reason === "manual"/,
  );
  assert.match(
    store,
    /case "compaction_start":\s*set\(\{ isRunning: true \}\)/,
  );
  assert.match(
    store,
    /case "compaction_end":[\s\S]*event\.reason === "manual"\) set\(\{ isRunning: false \}\)/,
  );
  assert.match(store, /contextCompaction\.recovered/);
});

test("every compaction announces itself once, on top of the specific toasts", () => {
  const compactionEnd =
    store.match(/case "compaction_end":[\s\S]*?\n      case "agent_end":/)?.[0] ??
    "";
  assert.ok(compactionEnd.length > 0, "compaction_end handler not found");
  // Codex warns after every compaction; ours is unconditional and lands before
  // the three that describe something more specific.
  assert.match(
    compactionEnd,
    /if \(event\.ok\) \{[\s\S]*?get\(\)\.showToast\(i18n\.t\("contextCompaction\.longThreadWarning"\), \{\s*variant: "warning",\s*\}\);/,
  );
  assert.match(
    compactionEnd,
    /if \(event\.fallback\) \{\s*get\(\)\.showToast\(i18n\.t\("contextCompaction\.recovered"\)/,
  );
  assert.match(
    compactionEnd,
    /else if \(event\.reason === "overflow"\) \{\s*get\(\)\.showToast\(\s*i18n\.t\("contextCompaction\.retrying"\)/,
  );
  assert.match(
    compactionEnd,
    /else if \(event\.reason === "manual"\) \{\s*get\(\)\.showToast\(i18n\.t\("contextCompaction\.completed"\)/,
  );
  assert.equal(
    compactionEnd.match(/showToast/g)?.length,
    5,
    "unexpected number of compaction toasts",
  );
  assert.match(enLocale, /longThreadWarning:/);
});

test("the transcript shows one row per compaction, the inspector the newest", () => {
  assert.match(types, /type ContextCompactionMark = ContextCompactionStatus & \{/);
  assert.match(types, /mark\?: ContextCompactionMark/);
  // The generation counter and the family both ride inside the opaque details
  // value, so the host persists them without a record schema change.
  assert.match(runtime, /checkpointDetailsWithGeneration/);
  assert.match(runtime, /mark: contextCompactionMark\(checkpoint\)/);
  // Both the durable records and the live event feed the same per-session list.
  assert.match(store, /sessionCompactions: Record<string, ContextCompactionMark\[\]>/);
  assert.match(store, /rememberSessionCompactions\(id, detail\.session\)/);
  assert.match(store, /event\.type === "compaction_end" && event\.ok && event\.mark/);
  assert.match(store, /withCompactionMark\(/);
  assert.match(store, /withoutRecordKey\(state\.sessionCompactions, id\)/);
  // One transcript row each, anchored on the message the checkpoint covers.
  assert.match(turns, /\{ kind: "compaction"; mark: ContextCompactionMark \}/);
  assert.match(turns, /anchored\.get\(message\.id\)/);
  assert.match(transcript, /function CompactionRow\(\{ mark \}/);
  assert.match(transcript, /chat\.compactionRow/);
  assert.match(transcript, /mark\.summarized/);
  assert.match(transcript, /chat\.compactionRowNoSummary/);
  assert.match(styles, /\.transcript-compaction-row \{/);
  // The inspector keeps its own line, now fed by the newest row.
  assert.match(
    transcript,
    /state\.sessionCompactions\[state\.activeSessionId\]\?\.at\(-1\)/,
  );
  assert.match(transcript, /chat\.usageCompaction/);
  assert.match(enLocale, /usageCompaction:/);
  assert.match(enLocale, /compactionRow:/);
});
