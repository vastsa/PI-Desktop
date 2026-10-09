import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
const here = fileURLToPath(new URL('.', import.meta.url));
register(pathToFileURL(join(here, 'helpers/ts-import-hooks.mjs')));
const { PluginRuntime } = await import('../electron/main/plugin-runtime.ts');
function spawnProcess({ entry }) {
 const child = fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
 return { postMessage: message => child.connected && child.send(message), onMessage: handler => child.on('message', handler), onExit: handler => child.on('exit', code => handler(code ?? 0)), kill: () => child.kill() };
}
async function setup(t, main, grants = ['session.manage.own'], overrides = {}) {
 const temp = mkdtempSync(join(tmpdir(), 'pi-managed-session-'));
 const calls = [];
 const id = 'demo.managed';
 writeFileSync(join(temp, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, name: id, version: '0.0.1', main: 'main.js', permissions: ['session.manage.own'], contributes: { sessionSources: [{ id: 'room', label: 'Rooms' }] } }));
 writeFileSync(join(temp, 'main.js'), main);
 const runtime = new PluginRuntime({ hostEntry: join(here, '../electron/main/plugin-host-process.mjs'), spawnProcess, showToast: message => calls.push(message), session: {
  createManaged: async (pluginId, input) => { calls.push({ pluginId, input }); return { sessionId: 'room', created: true }; },
  appendManaged: async (pluginId, input) => { calls.push({ pluginId, input }); return { messageId: 'message', appended: true }; },
  managedOwner: async sessionId => sessionId === 'room' ? id : 'other.plugin',
  emitManagedEvent: event => calls.push(event),
  ...overrides,
 } });
 t.after(async () => { for (const plugin of runtime.listLoaded()) await runtime.unload(plugin.manifest.id); rmSync(temp, { recursive: true, force: true }); });
 await runtime.loadFromPath(temp, grants);
 return { runtime, calls, id };
}
test('managed session SDK and native submit cross the isolated process with trusted plugin identity', async t => {
 const { runtime, calls, id } = await setup(t, `module.exports = {
  onLoad: async () => { await pi.session.createManaged({source:'room',externalId:'one',title:'Room',pluginId:'forged'}); },
  onSessionSubmit: async input => { await pi.session.appendManaged({sessionId:input.sessionId,externalId:input.messageId,message:{role:'user',content:input.content,createdAt:'2026-10-08T00:00:00Z'}}); return {accepted:true}; }
 };`);
 assert.equal(calls[0].pluginId, id);
 assert.equal(calls[0].input.sourceLabel, 'Rooms');
 await runtime.submitManagedSession(id, { sessionId: 'room', content: 'hello', messageId: 'uuid-one' });
 assert.equal(calls[1].pluginId, id);
 assert.equal(calls[1].input.externalId, 'uuid-one');
 assert.equal(calls[1].input.message.content, 'hello');
 await runtime.unload(id);
 await assert.rejects(runtime.submitManagedSession(id, { sessionId: 'room', content: 'hello', messageId: 'uuid-two' }), { code: 'PLUGIN_UNLOADED' });
});
test('a missing grant denies SDK mutation and native submit before calling the handler', async t => {
 const { runtime, calls, id } = await setup(t, `module.exports={onLoad:async()=>{try{await pi.session.createManaged({source:'room',externalId:'one',title:'Room'});}catch(e){await pi.ui.showToast(e.code);}},onSessionSubmit:()=>({accepted:true})};`, []);
 assert.deepEqual(calls, ['PERMISSION_DENIED']);
 await assert.rejects(runtime.submitManagedSession(id, { sessionId: 'room', content: 'hello', messageId: 'uuid' }), { code: 'PERMISSION_DENIED' });
});
test('a plugin cannot acknowledge a native send without a valid handler result', async t => {
 const { runtime, id } = await setup(t, 'module.exports={onSessionSubmit:()=>({accepted:false})};');
 await assert.rejects(runtime.submitManagedSession(id, { sessionId: 'room', content: 'hello', messageId: 'uuid' }), { code: 'PLUGIN_INVALID_RESULT' });
});

test('managed presentation process checks durable owner and refuses permission events', async t => {
 const {calls}=await setup(t, `module.exports={onLoad:async()=>{
 const make=sessionId=>({sessionId,author:'Remote',envelope:{turnId:'run',ts:42,event:{type:'message_update',message:{id:'answer',role:'assistant',content:'stream'}}}});
 await pi.session.emitManagedEvent(make('room'));
 for(const input of [make('foreign'),{...make('room'),envelope:{turnId:'run',ts:42,event:{type:'asktool_request'}}}])try{await pi.session.emitManagedEvent(input)}catch(e){await pi.ui.showToast(e.code)}
 }};`);
 assert.equal(calls[0].event.message.id,'plugin:room:answer');
 assert.equal(calls[0].agentName,'Remote');
 assert.deepEqual(calls.slice(1),['PERMISSION_DENIED','INVALID_PARAMS']);
});
test('a delayed managed owner lookup still rejects a foreign owner', async t => {
 let release,started;const owner=new Promise(r=>release=r),called=new Promise(r=>started=r);
 const pending=setup(t, `module.exports={onLoad:async()=>{try{await pi.session.emitManagedEvent({sessionId:'room',envelope:{turnId:'run',ts:42,event:{type:'tool_end',toolCallId:'call',result:'done'}}})}catch(e){await pi.ui.showToast(e.code)}}};`, ['session.manage.own'], {managedOwner:()=>{started();return owner;}});
 await called;release('other.plugin');const {calls}=await pending;assert.deepEqual(calls,['PERMISSION_DENIED']);
});


test('managed cleanup appends existing history but cannot create a new session', async t => {
 const {runtime,calls,id}=await setup(t, `module.exports={onUnload:async()=>{
 await pi.session.appendManaged({sessionId:'room',externalId:'cleanup',message:{role:'assistant',content:'final',createdAt:'2026-10-08T00:00:00Z'}});
 try{await pi.session.createManaged({source:'room',externalId:'new',title:'New'})}catch(e){await pi.ui.showToast(e.code)}
 }};`);
 await runtime.unload(id);
 assert.equal(calls[0].input.externalId,'cleanup');
 assert.deepEqual(calls.slice(1),['PLUGIN_UNLOADED']);
});
