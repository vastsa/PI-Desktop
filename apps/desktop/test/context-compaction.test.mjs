import {
  readStoreSource,
  readStoreModule,
  readTranscriptSource,
  readMainSource,
  readSharedTypesSource,
} from "./helpers/source-contracts.mjs";
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
  events,
  runtime,
  commands,
  hostRpc,
  hostPermissions,
  hostSessions,
  hostTranscripts,
  transcript,
  inspector,
  turns,
  styles,
  enLocale,
  subagent,
  subagentContext,
  contextBudget,
  delegationHistory,
  compactionTail,
] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  readSharedTypesSource(),
  readMainSource(),
  read("../src/lib/api.ts"),
  readStoreSource(),
  readStoreModule("slices/events-slice.ts"),
  read("../../../packages/agent-runtime/src/runtime.ts"),
  read("../electron/main/builtin-commands.ts"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
  read("../../../crates/host-core/src/permissions.rs"),
  read("../../../crates/host-core/src/sessions.rs"),
  read("../../../crates/host-core/src/transcripts.rs"),
  readTranscriptSource(),
  read("../src/components/ContextUsageInspector.tsx"),
  read("../src/lib/assistant-turns.ts"),
  loadStyles(),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/agent-runtime/src/subagent.ts"),
  read("../../../packages/agent-runtime/src/subagent-context.ts"),
  read("../../../packages/agent-runtime/src/context-budget.ts"),
  read("../../../packages/agent-runtime/src/delegation-history.ts"),
  read("../../../packages/agent-runtime/src/compaction-tail.ts"),
]);

test("context compaction is wired through protocol v11 and the manual IPC path", () => {
  assert.match(protocol, /PROTOCOL_VERSION = 11/);
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
  assert.match(runtime, /CHECKPOINT_TRUNCATION_MARKER/);
  assert.match(
    compactionTail,
    /checkpoint truncated: this message crossed the retained context budget/,
  );
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
  // pi 0.86 carries the canonical system prompt in the transcript. The
  // reminder is appended as a per-turn system message, not only as the legacy
  // AgentContext.systemPrompt field.
  assert.match(
    runtime,
    /messages: \[\s*\.\.\.context\.messages,\s*\{\s*role: "system",\s*content: reminder,/,
  );
  assert.match(hostPermissions, /"new_context"/);
});

test("a delegate gets the session's turn-boundary budget protection (ADR 0299)", () => {
  // The delegate Agent wires the same hook the session does, and the budget
  // comes from the shared module evaluated against the run's resolved model.
  assert.match(subagent, /prepareNextTurnWithContext:\s*\(context, signal\)\s*=>/);
  assert.match(subagent, /from "\.\/context-budget\.js"/);
  assert.match(subagent, /contextBudgetFor\(/);
  // Terminal failure is the actionable delegate code, never the provider's
  // raw overflow text; the remap happens only after fallback had its chance.
  assert.match(subagent, /"SUBAGENT_CONTEXT_OVERFLOW"/);
  assert.match(subagent, /subagentContextOverflowError\(this\.provider\.modelId\)/);
  assert.match(subagent, /error\.code === "CONTEXT_TOO_LARGE"/);
  // Fallback alternatives are re-evaluated against their own window before
  // switching; one that cannot fit is skipped with the reason recorded.
  assert.match(subagent, /contextBudgetFor\(binding\.model, carried\)/);
  assert.match(
    subagent,
    /budget\.tokens >= budget\.hardLimit[\s\S]*?recordModelFailure\(identity/,
  );
  // The run result reports compaction and degradation additively, and the
  // lifecycle details the parent sees carry both flags (ADR 0299 decision 4).
  assert.match(subagent, /contextCompactions\?: number/);
  assert.match(subagent, /contextDegraded\?: boolean/);
  assert.match(runtime, /contextCompactions: record\.result\.contextCompactions/);
  assert.match(runtime, /contextDegraded: record\.result\.contextDegraded/);
  // A resumed chain is seeded within the delegate's own budget (decision 7):
  // the oldest tool call/result pairs leave first, and a stripped carrier
  // stops claiming "toolUse".
  assert.match(runtime, /budget: contextBudgetLimitsFor\(model\)/);
  assert.match(delegationHistory, /truncateSeededMessages/);
  assert.match(delegationHistory, /\.\.\.message, content, stopReason: "stop"/);
  // The compaction itself uses pi-agent-core's primitives, the session's
  // retention rule, and the degradation ladder of decision 4.
  assert.match(subagentContext, /prepareCompaction\(/);
  assert.match(subagentContext, /generateSummaryWithUsage\(/);
  assert.match(subagentContext, /contextBudgetFor\(model,/);
  assert.match(subagentContext, /delegateRetentionMode/);
  assert.match(subagentContext, /\? "active_turn"\s*: "completed_turn"/);
  assert.match(subagentContext, /degradedDelegateMessages/);
  // Delegate compaction is in-memory only: no host persistence, no transcript.
  assert.doesNotMatch(subagentContext, /appendCompaction|host\.call/);
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
  assert.match(contextBudget, /COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000/);
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
    events.match(/case "compaction_end":[\s\S]*?\n        case "agent_end":/)?.[0] ??
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

test("a failed compaction checkpoint still restores a non-empty context", () => {
  // A retained-tail fallback must not persist an empty tail: with no real
  // summary to carry the boundary, an empty tail restores as an empty context
  // after a runtime rebuild (model switch / restart) — the session reads as if
  // it had just started (#224). It must not persist one user line either: a
  // failed summary is the only record of the range behind it, so the tail is the
  // recent window itself (#827).
  assert.match(runtime, /const retainedTail = this\.fallbackRetainedTail\(/);
  assert.match(
    runtime,
    /return selectRecentTail\(\s*preparation\.messagesToSummarize,/,
  );
  assert.match(compactionTail, /export function selectRecentTail\(/);
  assert.match(compactionTail, /export function replayRetainedTail\(/);
  assert.match(
    compactionTail,
    /COMPACTION_RETAINED_TAIL_SHAPE = "recent_window"/,
  );
  // The shape marker is what keeps a rebuild from narrowing the window back to
  // one user message, so the read gate has to test it.
  assert.match(
    runtime,
    /details\.retainedTailShape === COMPACTION_RETAINED_TAIL_SHAPE/,
  );
  // Only a range the planner cannot split falls back at all; a prompt that is
  // merely too large is summarized in chunks (#827).
  assert.match(runtime, /private planSummaryRequests\(/);
  assert.match(runtime, /private async generateChunkedCompaction\(/);
  assert.match(
    runtime,
    /fallback: "retained_tail" satisfies ContextCompactionFallback,/,
  );
});

test("a fallback notice is stripped without discarding its carried summary", () => {
  // pi copies `previousSummary` from the previous compaction entry. A fallback
  // entry stores its carried-forward summary ahead of the recovery notice, so
  // the notice must be stripped without taking the real summary with it —
  // otherwise older task context is silently lost (#224). Both the normal and
  // the rebuild path share one extraction helper.
  assert.match(runtime, /function stripCompactionFallbackNotice\(/);
  assert.match(
    runtime,
    /const previousSummary = stripCompactionFallbackNotice\(\s*prepared\.value\.previousSummary,\s*\)/,
  );
  assert.match(
    runtime,
    /previousSummary:\s*stripCompactionFallbackNotice\(terminal\.summary\)/,
  );
});

test("the transcript shows one row per compaction, the inspector the newest", () => {
  assert.match(types, /type ContextCompactionMark = ContextCompactionStatus & \{/);
  assert.match(types, /mark\?: ContextCompactionMark/);
  // The generation counter and the family both ride inside the opaque details
  // value, so the host persists them without a record schema change.
  assert.match(runtime, /checkpointDetailsWithGeneration/);
  assert.match(runtime, /mark: contextCompactionMark\(checkpoint\)/);
  // Both the durable records and the live event feed the same per-session list.
  assert.match(store, /sessionCompactions: Record<string, \(ContextCompactionMark & \{ summary\?: string \}\)\[\]>/);
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
  // A retained-tail recovery is labelled as a failed summary, never as a
  // summary of N tokens (#543).
  assert.match(transcript, /mark\.fallback/);
  assert.match(transcript, /chat\.compactionRowSummaryFailed/);
  assert.match(styles, /\.transcript-compaction-row \{/);
  // The inspector keeps its own line, now fed by the newest row.
  assert.match(
    inspector,
    /state\.sessionCompactions\[state\.activeSessionId\]\?\.at\(-1\)/,
  );
  assert.match(inspector, /chat\.usageCompaction/);
  assert.match(enLocale, /usageCompaction:/);
  assert.match(enLocale, /compactionRow:/);
});
