#!/usr/bin/env node
// Actual built Desktop pages, isolated Rust data and loopback-only model fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HostProcess } from '../packages/host-runtime/dist/index.js';
import { repositoryRoot, resolveElectronBinary } from './e2e/boot.mjs';

const root=repositoryRoot();
assert(process.env.PI_SCRATCH_DIR && process.env.PI_DESKTOP_HOST_BIN);
const artifactName=process.env.PI_GOAL_ARTIFACT_NAME??'goal-independent-review';
assert(/^goal-[a-z0-9-]+$/.test(artifactName),'PI_GOAL_ARTIFACT_NAME must be a Goal artifact directory name');
const output=resolve(root,'docs/artifacts',artifactName);
await mkdir(output); // Never overwrite a previous acceptance gallery.
const sandbox=await mkdtemp(join(process.env.PI_SCRATCH_DIR,'goal-pages-'));
const data=join(sandbox,'data'),home=join(sandbox,'home'),workspace=join(sandbox,'Demo-project');
for(const p of [data,home,workspace,join(home,'AppData'),join(home,'LocalAppData')]) await mkdir(p,{recursive:true});
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData'),LOCALAPPDATA:join(home,'LocalAppData'),PI_DESKTOP_DATA_DIR:data,PI_DESKTOP_AGENTS_DIR:join(home,'agents'),PI_CODING_AGENT_DIR:join(home,'agent'),PI_DESKTOP_HOST_BIN:resolve(process.env.PI_DESKTOP_HOST_BIN),PI_DESKTOP_MCP_CONTROL:'0',PI_DESKTOP_PLAN_UI_PROBE:'1',ELECTRON_RENDERER_URL:'',PI_DESKTOP_START_MAXIMIZED:'0'};
delete env.ELECTRON_RUN_AS_NODE;
let requests=0;const held=[],modelRequests=[];let fixtureError;
const model=createServer(async(req,res)=>{try{
 if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'goal-fixture',object:'model',owned_by:'isolated-fixture'}]}));return;}
 assert.equal(req.url,'/v1/chat/completions');let body='';for await(const chunk of req){body+=chunk;assert(body.length<2000000);}
 requests++;assert(requests<=7,'Unexpected model continuation');modelRequests.push(JSON.parse(body));held.push(res);
 res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
}catch(error){fixtureError=error;res.writeHead(500);res.end();}});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const host=new HostProcess({binaryPath:env.PI_DESKTOP_HOST_BIN,dataDir:data,env,onStderr(){}}),sessions={};
const objective='Original UI fixture objective';
try{
 await host.handshake();await host.call('workspace.set',{path:workspace});
 const provider=(await host.call('providers.create',{name:'隔离本机测试模型',vendorKey:'custom',type:'openai_compatible',protocol:'openai_compatible',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,authKind:'none',defaultModelId:'goal-fixture',apiStyle:'chat_completions'})).provider;
 await host.call('settings.set',{language:'zh-CN',theme:'dark',developerMode:true,defaultMode:'agent',defaultPermissionMode:'ask',defaultProviderId:provider.id,defaultModelId:'goal-fixture',onboardingDismissed:true});
 const {session}=await host.call('session.create',{title:'目标生命周期隔离回归',mode:'goal',projectPath:workspace,providerId:provider.id,modelId:'goal-fixture',permissionMode:'ask'});
 sessions['独立目标']=session.id;
}finally{await host.dispose();}

async function port(){const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
class Cdp{
 constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();this.events=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else this.events.push(m);});}
 static async connect(url){const s=new WebSocket(url);await new Promise((r,j)=>{s.addEventListener('open',r,{once:true});s.addEventListener('error',j,{once:true});});return new Cdp(s);}
 call(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`CDP timeout ${method}`));},20000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
 close(){this.socket.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}this.pending.clear();}
}
const cdpPort=await port(),mainPort=await port();
const {appDir,electronBinary}=resolveElectronBinary(root);
const child=spawn(electronBinary,[appDir,`--remote-debugging-port=${cdpPort}`,`--inspect=${mainPort}`,`--user-data-dir=${join(sandbox,'profile')}`],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
let logs='',page,main,closed=false;child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exit=new Promise(r=>child.once('exit',(code,signal)=>{closed=true;r({code,signal});}));
async function wait(fn,label,ms=30000){const end=Date.now()+ms;let last;while(Date.now()<end){if(fixtureError)throw fixtureError;if(closed)throw Error('Desktop exited '+logs.slice(-2000));try{const value=await fn();if(value)return value;}catch(e){last=e;}await delay(80);}throw Error(`Timeout ${label}: ${last?.message||''}`);}
const captures=[],checks=[];
async function invoke(name,...args){return page.evaluate(`(async()=>{const r=await window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}],...${JSON.stringify(args)});if(r?.ok===false)throw Error(JSON.stringify(r.error));return r?.ok===true?r.data:r;})()`);}
async function select(key){await page.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessions[key])})`);await wait(()=>page.evaluate(`document.querySelector('.chat-surface') && document.querySelector('.composer-shell') && !document.querySelector('.session-switch-progress')`),'session '+key);await frames();}
async function frames(){await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function click(selector){assert(await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`),'missing '+selector);await frames();}
async function setInput(selector,value){await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await frames();}
async function screenshot(name,label){
 await frames();await page.evaluate(`document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).forEach(a=>a.finish())`);await frames();
 const metrics=await page.evaluate(`(()=>{const bar=document.querySelector('[data-testid=goal-status-bar]'),dock=document.querySelector('.composer-dock'),input=document.querySelector('.composer-shell'),dialog=document.querySelector('.goal-dialog');const b=bar?.getBoundingClientRect(),d=dialog?.getBoundingClientRect();const section=document.querySelector('.goal-status')?.getBoundingClientRect(),shell=input?.getBoundingClientRect(),outer=document.querySelector('.has-goal'),r=getComputedStyle(input??document.body);return {theme:document.documentElement.dataset.theme,elapsed:document.querySelector('[data-testid=goal-elapsed]')?.textContent,state:document.querySelector('.goal-state')?.textContent,leftDelta:section&&shell?shell.left-section.left:null,rightDelta:section&&shell?shell.right-section.right:null,shellTopRadius:r.borderTopLeftRadius,outerBorder:outer?getComputedStyle(outer).borderLeftWidth:null,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,barHeight:b?.height??0,dockHeight:dock?.getBoundingClientRect().height,overlap:b&&input?b.bottom-input.getBoundingClientRect().top:0,status:bar?.innerText??null,dialogText:dialog?.innerText??null,dialogInBounds:!d||(d.left>=0&&d.top>=0&&d.right<=innerWidth+1&&d.bottom<=innerHeight+1),taskDock:document.querySelectorAll('.composer-dock .goal-task-fallback:not([hidden]) .dock').length,attachmentGap:b&&input?input.getBoundingClientRect().top-b.bottom:null,legacyCards:document.querySelectorAll('.goal-card').length};})()`);
 assert(metrics.scrollWidth<=metrics.width+1,name+' horizontal overflow');assert(metrics.barHeight<=48,name+' status bar too tall');assert(metrics.overlap<=1,name+' bar overlaps input');assert(metrics.dialogInBounds,name+' dialog outside viewport');assert.equal(metrics.legacyCards,0,name+' old Goal card still visible');if(metrics.barHeight){assert.equal(metrics.taskDock,0,name+' tasks coexist with Goal');assert(Math.abs(metrics.attachmentGap)<=.1,name+' header detached from input');assert(Math.abs(metrics.leftDelta+14)<.1&&Math.abs(metrics.rightDelta-14)<.1&&parseFloat(metrics.shellTopRadius)>0&&parseFloat(metrics.outerBorder)===0,name+' inset/curve incorrect '+JSON.stringify(metrics));assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-goal-action=details] .lucide-circle-ellipsis'))`),true,name+' details icon incorrect');assert(/^(?:\d+[dhms])(?: \d+[dhms])*$/.test(metrics.elapsed),name+' natural timer format');}
 const image=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(image.data,'base64'));captures.push({name,label,...metrics});console.log('CAPTURE',name);
}
try{
 const target=await wait(async()=>{const a=await(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();return a.find(t=>t.type==='page'&&t.url.includes('out/renderer/index.html')&&!new URL(t.url).searchParams.has('surface')&&t.webSocketDebuggerUrl);},'renderer target');
 page=await Cdp.connect(target.webSocketDebuggerUrl);await page.call('Runtime.enable');await page.call('Page.enable');
 const mt=await wait(async()=>{const a=await(await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json();return a.find(t=>t.type==='node'&&t.webSocketDebuggerUrl);},'main target');main=await Cdp.connect(mt.webSocketDebuggerUrl);
 await main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!new URL(w.webContents.getURL()).searchParams.has('surface'));w.setBounds({width:1440,height:1040});w.setTitle('Goal · isolated page rendering');w.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const u=new URL(d.url);cb({cancel:['http:','https:'].includes(u.protocol)&&!(u.protocol==='http:'&&u.hostname==='127.0.0.1')});});return true;})()`);
 await wait(()=>page.evaluate(`Boolean(window.__PI_DESKTOP__&&document.querySelector('.app-shell:not(.app-shell-boot)')&&document.querySelector('.composer-mode-chip'))`),'app mounted');
 await page.evaluate(`(()=>{const tag=document.createElement('div');tag.id='qa-fixture-label';tag.textContent='隔离演示 · 合成数据 / 本机模型夹具 · 非真实任务';tag.style.cssText='position:fixed;z-index:999999;top:38px;left:50%;transform:translateX(-50%);padding:5px 12px;border:1px solid #8f8f8f66;border-radius:6px;background:#202020e8;color:white;font:12px system-ui;pointer-events:none';document.body.append(tag);return true;})()`);
 await select('独立目标');
 const id=sessions['独立目标'];
 const goal=async()=>(await invoke('goalsGet',{sessionId:id})).goal;
 async function editComposer(text){await page.evaluate(`(()=>{const e=document.querySelector('.composer-input[contenteditable=true]');if(!e)throw Error('Composer is not editable');e.focus();e.textContent=${JSON.stringify(text)};const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}}));})()`);await frames();}
 async function send(text,steer=false){await editComposer(text);if(steer)await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:1});else await click('.composer-shell .send-btn');await frames();}
 async function choose(mode){await click('.composer-mode-chip');const names={agent:['智能体','Agent'],plan:['规划','计划','方案','Plan'],goal:['目标','Goal']}[mode];assert(await page.evaluate(`(()=>{const names=${JSON.stringify(names)},buttons=[...document.querySelectorAll('.composer-mode-menu [role=menuitemradio]')];const b=buttons.find(b=>names.includes(b.innerText.trim()));if(!b)throw Error('Mode options: '+buttons.map(b=>b.innerText).join('|'));b.click();return true;})()`));await wait(()=>page.evaluate(`document.querySelector('.composer-mode-chip')?.dataset.mode===${JSON.stringify(mode)}`),'input mode '+mode);}
 function respond(index,tool){if(fixtureError)throw fixtureError;const res=held[index];assert(res&&!res.destroyed);const delta=tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool,arguments:'{}'}}]}:{role:'assistant',content:'本机夹具已完成当前对话轮次。'};for(const [value,finish]of[[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'ui-'+index,model:'goal-fixture',choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`);res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}})}\n\n`);res.end('data: [DONE]\n\n');}
 const system=index=>modelRequests[index].messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
 await send(objective);await wait(()=>requests===1,'Goal sent from actual Composer');
 await wait(()=>page.evaluate(`document.querySelector('.composer-mode-chip')?.dataset.mode==='agent'&&Boolean(document.querySelector('[data-testid=goal-status-bar]'))`),'one-shot Agent input');
 const first=await goal();assert.equal(first.status,'active');assert.equal(first.activeScope.objective,objective);
 await screenshot('01-running-agent-input','Real Goal started from Composer; input returned to Agent');
 await choose('plan');assert.equal((await goal()).activeTurnId,first.activeTurnId);assert.equal((await goal()).status,'active');
 await screenshot('02-plan-selection-goal-running','Plan input preference does not pause the held Goal round');await choose('agent');
 await click('[data-goal-action=edit]');await setInput('[data-testid=goal-edit-dialog] textarea','Revised next-round UI objective');
 assert(await page.evaluate(`document.querySelector('[data-testid=goal-edit-dialog]').innerText.includes('下一执行轮')`));
 await click('[data-testid=goal-edit-dialog] button[type=submit]');await wait(()=>page.evaluate(`!document.querySelector('[data-testid=goal-edit-dialog]')`),'edit saved');
 let current=await goal();assert.equal(current.objective,'Revised next-round UI objective');assert.equal(current.activeScope.objective,objective);assert.equal(current.activeTurnId,first.activeTurnId);assert.equal(current.status,'active');
 await screenshot('03-live-header-next-round-edit','Header reflects saved edit while the current Host claim keeps original scope');
 await send('UI immediate user guidance',true);assert.equal((await goal()).status,'active');assert.equal((await goal()).activeTurnId,first.activeTurnId);
 respond(0,'GetGoal');await wait(()=>requests===2,'same-round response after immediate guidance');
 assert(system(1).includes('"objective":"Original UI fixture objective"'));assert(!system(1).includes('"objective":"Revised next-round UI objective"'));
 assert(JSON.stringify(modelRequests[1].messages.filter(m=>m.role==='user')).includes('UI immediate user guidance'));
 await screenshot('04-immediate-guidance','Actual Alt+Enter input reaches model without pausing Goal');
 await click('[data-goal-action=pause]');assert.equal((await goal()).pauseRequested,true);respond(1);
 await wait(async()=>{const row=await goal();return row.status==='paused'&&!row.activeTurnId;},'header pause settlement');
 await wait(()=>page.evaluate(`!document.querySelector('.composer-shell .stop-btn')`),'paused Composer idle');
 await send('Ordinary UI Agent task');await wait(()=>requests===3,'Agent work during paused Goal');assert(!system(2).includes('<untrusted-goal-data>'));respond(2);
 await wait(()=>page.evaluate(`!document.querySelector('.composer-shell .stop-btn')`),'Agent task done');assert.equal((await goal()).status,'paused');
 await click('[data-goal-action=resume]');await wait(()=>requests===4,'Goal resumes from Agent Composer');
 assert(system(3).includes('"objective":"Revised next-round UI objective"'));assert.equal((await goal()).status,'active');
 await screenshot('05-resumed-after-agent-task','Header Resume succeeds after ordinary Agent task, with Agent input mode');
 await choose('goal');await send('Replacement UI Goal while running');await wait(()=>requests===5,'active replacement');
 current=await goal();assert.notEqual(current.id,first.id);assert.equal(current.status,'active');assert.equal(current.roundsStarted,1);
 await wait(()=>page.evaluate(`document.querySelector('.composer-mode-chip')?.dataset.mode==='agent'`),'replacement returns Agent');
 await screenshot('06-active-replacement','Fresh explicit Goal replaces active old identity and runs after drain');
 await click('[data-goal-action=pause]');respond(4);await wait(async()=>{const row=await goal();return row.status==='paused'&&!row.activeTurnId;},'replacement paused');
 await wait(()=>page.evaluate(`!document.querySelector('.composer-shell .stop-btn')`),'replacement idle');
 const previousId=current.id;await choose('goal');await send('Fresh UI Goal replacing paused work');await wait(()=>requests===6,'paused replacement starts');
 current=await goal();assert.notEqual(current.id,previousId);assert.equal(current.status,'active');assert.equal(current.roundsStarted,1);
 await wait(()=>page.evaluate(`document.querySelector('.composer-mode-chip')?.dataset.mode==='agent'`),'fresh Goal returns Agent');
 await screenshot('07-paused-replacement','New Goal replaces paused old Goal without a resume error');
 await click('.composer-shell .stop-btn');await wait(async()=>{const row=await goal();return row.status==='paused'&&!row.activeTurnId;},'explicit Composer Stop');
 await page.call('Emulation.setDeviceMetricsOverride',{width:880,height:900,deviceScaleFactor:1,mobile:false});await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('light')`);
 await screenshot('08-stopped-agent-light-narrow','Only explicit Stop paused the new Goal; narrow/light layout remains intact');
 assert.equal(await page.evaluate(`document.body.innerText.includes('GOAL_MODE_REQUIRED')`),false);
 assert.equal(await page.evaluate(`document.body.innerText.includes('无法安全恢复草稿')`),false,'Stopping accepted Goal must not attempt prompt retraction');
 checks.push({oneShotAgent:true,modeSelectionNeverPauses:true,visibleEditImmediate:true,scopeDeferredToNextHostRound:true,immediateGuidance:true,ordinaryTaskThenHeaderResume:true,activeReplacement:true,pausedReplacement:true,explicitStop:true});
 await writeFile(join(output,'verification.json'),JSON.stringify({fixtureOnly:true,source:'Actual built Desktop with real isolated Host/sidecar and loopback model; no synthetic transcript rows',requests,captures,checks,sandbox},null,2));

}catch(error){if(page){try{await writeFile(join(output,'failure-dom.json'),JSON.stringify(await page.evaluate(`({text:document.body.innerText,html:document.body.innerHTML,api:Boolean(window.__PI_DESKTOP__)})`),null,2));const im=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'failure.png'),Buffer.from(im.data,'base64'));}catch{}}
await writeFile(join(output,'failure.log'),String(error.stack)+'\n'+logs);throw error;}
finally{
 try{await main?.evaluate(`(async()=>{const {app}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');app.quit();return true;})()`);}catch{}
 await Promise.race([exit,delay(8000)]);if(!closed)child.kill();page?.close();main?.close();for(const res of held)res.destroy();await new Promise(r=>model.close(r));await writeFile(join(output,'application.log'),logs);
}
console.log(JSON.stringify({result:'PASS',captures:captures.length,checks}));
