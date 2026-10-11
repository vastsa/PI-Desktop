import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
const root = fileURLToPath(new URL('../../../', import.meta.url));
register(pathToFileURL(join(root, 'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const { PluginRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/electron/main/plugin-runtime.ts')));
function spawnProcess({ entry }) {
 const child = fork(entry, [], { stdio: ['ignore','pipe','pipe','ipc'] });
 return { postMessage: m => child.connected && child.send(m), onMessage: h => child.on('message',h), onExit: h => child.on('exit', c => h(c ?? 0)), kill: () => child.kill() };
}
async function setup(t, grants = ['desktop.control']) {
 const dir = mkdtempSync(join(tmpdir(),'pi-agent-events-'));
 writeFileSync(join(dir,'manifest.json'), JSON.stringify({schemaVersion:1,id:'demo.events',name:'Events',version:'0.0.1',main:'main.js',permissions:['desktop.control'],contributes:{commands:[{id:'barrier',title:'Barrier'},{id:'unsubscribe',title:'Unsubscribe'}]}}));
 writeFileSync(join(dir,'main.js'), `let sub; module.exports={onLoad:async()=>{
 pi.events.on('desktop:agentEvent', x=>pi.ui.showToast(JSON.stringify(x)));
 pi.events.on('desktop:turnEnded', x=>pi.ui.showToast(JSON.stringify(x)));
 await pi.commands.register({id:'barrier',title:'Barrier',run:()=>pi.ui.showToast('barrier')});
 await pi.commands.register({id:'unsubscribe',title:'Unsubscribe',run:()=>pi.desktop.unsubscribeAgentEvents({subscriptionId:sub})});
 try { sub=(await pi.desktop.subscribeAgentEvents({sessionId:'worker'})).subscriptionId;
 const again=await pi.desktop.subscribeAgentEvents({sessionId:'worker'}); await pi.ui.showToast(again.subscriptionId===sub?'subscribed':'duplicate');
 }catch(e){await pi.ui.showToast(e.code);}
 },onUnload:async()=>{await pi.ui.showToast('unloading');await new Promise(resolve=>setTimeout(resolve,80));await pi.ui.showToast('unloaded');}};`);
 const messages=[];
 const runtime = new PluginRuntime({hostEntry:join(root,'apps/desktop/electron/main/plugin-host-process.mjs'),spawnProcess,showToast:x=>messages.push(x)});
 t.after(async()=>{for(const p of runtime.listLoaded()) await runtime.unload(p.manifest.id);rmSync(dir,{recursive:true,force:true});});
 await runtime.loadFromPath(dir, grants);
 const barrier=async()=>{await runtime.getCommands().find(x=>x.id==='barrier').run();};
 return {runtime,messages,barrier,dir};
}
test('process subscription isolates sessions, keeps stream identity and host terminal reason, and cancels independently',async t=>{
 const {runtime,messages,barrier}=await setup(t);
 assert.deepEqual(messages,['subscribed']);
 const stream=[{type:'message_update',deltaText:'hello',stream:'delta',message:{id:'m',role:'assistant'}},{type:'tool_start',toolCallId:'tool',toolName:'Bash',args:{command:'echo fixture'}},{type:'tool_update',toolCallId:'tool',partialResult:'progress'},{type:'tool_end',toolCallId:'tool',result:'done'},{type:'agent_end',messageIds:['m']}];
 runtime.deliverAgentEvent({sessionId:'other',turnId:'foreign',ts:0,event:{type:'agent_start'}});
 for(const event of stream) runtime.deliverAgentEvent({sessionId:'worker',turnId:'turn',ts:42,event,parentToolCallId:'parent',agentName:'delegate'});
 runtime.deliverTurnEnded({sessionId:'other',turnId:'foreign',reason:'completed'});
 runtime.deliverTurnEnded({sessionId:'worker',turnId:'turn',reason:'aborted',persisted:true});
 await barrier();
 const delivered=messages.slice(1,-1).map(JSON.parse);
 assert.equal(delivered.length,6);
 assert.ok(delivered.every(x=>x.subscriptionId===delivered[0].subscriptionId&&x.sessionId==='worker'&&x.turnId==='turn'));
 assert.deepEqual(delivered.slice(0,5).map(x=>x.event),stream);
 assert.equal(delivered[0].parentToolCallId,'parent');
 assert.equal(delivered.at(-1).reason,'aborted');
 await runtime.getCommands().find(x=>x.id==='unsubscribe').run();
 runtime.deliverAgentEvent({sessionId:'worker',event:{type:'agent_start'}});
 const before=messages.length;await barrier();assert.equal(messages.length,before+1);
});
test('missing grant receives no events; revocation gates each delivery; unload and reload start clean',async t=>{
 const denied=await setup(t,[]);
 assert.deepEqual(denied.messages,['PERMISSION_DENIED']);
 denied.runtime.deliverAgentEvent({sessionId:'worker',event:{type:'agent_start'}});await denied.barrier();
 assert.deepEqual(denied.messages,['PERMISSION_DENIED','barrier']);
 const active=await setup(t);
 active.runtime.listLoaded()[0].permissions.delete('desktop.control');
 active.runtime.deliverAgentEvent({sessionId:'worker',event:{type:'agent_start'}});await active.barrier();assert.deepEqual(active.messages,['subscribed','barrier']);
 await active.runtime.unload('demo.events');
 active.runtime.deliverAgentEvent({sessionId:'worker',event:{type:'agent_start'}});
 assert.equal(active.runtime.listLoaded().length,0);
 await active.runtime.loadFromPath(active.dir,['desktop.control']);
 active.runtime.deliverTurnEnded({sessionId:'worker',turnId:'new',reason:'error',persisted:true});await active.barrier();
 assert.equal(active.messages.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean).length,1);
});


test('a failed or missing durable terminal acknowledgement is unknown', async t => {
 const {runtime,messages,barrier}=await setup(t);
 runtime.deliverTurnEnded({sessionId:'worker',turnId:'failed-write',reason:'completed',persisted:false});
 runtime.deliverTurnEnded({sessionId:'worker',turnId:'no-host',reason:'completed'});
 await barrier();
 const events=messages.slice(1,-1).map(JSON.parse);
 assert.deepEqual(events.map(x=>x.reason),['unknown','unknown']);
});

test('existing subscription delivers durable receipt during bounded unload cleanup', async t => {
 const {runtime,messages}=await setup(t);
 const unloading=runtime.unload('demo.events');
 const deadline=Date.now()+1000;
 while(!messages.includes('unloading')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 assert.ok(messages.includes('unloading'));
 runtime.deliverTurnEnded({sessionId:'worker',turnId:'cleanup',reason:'aborted',persisted:true});
 await unloading;
 assert.ok(messages.some(x=>{try{return JSON.parse(x).turnId==='cleanup'}catch{return false}}));
 const before=messages.length;runtime.deliverTurnEnded({sessionId:'worker',turnId:'late',reason:'aborted',persisted:true});
 assert.equal(messages.length,before);
});
