import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptSource = await readFile(
  new URL("../src/components/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const topologySource = await readFile(
  new URL("../src/lib/subagent-topology.ts", import.meta.url),
  "utf8",
);
const toolDisplaySource = await readFile(
  new URL("../src/lib/tool-display.ts", import.meta.url),
  "utf8",
);
const englishCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const chineseCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);

test("a delegation card reads its outcome from the lifecycle rows", () => {
  // `Task` returns as soon as the delegate starts, so its own payload says
  // `running` forever. Treating that as "no status" made every card claim
  // `completed` the moment the fan-out began.
  assert.match(topologySource, /const DELEGATION_STATUSES = new Set<SubagentOutcome>\(\[\s*\n\s*"running",/);
  assert.match(topologySource, /export function collectDelegationStatuses\(/);
  // TaskWait/TaskList/TaskStop all report `details.delegations[]`; later rows
  // settle what earlier ones reported as running.
  assert.match(topologySource, /const delegations = payload\?\.delegations;/);
  assert.match(topologySource, /statuses\.set\(id, status\)/);
  assert.match(
    topologySource,
    /const settled = statuses\?\.get\(delegationId\);\s*\n\s*if \(settled\) return settled;/,
  );
  // The lifecycle rows are still excluded from the topology's node count.
  assert.match(topologySource, /if \(isDelegationActivityItem\(item\)\) continue;/);
  assert.match(
    transcriptSource,
    /const delegationStatuses = turnDelegationStatuses \?\? collectDelegationStatuses\(items\)/,
  );
});

test("a lifecycle row summarizes by agent name, never by delegation id", () => {
  // Superseded the `delegationIds` summary (D268): the ids a lifecycle row is
  // called with are bare UUIDs, so the row reads the roster the runtime
  // returned and names the subagents instead.
  assert.match(toolDisplaySource, /delegate: \["description", "agent"\]/);
  assert.doesNotMatch(toolDisplaySource, /"delegationIds"/);
  assert.doesNotMatch(toolDisplaySource, /"delegationids"/);
  assert.match(toolDisplaySource, /function summaryText\(value: unknown\): string/);
  assert.match(toolDisplaySource, /Array\.isArray\(value\) && value\.every\(/);
  assert.doesNotMatch(toolDisplaySource, /record\[key\] as string/);
  // The roster is read from both payload shapes the lifecycle tools return.
  assert.match(topologySource, /export function delegationRoster\(/);
  assert.match(topologySource, /Array\.isArray\(payload\.stopped\)/);
  // A repeated definition is counted rather than listed twice.
  assert.match(topologySource, /count > 1 \? `\$\{name\} ×\$\{count\}` : name/);
  // The row's badge rolls the roster up with the shared status vocabulary.
  assert.match(
    transcriptSource,
    /rosterOutcome\s*\n?\s*\? t\(`chat\.subagentStatus\.\$\{rosterOutcome\}`\)/,
  );
  // A lifecycle row is presented as a subagent row, not as "Delegated".
  assert.match(transcriptSource, /LIFECYCLE_RUNNING_KEYS\s*\n?\s*: LIFECYCLE_LABEL_KEYS\)\[lifecycle\]/);
  // It never falls back to its own arguments, so a pending wait shows no ids.
  assert.match(transcriptSource, /const summary = lifecycle \? rosterSummary : argSummary;/);
  // ...and it is still not a topology node.
  assert.match(topologySource, /if \(isDelegationActivityItem\(item\)\) continue;/);
});

test("a live delegate row keeps the attribution its stream carried", () => {
  // Without these the row would render as a top-level tool call until the
  // session was reloaded from host-core.
  assert.match(
    storeSource,
    /envelope\.parentToolCallId\n\s+\? \{ parentToolCallId: envelope\.parentToolCallId \}/,
  );
  assert.match(storeSource, /envelope\.agentName \? \{ agentName: envelope\.agentName \}/);
});

test("a terminal tool event repairs a row lost during renderer reload", () => {
  assert.match(storeSource, /const toolStartsByCallId = new Map/);
  assert.match(storeSource, /const existing = s\.messages\.some\(/);
  assert.match(
    storeSource,
    /messages: existing\s*\? s\.messages\.map\([\s\S]*?: \[\.\.\.s\.messages, completed\]/,
  );
  assert.match(storeSource, /toolDurationMs: toolStart\s*\n\s*\? Math\.max/);
  assert.match(storeSource, /toolName: message\.toolName \?\? completed\.toolName/);
});

test("delegate rows render under their Task row, one level in", () => {
  assert.match(transcriptSource, /delegate\?: SubagentRun/);
  assert.match(
    transcriptSource,
    /\{open && delegate \? \([\s\S]*?<SubagentRunRows[\s\S]*?run=\{delegate\}[\s\S]*?agentName=\{agentName\}/,
  );
  assert.match(transcriptSource, /function SubagentRunRows\(/);
  assert.match(transcriptSource, /<div className="subagent-run">/);
  // The nested rows are the same components, so a delegate's tool calls and
  // reasoning read exactly like the parent's.
  assert.match(transcriptSource, /<ToolRow message=\{item\.message\} \/>/);
  assert.match(transcriptSource, /className="subagent-answer"/);
});

test("a Task row is expandable and names the delegate it used", () => {
  assert.match(
    transcriptSource,
    /hasToolDetails\(message\) \|\| Boolean\(delegate\)/,
  );
  assert.match(transcriptSource, /TOOL_ACTION_KEYS.*delegate: "chat\.toolDelegated"/s);
  assert.match(transcriptSource, /TOOL_RUNNING_KEYS.*delegate: "chat\.toolDelegating"/s);
  assert.match(transcriptSource, /className="tool-row-agent"/);
  assert.match(transcriptSource, /case "delegate":\n\s+return <IconBot/);
});

test("the report is printed once: in the body, or as the nested answer", () => {
  assert.match(
    transcriptSource,
    /const nestedReport = delegate\?\.items\.some\(\(item\) => item\.kind === "answer"\)/,
  );
  assert.match(
    transcriptSource,
    /\.\.\.\(nestedReport \? \{ hideDelegateReport: true \} : \{\}\)/,
  );
});

test("memoized activity rows compare delegate runs by their rows", () => {
  // Runs are rebuilt on every message change, so an identity check would
  // freeze a streaming delegate's rows.
  assert.match(
    transcriptSource,
    /function activityItemsEqual\([\s\S]*?subagentRunsEqual\(previous\.delegate, next\.delegate\)/,
  );
  assert.equal(transcriptSource.match(/activityItemsEqual\(/g)?.length, 3);
});

test("the nested run is visibly one level inside the call", () => {
  assert.match(
    messagesCss,
    /\.subagent-run > \.disclosure-collapse-rail::before \{[^}]*background: var\(--ds-border-default\)/,
  );
  assert.match(messagesCss, /\.subagent-run \{[^}]*margin: 2px 0 8px 24px/);
  assert.match(messagesCss, /\.subagent-run-count \{[^}]*margin-inline-start: auto/);
  assert.match(messagesCss, /\.tool-row-agent \{/);
});

test("every Task row renders as one accessible delegation topology", () => {
  // One delegation gets the same card as a fan-out: the compact row hid the
  // outcome, runtime and step count the card states outright.
  assert.match(
    transcriptSource,
    /const hasSubagentTopology = delegateItems\.length > 0/,
  );
  assert.match(
    transcriptSource,
    /<SubagentTopology\s+key="subagent-topology"\s+items=\{delegateItems\}\s+delegationStatuses=\{delegationStatuses\}\s+delegationTimings=\{delegationTimings\}\s*\/>/,
  );
  assert.match(transcriptSource, /className="subagent-topology" aria-labelledby=/);
  assert.match(transcriptSource, /className="subagent-topology-agents"/);
  assert.match(transcriptSource, /role="list"/);
  assert.match(transcriptSource, /variant="topology"/);
  assert.match(transcriptSource, /className="subagent-topology-node-header"/);
  assert.match(transcriptSource, /aria-expanded=\{open\}/);
  assert.match(transcriptSource, /aria-controls=\{hasDetails \? detailsId : undefined\}/);
});

test("the aggregate label counts, so a lone delegation is not called plural", () => {
  assert.match(
    transcriptSource,
    /: "chat\.subagentsFinished",\n(?:\s*\/\/[^\n]*\n)*\s*\{ count: subagentSummary\.total \},/,
  );
  for (const [locale, source] of [
    ["en", englishCatalogSource],
    ["zh-CN", chineseCatalogSource],
  ]) {
    for (const key of [
      "subagentsWorking",
      "subagentsFinished",
      "subagentsFinishedWithIssues",
      "subagentsFinishedWithWarnings",
    ]) {
      assert.match(source, new RegExp(`\\n\\s*${key}_one: "`), `${locale} ${key}_one`);
      assert.match(
        source,
        new RegExp(`\\n\\s*${key}_other: "`),
        `${locale} ${key}_other`,
      );
      // A bare key would win over the plural forms and bring the plural copy
      // back for a single delegation.
      assert.doesNotMatch(source, new RegExp(`\\n\\s*${key}: "`), `${locale} ${key}`);
    }
  }
  assert.match(englishCatalogSource, /subagentsWorking_one: "Subagent working"/);
  assert.match(englishCatalogSource, /subagentsWorking_other: "Subagents working"/);
});

test("the topology uses semantic low-noise surfaces and responsive connectors", () => {
  assert.match(messagesCss, /\.tool-activity-group\.has-subagents \{/);
  assert.match(messagesCss, /\.subagent-topology \{[^}]*display: grid/);
  assert.match(messagesCss, /\.subagent-topology-node \{[^}]*var\(--ds-border-default\)/);
  assert.match(messagesCss, /\.subagent-topology-node\.outcome-completed/);
  assert.match(messagesCss, /\.subagent-topology-node\.outcome-failed/);
  assert.match(messagesCss, /\.subagent-topology-node\.outcome-timed-out/);
  assert.match(
    messagesCss,
    /@container subagent-activity \(max-width: 520px\)[\s\S]*?\.subagent-topology/,
  );
  assert.match(messagesCss, /\.subagent-topology-node-header:focus-visible/);
});

test("a delegate's rows scroll in place instead of growing the page (D271)", () => {
  // The rows live in their own scroll container, not on `.subagent-run`: the
  // collapse rail is absolutely positioned outside that element's padding box,
  // so an overflow there would clip the rail away.
  assert.match(transcriptSource, /className="subagent-run-rows"/);
  // The scroll area is named by the run heading beside it rather than by a
  // duplicated label string.
  assert.match(
    transcriptSource,
    /className="subagent-run-rows"[\s\S]*?role="group"[\s\S]*?tabIndex=\{0\}[\s\S]*?aria-labelledby=\{headingId\}/,
  );
  assert.match(
    transcriptSource,
    /className="subagent-run-heading" id=\{headingId\}/,
  );
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*max-height: min\(420px, 48dvh\)/,
  );
  assert.match(messagesCss, /\.subagent-run-rows \{[^}]*overflow-y: auto/);
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*overscroll-behavior-y: contain/,
  );
  // A keyboard user can reach the scroll area the pointer already can.
  assert.match(messagesCss, /\.subagent-run-rows:focus-visible \{/);
  // `.subagent-run` itself must stay unclipped so the rail survives.
  assert.doesNotMatch(messagesCss, /\.subagent-run \{[^}]*overflow/);
  // Every field table is bounded too, so a long roster scrolls as well.
  assert.match(messagesCss, /\.tool-fields \{[^}]*max-height: 260px/);
  assert.match(messagesCss, /\.tool-fields \{[^}]*overflow: auto/);
});
