import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { projectSubagentPresence, presenceMetrics } = await import('../src/lib/subagent-presence.ts');
const { resolveSubagentStyle } = await import('@pi-desktop/shared');
const task = (id, status) => ({ id, role: 'tool', toolName: 'Task', toolCallId: `call-${id}`, toolStatus: 'success', toolArgs: {agent:'worker',task:'Read files'}, toolResult:{details:{delegationId:id,status,modelId:'fixture',startedAt:1000,...(status==='running'?{}:{completedAt:3000})}} });
const child = (id, inputTokens, outputTokens) => ({role:'assistant',id,parentToolCallId:'call-a',content:'Reading files',usage:{inputTokens,outputTokens}});

test('only the current turn contributes; root usage and lifecycle rows are not delegates', () => {
  const messages = [task('old','running'), {role:'user'}, task('b','failed'), task('a','running'), child('1',22,4),{role:'user',steering:true},child('2',30,6),{role:'assistant',usage:{inputTokens:999,outputTokens:888}}];
  const [a,b] = projectSubagentPresence(messages);
  assert.deepEqual([a.id,a.turns,a.inputTokens,a.outputTokens,a.detail],['a',2,52,10,'Reading files']);
  assert.deepEqual(presenceMetrics(a,6000),{elapsed:5000,speed:2});
  assert.deepEqual([b.id,b.status,b.inputTokens],['b','failed',null]);
  assert.deepEqual(presenceMetrics(b,9000),{elapsed:2000,speed:null});
  assert.deepEqual(projectSubagentPresence([...messages,{role:'user'}]),[]);
  assert.deepEqual(projectSubagentPresence([task('a','completed')]),[]);
});
test('creating and terminal snapshots are not mistaken for live running workers', () => {
  const queued = { ...task('q','running'), toolResult:undefined,toolStatus:'running' };
  const stale = {role:'tool',toolName:'TaskList',toolResult:{details:{delegations:[{delegationId:'b',status:'running'}]}}};
  const [q,b] = projectSubagentPresence([task('b','failed'),queued,stale]);
  assert.deepEqual([q.status,b.status],['queued','failed']);
});
test('style is opt-in, including with unknown stored values', () => {
  for(const setting of [undefined,{}, {subagentStyle:'future'}]) assert.equal(resolveSubagentStyle(setting),'transcript');
  assert.equal(resolveSubagentStyle({subagentStyle:'bar'}),'bar');
});
