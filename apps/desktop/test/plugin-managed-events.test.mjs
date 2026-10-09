import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
const root = fileURLToPath(new URL('../../../', import.meta.url));
register(pathToFileURL(join(root, 'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const { managedPresentationEvent } = await import(pathToFileURL(join(root,'apps/desktop/electron/main/plugin-managed-events.ts')));
const input = event => ({sessionId:'room',author:'Remote member',envelope:{turnId:'run',ts:42,event}});
test('managed stream maps stable transcript and tool identities without accepting unrelated authority',()=>{
 const m={id:'answer',role:'assistant',content:'hello',thinking:'reason',status:'streaming',createdAt:'2026-01-01T00:00:00.000Z',modelSystem:{version:1},attachments:[{ref:'/private'}],revisionRootId:'foreign'};
 const e=managedPresentationEvent(input({type:'message_update',message:m,deltaText:'hello',stream:'delta'}));
 assert.equal(e.sessionId,'room');assert.equal(e.turnId,'plugin:room:turn:run');assert.equal(e.agentName,'Remote member');
 assert.equal(e.event.message.id,'plugin:room:answer');assert.equal(e.event.message.agentName,'Remote member');
 assert.equal(e.event.message.modelSystem,undefined);assert.equal(e.event.message.attachments,undefined);assert.equal(e.event.message.revisionRootId,undefined);
 assert.equal(e.event.deltaText,'hello');
 const tool=managedPresentationEvent(input({type:'message_end',message:{id:'tool-row',role:'tool',toolCallId:' call ',parentToolCallId:'parent',content:'done'}}));
 assert.equal(tool.event.message.toolCallId,'plugin:room:tool:call');assert.equal(tool.event.message.parentToolCallId,'plugin:room:tool:parent');
 for(const type of ['tool_start','tool_update','tool_end'])assert.equal(managedPresentationEvent(input({type,toolCallId:'call',toolName:'Read',args:{path:'fixture'},partialResult:'part',result:'done'})).event.toolCallId,'plugin:room:tool:call');
});
test('managed presentation rejects lifecycle, permission, Ask and malformed input',()=>{
 for(const type of ['agent_start','agent_end','turn_end','status','planning_state','tool_permission_request','asktool_request','user_message_persisted'])assert.throws(()=>managedPresentationEvent(input({type})),{code:'INVALID_PARAMS'});
 for(const m of [{id:'m',role:'user'},{id:'m',role:'assistant',content:[]},{id:'m',role:'assistant',status:'completed'},{id:'m',role:'tool',toolCallId:123}])assert.throws(()=>managedPresentationEvent(input({type:'message_start',message:m})),{code:'INVALID_PARAMS'});
 assert.throws(()=>managedPresentationEvent(input({type:'message_update',message:{id:'m',role:'assistant'},deltaText:42})),{code:'INVALID_PARAMS'});
 assert.throws(()=>managedPresentationEvent({...input({type:'tool_end',toolCallId:'a'}),sessionId:''}),{code:'INVALID_PARAMS'});
 assert.throws(()=>managedPresentationEvent(input({type:'tool_update',toolCallId:'a',partialResult:'a'.repeat(1024*1024)})),{code:'INVALID_PARAMS'});
});
test('managed presentation reaches the renderer without plugin execution-event delivery',async()=>{
 const { readFile } = await import('node:fs/promises');
 const services=await readFile(join(root,'apps/desktop/electron/main/services/plugin-services.ts'),'utf8');
 const main=await readFile(join(root,'apps/desktop/electron/main/index.ts'),'utf8');
 assert.match(services,/emitManagedEvent: \(envelope\) =>\s*sendToRenderer\(IPC\.event\.agentMessage, envelope, \{ pluginDelivery: false \}\)/);
 assert.match(main,/channel === IPC\.event\.agentMessage && options\.pluginDelivery !== false\) \{\s*plugins\.deliverAgentEvent/);
});
