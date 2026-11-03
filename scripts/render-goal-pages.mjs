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
const artifactName=process.env.PI_GOAL_ARTIFACT_NAME??'goal-inset';
assert(/^goal-[a-z0-9-]+$/.test(artifactName),'PI_GOAL_ARTIFACT_NAME must be a Goal artifact directory name');
const output=resolve(root,'docs/artifacts',artifactName);
await mkdir(output,{recursive:true});
const sandbox=await mkdtemp(join(process.env.PI_SCRATCH_DIR,'goal-pages-'));
const data=join(sandbox,'data'),home=join(sandbox,'home'),workspace=join(sandbox,'Demo-project');
for(const p of [data,home,workspace,join(home,'AppData'),join(home,'LocalAppData')]) await mkdir(p,{recursive:true});
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData'),LOCALAPPDATA:join(home,'LocalAppData'),PI_DESKTOP_DATA_DIR:data,PI_DESKTOP_AGENTS_DIR:join(home,'agents'),PI_CODING_AGENT_DIR:join(home,'agent'),PI_DESKTOP_HOST_BIN:resolve(process.env.PI_DESKTOP_HOST_BIN),PI_DESKTOP_MCP_CONTROL:'0',PI_DESKTOP_PLAN_UI_PROBE:'1',ELECTRON_RENDERER_URL:'',PI_DESKTOP_START_MAXIMIZED:'0'};
delete env.ELECTRON_RUN_AS_NODE;
let requests=0;const held=new Set();
const model=createServer(async(req,res)=>{
 if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'goal-fixture',object:'model',owned_by:'isolated-fixture'}]}));return;}
 if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
 requests++;for await(const _ of req){};
 res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();held.add(res);res.on('close',()=>held.delete(res));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const host=new HostProcess({binaryPath:env.PI_DESKTOP_HOST_BIN,dataDir:data,env,onStderr(){}});
const sessions={};const criteria=['引用中保留来源链接','导出文档可离线阅读'];
let provider;
const objective='让研究报告导出后仍保留可追溯的引用';
async function append(id,role,content){await host.call('session.appendMessage',{sessionId:id,message:{id:randomUUID(),role,content,status:'complete',createdAt:new Date().toISOString()}});}
try{
 await host.handshake();await host.call('workspace.set',{path:workspace});
 provider=(await host.call('providers.create',{name:'隔离演示模型（仅本机）',vendorKey:'custom',type:'openai_compatible',protocol:'openai_compatible',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,authKind:'none',defaultModelId:'goal-fixture',apiStyle:'chat_completions'})).provider;
 await host.call('settings.set',{language:'zh-CN',theme:'dark',developerMode:true,defaultMode:'goal',defaultPermissionMode:'ask',defaultProviderId:provider.id,defaultModelId:'goal-fixture',onboardingDismissed:true});
 async function session(key,mode='goal',messages=true){const {session}=await host.call('session.create',{title:`隔离演示 · ${key}`,mode,projectPath:workspace,providerId:provider.id,modelId:'goal-fixture',permissionMode:'ask'});sessions[key]=session.id;if(messages&&mode!=='plan'){
 const {turnId}=await host.call('session.beginTurn',{sessionId:session.id});
 const result=await host.call('tools.execute',{sessionId:session.id,turnId,toolCallId:randomUUID(),toolName:'TodoWrite',mode,args:{todos:Array.from({length:5},(_,i)=>({content:`合成任务 ${i+1}：检查引用`,status:'completed'}))}});assert.equal(result.ok,true);
 await host.call('session.endTurn',{turnId,status:'completed',createNotification:false});
}if(messages){await append(session.id,'user',mode==='goal'?objective:'检查导出工具，保留现有行为。');await append(session.id,'assistant',mode==='goal'?'已检查引用映射。下面的目标状态和报告是用于界面验收的合成数据，不代表真实研究结果。':'这是用于回归对照的合成会话。Agent 仍使用普通工具权限，Plan 仍需单独审批。');}return session.id;}
 await session('目标设置','goal',false);await session('执行中','goal',true);
 for(const [key,status] of [['已暂停','paused'],['受阻','blocked'],['已完成','completed'],['预算耗尽','budget_exhausted'],['已取消','cancelled']]){
  const id=await session(key);let goal=(await host.call('goals.start',{sessionId:id,objective,criteria,budget:{maxTurns:status==='budget_exhausted'?1:20,maxTokens:50000}})).goal;
  const turnId=randomUUID();goal=(await host.call('goals.claimTurn',{sessionId:id,goalId:goal.id,expectedRevision:goal.revision,turnId})).goal;
  if(status==='completed'||status==='blocked')goal=(await host.call('goals.report',{sessionId:id,goalId:goal.id,turnId,status,progressSummary:status==='completed'?'演示夹具已报告所有验收条件满足。':'缺少用户指定的原始引用文件，等待补充后显式恢复。',...(status==='completed'?{audit:{version:1,objective,items:criteria.map(requirement=>({requirement,outcome:'met',evidence:'Synthetic loopback fixture evidence, not real research.'})),remainingWork:[]}}:{}),outcomes:criteria.map(criterion=>({criterion,outcome:status==='completed'?'met':'unverified',evidence:status==='completed'?'演示证据：本机合成样例检查通过。':'尚未验证；需要用户补充文件。'}))})).goal;
  if(status==='paused'||status==='cancelled')goal=(await host.call('goals.control',{sessionId:id,goalId:goal.id,expectedRevision:goal.revision,action:status==='paused'?'pause':'cancel'})).goal;
  await host.call('goals.settleTurn',{sessionId:id,goalId:goal.id,turnId,tokens:1280});
 }
 await session('Agent 对照','agent');await session('Plan 对照','plan');await session('审批对照','plan');
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
async function wait(fn,label,ms=30000){const end=Date.now()+ms;let last;while(Date.now()<end){if(closed)throw Error('Desktop exited '+logs.slice(-2000));try{const value=await fn();if(value)return value;}catch(e){last=e;}await delay(80);}throw Error(`Timeout ${label}: ${last?.message||''}`);}
const captures=[],checks=[],budgetMetrics=[];
async function invoke(name,...args){return page.evaluate(`(async()=>{const r=await window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}],...${JSON.stringify(args)});if(r?.ok===false)throw Error(JSON.stringify(r.error));return r?.ok===true?r.data:r;})()`);}
async function select(key){await page.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessions[key])})`);await wait(()=>page.evaluate(`document.querySelector('.chat-surface') && document.querySelector('.composer-shell') && !document.querySelector('.session-switch-progress')`),'session '+key);await frames();}
async function frames(){await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function click(selector){assert(await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`),'missing '+selector);await frames();}
async function escape(){await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await frames();}
async function setInput(selector,value){await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await frames();}
async function blur(selector){await page.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();n.blur();})()`);await frames();}
async function composerCloseup(name,label){await captureCrop(name,label);}
async function enter(selector){await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await frames();}
async function quietSettings(){assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-testid=goal-budget-settings] button,[data-testid=goal-budget-settings] [role=alert],[data-testid=goal-budget-settings] .goal-hint,.goal-budget-save-status'))`),false);}
async function budgetGeometry(label){await frames();const m=await page.evaluate(`(()=>{const row=document.querySelector('[data-testid=goal-budget-settings]'),segment=row.previousElementSibling.querySelector('.settings-segment'),r=segment.getBoundingClientRect();return {modeHeight:r.height,inputs:[...row.querySelectorAll('input')].map(n=>{const q=n.getBoundingClientRect(),l=n.closest('label').querySelector('span').getBoundingClientRect();return {height:q.height,width:q.width,centerDifference:(q.top+q.bottom-l.top-l.bottom)/2,font:getComputedStyle(n).fontSize,scroll:n.scrollWidth,client:n.clientWidth}})};})()`);for(const input of m.inputs){assert(Math.abs(input.height-m.modeHeight)<=2,label+' budget height mismatch '+JSON.stringify(m));assert(Math.abs(input.centerDifference)<=1,label+' label not aligned');assert(input.width>40,label+' clipped input');}budgetMetrics.push({label,...m});}
async function captureCrop(name,label,part='composer'){await frames();const box=await page.evaluate(`(()=>{const e=document.querySelector('.goal-composer-connection.has-goal')??document.querySelector('.composer-shell'),r=e.getBoundingClientRect(),header=document.querySelector('.goal-status')?.getBoundingClientRect();const part=${JSON.stringify(part)};let x=r.left-8,y=r.top-8,width=r.width+16,height=r.height+16;if(part==='left'||part==='right'){width=96;height=112;x=part==='left'?r.left-12:r.right-84;y=header.bottom-56;}return {x:Math.max(0,x),y:Math.max(0,y),width:Math.min(width,innerWidth-Math.max(0,x)),height:Math.min(height,innerHeight-Math.max(0,y)),scale:1};})()`);const image=await page.call('Page.captureScreenshot',{format:'png',clip:box});await writeFile(join(output,name+'.png'),Buffer.from(image.data,'base64'));const context=await page.evaluate(`({theme:document.documentElement.dataset.theme,state:document.querySelector('.goal-state')?.textContent,elapsed:document.querySelector('[data-testid=goal-elapsed]')?.textContent,viewportWidth:innerWidth})`);captures.push({name,label,...context,width:box.width,height:box.height,closeup:true,part});console.log('CAPTURE',name);}
async function contourCrops(prefix,label){await captureCrop(prefix+'-composer',label+' / composer');await captureCrop(prefix+'-left',label+' / left join','left');await captureCrop(prefix+'-right',label+' / right join','right');}
async function pause(sessionId){const goal=(await invoke('goalsGet',{sessionId})).goal;await invoke('goalsControl',{sessionId,goalId:goal.id,expectedRevision:goal.revision,action:'pause'});await wait(async()=>{const g=(await invoke('goalsGet',{sessionId})).goal;return g.status==='paused'&&!g.activeTurnId;},'settled pause');}
async function screenshot(name,label){
 await frames();await page.evaluate(`document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).forEach(a=>a.finish())`);await frames();
 const metrics=await page.evaluate(`(()=>{const bar=document.querySelector('[data-testid=goal-status-bar]'),dock=document.querySelector('.composer-dock'),input=document.querySelector('.composer-shell'),dialog=document.querySelector('.goal-dialog');const b=bar?.getBoundingClientRect(),d=dialog?.getBoundingClientRect();const section=document.querySelector('.goal-status')?.getBoundingClientRect(),shell=input?.getBoundingClientRect(),outer=document.querySelector('.has-goal'),r=getComputedStyle(input??document.body);return {theme:document.documentElement.dataset.theme,elapsed:document.querySelector('[data-testid=goal-elapsed]')?.textContent,state:document.querySelector('.goal-state')?.textContent,leftDelta:section&&shell?shell.left-section.left:null,rightDelta:section&&shell?shell.right-section.right:null,shellTopRadius:r.borderTopLeftRadius,outerBorder:outer?getComputedStyle(outer).borderLeftWidth:null,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,barHeight:b?.height??0,dockHeight:dock?.getBoundingClientRect().height,overlap:b&&input?b.bottom-input.getBoundingClientRect().top:0,status:bar?.innerText??null,dialogText:dialog?.innerText??null,dialogInBounds:!d||(d.left>=0&&d.top>=0&&d.right<=innerWidth+1&&d.bottom<=innerHeight+1),taskDock:document.querySelectorAll('.composer-dock .goal-task-fallback:not([hidden]) .dock').length,attachmentGap:b&&input?input.getBoundingClientRect().top-b.bottom:null,legacyCards:document.querySelectorAll('.goal-card').length};})()`);
 assert(metrics.scrollWidth<=metrics.width+1,name+' horizontal overflow');assert(metrics.barHeight<=48,name+' status bar too tall');assert(metrics.overlap<=1,name+' bar overlaps input');assert(metrics.dialogInBounds,name+' dialog outside viewport');assert.equal(metrics.legacyCards,0,name+' old Goal card still visible');if(metrics.barHeight){assert.equal(metrics.taskDock,0,name+' tasks coexist with Goal');assert(Math.abs(metrics.attachmentGap)<=.1,name+' header detached from input');assert(Math.abs(metrics.leftDelta+14)<.1&&Math.abs(metrics.rightDelta-14)<.1&&parseFloat(metrics.shellTopRadius)>0&&parseFloat(metrics.outerBorder)===0,name+' inset/curve incorrect '+JSON.stringify(metrics));assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-goal-action=details] .lucide-circle-ellipsis'))`),true,name+' details icon incorrect');assert(/^\d{2,}h\d{2}m\d{2}s$/.test(metrics.elapsed),name+' timer format');}
 const image=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(image.data,'base64'));captures.push({name,label,...metrics});console.log('CAPTURE',name);
}
try{
 const target=await wait(async()=>{const a=await(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();return a.find(t=>t.type==='page'&&t.url.includes('out/renderer/index.html')&&!new URL(t.url).searchParams.has('surface')&&t.webSocketDebuggerUrl);},'renderer target');
 page=await Cdp.connect(target.webSocketDebuggerUrl);await page.call('Runtime.enable');await page.call('Page.enable');
 const mt=await wait(async()=>{const a=await(await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json();return a.find(t=>t.type==='node'&&t.webSocketDebuggerUrl);},'main target');main=await Cdp.connect(mt.webSocketDebuggerUrl);
 await main.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!new URL(w.webContents.getURL()).searchParams.has('surface'));w.setBounds({width:1440,height:1040});w.setTitle('Goal · isolated page rendering');w.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const u=new URL(d.url);cb({cancel:['http:','https:'].includes(u.protocol)&&!(u.protocol==='http:'&&u.hostname==='127.0.0.1')});});return true;})()`);
 await wait(()=>page.evaluate(`Boolean(window.__PI_DESKTOP__&&document.querySelector('.app-shell:not(.app-shell-boot)')&&document.querySelector('.composer-mode-chip'))`),'app mounted');
 await page.evaluate(`(()=>{const tag=document.createElement('div');tag.id='qa-fixture-label';tag.textContent='隔离演示 · 合成数据 / 本机模型夹具 · 非真实任务';tag.style.cssText='position:fixed;z-index:999999;top:38px;left:50%;transform:translateX(-50%);padding:5px 12px;border:1px solid #8f8f8f66;border-radius:6px;background:#202020e8;color:white;font:12px system-ui;pointer-events:none';document.body.append(tag);return true;})()`);
 await select('目标设置');await wait(()=>page.evaluate(`!document.querySelector('.goal-status [role=status]')`),'no Goal setup');assert.equal(requests,0);
 await screenshot('01-home','Goal mode without a goal: normal composer, no management panel');
 await page.evaluate(`window.__PI_DESKTOP__.setSettingsTab('ai');window.__PI_DESKTOP__.setPage('settings')`);
 await wait(()=>page.evaluate(`Boolean(document.querySelector('[data-testid=goal-budget-settings]'))`),'budget settings');
 await page.evaluate(`document.querySelector('[data-testid=goal-budget-settings]').scrollIntoView({block:'center'})`);
 assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid=goal-budget-settings] input').length`),2);
 assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid=goal-budget-settings] [role=switch], [data-testid=goal-budget-settings] details').length`),0);
 await screenshot('02-budget-row','Dark / wide: compact Goal budget beside Default mode; initial 20 turns and blank Token');
 await budgetGeometry('dark-wide');
 const row='[data-testid=goal-budget-settings]';
 await setInput(row+' input','0');await setInput(row+' label:nth-child(2) input','0');
 assert.equal(await page.evaluate(`document.querySelectorAll('${row} [aria-invalid=true], ${row} [role=alert]').length`),0);
 await screenshot('03-budget-zero','Zero in both fields means unlimited, without validation text');
 await blur(row+' input');await wait(async()=>{const s=await invoke('settingsGet');return s.defaultGoalBudget?.maxTurns===null&&s.defaultGoalBudget.maxTokens===undefined;},'zero canonical persisted');await quietSettings();
 await screenshot('25-budget-silent-saved','Zero defaults persisted silently; no saving/saved label or popup');
 await page.evaluate(`window.__PI_DESKTOP__.setPage('chat')`);await page.evaluate(`window.__PI_DESKTOP__.setPage('settings')`);
 await wait(()=>page.evaluate(`Boolean(document.querySelector('[data-testid=goal-budget-settings]'))`),'reopened zero settings');
 assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('${row} input')].map(n=>n.value)`),['','']);
 await screenshot('26-budget-reopened','Reopened persisted unlimited defaults; no success feedback');
 await setInput(row+' input','24');await setInput(row+' label:nth-child(2) input','5000');await enter(row+' label:nth-child(2) input');
 await wait(async()=>{const s=await invoke('settingsGet');return s.defaultGoalBudget?.maxTurns===24&&s.defaultGoalBudget.maxTokens===5000;},'finite Enter saved');await quietSettings();
 await screenshot('27-budget-finite-saved','Finite 24 / 5000 persisted on Enter, silently');
 await setInput(row+' input','-1');await blur(row+' input');
 await wait(async()=>{const s=await invoke('settingsGet');return s.defaultGoalBudget.maxTurns===null&&s.defaultGoalBudget.maxTokens===5000;},'negative becomes unlimited without changing tokens');await quietSettings();
 assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('${row} input')].map(n=>({value:n.value,placeholder:n.placeholder}))`),[{value:'',placeholder:'无限制'},{value:'5000',placeholder:'无限制'}]);
 await screenshot('28-budget-invalid-unlimited','Negative turns normalize to Unlimited inside the field; valid 5000 Tokens retained; no hints');
 for(const [value,name] of [['1.5','42-budget-fraction'],['10001','43-budget-overflow'],['e','44-budget-malformed']]){await setInput(row+' input',value);await enter(row+' input');await quietSettings();assert.equal(await page.evaluate(`document.querySelector('${row} input').value`),'');await screenshot(name,'Invalid '+value+' becomes Unlimited with no helper or error row');}
 await setInput(row+' input','24');await setInput(row+' label:nth-child(2) input','-1');await enter(row+' label:nth-child(2) input');await wait(async()=>{const s=await invoke('settingsGet');return s.defaultGoalBudget.maxTurns===24&&s.defaultGoalBudget.maxTokens===undefined;},'invalid tokens preserve finite turns');await quietSettings();await screenshot('45-token-negative-unlimited','Negative Tokens become Unlimited; finite 24 turns retained; no hints');
 await setInput(row+' label:nth-child(2) input','9007199254740992');await enter(row+' label:nth-child(2) input');await quietSettings();assert.equal(await page.evaluate(`document.querySelector('${row} label:nth-child(2) input').value`),'');await screenshot('46-token-unsafe-unlimited','Unsafe Tokens become Unlimited inside the input; no validation text');
 await setInput(row+' input','');await setInput(row+' label:nth-child(2) input','');await blur(row+' input');
 await wait(async()=>{const s=await invoke('settingsGet');return s.defaultGoalBudget?.maxTurns===null&&s.defaultGoalBudget.maxTokens===undefined;},'blank unlimited saved');await quietSettings();
 await screenshot('04-budget-blank','Both fields blank: unlimited and silently persisted');assert.equal(requests,0);
 await page.call('Emulation.setDeviceMetricsOverride',{width:880,height:900,deviceScaleFactor:1,mobile:false});
 for(const theme of ['dark','light']){await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('${theme}')`);await budgetGeometry(theme+'-narrow');await screenshot('29-budget-narrow-'+theme,'Compact one-row budget / '+theme+' / narrow; heights match Default mode');}
 await page.call('Emulation.clearDeviceMetricsOverride');await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('light')`);await budgetGeometry('light-wide');await screenshot('30-budget-light-wide','Compact one-row budget / light / wide');await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('dark')`);
 checks.push('Invalid/zero/blank input normalizes per dimension to unlimited on blur/Enter; no helper, validation or saved text; finite neighbor and persistence/reopen verified; four height comparisons');
 await page.evaluate(`window.__PI_DESKTOP__.setPage('chat')`);await select('执行中');
 const beforeTodos=await invoke('todosGet',{sessionId:sessions['执行中']});assert.equal(beforeTodos.todos.length,5);
 await wait(()=>page.evaluate(`Boolean(document.querySelector('.composer-dock .goal-task-fallback:not([hidden]) .dock'))`),'normal tasks before goal');
 await invoke('goalsStart',{sessionId:sessions['执行中'],content:objective,messageId:randomUUID()});await wait(()=>requests===1,'active fixture');
 await wait(()=>page.evaluate(`Boolean(document.querySelector('[data-testid=goal-status-bar] [data-goal-action=pause]'))`),'running header');
 await wait(()=>page.evaluate(`!document.querySelector('.composer-dock .goal-task-fallback:not([hidden]) .dock')`),'tasks hidden');
 await wait(async()=>{const g=(await invoke('goalsGet',{sessionId:sessions['执行中']})).goal;return g.activeSinceMs&&Date.now()-g.activeSinceMs>=1200;},'actual elapsed time');
 await screenshot('05-running-dark','RUNNING: attached input header, elapsed time and edit/pause/delete/details icons; task dock suppressed');
 await composerCloseup('06-running-closeup','RUNNING / dark / wide / real held request / compact timer');await captureCrop('31-running-dark-left','RUNNING dark / wide / left continuous join','left');await captureCrop('31-running-dark-right','RUNNING dark / wide / right continuous join','right');
 assert.equal((await invoke('todosGet',{sessionId:sessions['执行中']})).todos.length,5);checks.push('Goal hides TaskDock without deleting its five persisted tasks');
 const active=await invoke('goalsGet',{sessionId:sessions['执行中']});assert.equal(active.goal.budget.maxTurns,null);
 await click('[data-goal-action=edit]');await wait(()=>page.evaluate(`Boolean(document.querySelector('[data-testid=goal-edit-dialog]'))`),'edit dialog');
 await wait(async()=>{const g=(await invoke('goalsGet',{sessionId:sessions['执行中']})).goal;return g.status==='paused'&&!g.activeTurnId;},'edit pause/settle');
 await screenshot('07-edit-objective','Editing first pauses active work and waits for claim settlement');
 const editedObjective='导出全部引用并验证离线阅读，不改变现有文件格式';
 await setInput('[data-testid=goal-edit-dialog] textarea',editedObjective);
 await click('[data-testid=goal-edit-dialog] button[type=submit]');await wait(async()=>{const g=(await invoke('goalsGet',{sessionId:sessions['执行中']})).goal;return g.objective===editedObjective&&g.status==='paused';},'edit persisted');
 await wait(()=>page.evaluate(`!document.querySelector('[data-testid=goal-edit-dialog]')`),'edit closes');
 assert.equal(requests,1,'Edit must not resume');await screenshot('08-edited-paused','Edited objective is saved and paused; budget/use retained and no implicit resume');
 const pausedBefore=await invoke('goalsGet',{sessionId:sessions['执行中']});
 await click('[data-goal-action=resume]');await wait(()=>requests===2,'explicit resumed request');
 await screenshot('09-running-edited','RUNNING after explicit resume: revised objective, timer retained');
 await click('[data-goal-action=pause]');await wait(async()=>{const g=(await invoke('goalsGet',{sessionId:sessions['执行中']})).goal;return g.status==='paused'&&!g.activeTurnId;},'pause from icon');
 const pausedAfter=(await invoke('goalsGet',{sessionId:sessions['执行中']})).goal;assert(pausedAfter.elapsedSeconds>=pausedBefore.goal.elapsedSeconds);await screenshot('32-paused-dark','PAUSED / dark / wide / actual pause icon and settled claim');await composerCloseup('33-paused-dark-closeup','PAUSED / dark / wide / frozen host-backed timer');const frozenTime=await page.evaluate(`document.querySelector('[data-testid=goal-elapsed]').textContent`);
 await click('[data-goal-action=details]');const height=await page.evaluate(`document.querySelector('.composer-dock').getBoundingClientRect().height`);
 await screenshot('10-details','On-demand details and model audit; header and input height unchanged');
 await escape();assert.equal(await page.evaluate(`document.querySelector('.composer-dock').getBoundingClientRect().height`),height);assert.equal(await page.evaluate(`document.querySelector('[data-testid=goal-elapsed]').textContent`),frozenTime,'Paused timer advanced across details');checks.push('Actual pause froze elapsed display; details did not resize dock');
 await click('[data-goal-action=delete]');await wait(()=>page.evaluate(`Boolean(document.querySelector('[data-testid=goal-delete-dialog]'))`),'delete confirmation');
 assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid=goal-delete-dialog] header button').length`),0);assert.equal(await page.evaluate(`[...document.querySelectorAll('[data-testid=goal-delete-dialog] button')].filter(n=>n.innerText==='关闭').length`),1);await screenshot('11-delete-confirm','Single bottom Close only; chat and task history retained');await click('[data-testid=goal-delete-dialog] .goal-dialog-actions .btn-ghost');assert((await invoke('goalsGet',{sessionId:sessions['执行中']})).goal);
 await click('[data-goal-action=delete]');await click('[data-testid=goal-delete-dialog] .goal-dialog-actions .btn-primary');
 await wait(async()=>(await invoke('goalsGet',{sessionId:sessions['执行中']})).goal===null,'logical removal');
 await wait(()=>page.evaluate(`!document.querySelector('[data-testid=goal-status-bar]')&&Boolean(document.querySelector('.composer-dock .goal-task-fallback:not([hidden]) .dock'))`),'task dock restored');
 await screenshot('12-deleted-tasks-restored','Current Goal removed; retained tasks return and chat remains');assert.equal((await invoke('todosGet',{sessionId:sessions['执行中']})).todos.length,5);checks.push('Edit requires pause/settle, explicit resume starts; deletion restores task display and retains chat/todos');
 for(const [key,name] of [['受阻','13-blocked'],['预算耗尽','14-exhausted'],['已完成','15-completed']]){await select(key);await wait(()=>page.evaluate(`Boolean(document.querySelector('[data-testid=goal-status-bar]'))`),'stored state');await screenshot(name,key);if(key==='预算耗尽'){await click('[data-goal-action=resume]');await screenshot('24-budget-resume','Explicit total-budget adjustment; existing finite cap is insufficient');const oldRequests=requests;await setInput('[data-testid=goal-resume-dialog] input','0');await setInput('[data-testid=goal-resume-dialog] label:nth-child(2) input','0');assert.equal(await page.evaluate(`document.querySelector('[data-testid=goal-resume-dialog] button[type=submit]').disabled`),false);await screenshot('41-resume-zero','Zero removes both caps, but requires explicit confirmation before execution');await escape();assert.equal(requests,oldRequests,'Dismissing zero resume executed work');}}
 await click('[data-goal-action=details]');await screenshot('16-completion-audit','Completed objective and current-model evidence audit');await escape();await select('已取消');await screenshot('23-cancelled','Cancelled Goal retains compact history and removal control');
 await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('light')`);await select('已暂停');await screenshot('17-light-paused','Light theme: input-attached objective strip');
 await invoke('goalsStart',{sessionId:sessions['目标设置'],content:objective,messageId:randomUUID()});await select('目标设置');await wait(()=>requests===3,'light running');
 await screenshot('18-running-light','RUNNING / light / wide / real held model request');await contourCrops('34-running-light','RUNNING / light / wide');await pause(sessions['目标设置']);await screenshot('35-paused-light','PAUSED / light / wide / actual host pause');await composerCloseup('36-paused-light-closeup','PAUSED / light / wide / frozen timer');
 await page.call('Emulation.setDeviceMetricsOverride',{width:880,height:900,deviceScaleFactor:1,mobile:false});await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('dark')`);await select('已暂停');await screenshot('19-narrow','PAUSED / dark / narrow / attached controls');await contourCrops('37-paused-dark-narrow','PAUSED / dark / narrow');await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('light')`);await screenshot('38-paused-light-narrow','PAUSED / light / narrow');await contourCrops('38-paused-light-narrow','PAUSED / light / narrow');await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('dark')`);
 await click('[data-goal-action=details]');await screenshot('20-narrow-details','Narrow bounded details without an expanded input dock');await escape();
 await select('目标设置');await click('[data-goal-action=resume]');await wait(()=>requests===4,'narrow resumed live request');for(const theme of ['dark','light']){await page.evaluate(`window.__PI_DESKTOP__.setThemeAttr('${theme}')`);await screenshot('39-running-narrow-'+theme,'RUNNING / '+theme+' / narrow / real held request');await contourCrops('40-running-narrow-'+theme,'RUNNING / '+theme+' / narrow');}await pause(sessions['目标设置']);await page.call('Emulation.clearDeviceMetricsOverride');await select('Agent 对照');await wait(()=>page.evaluate(`Boolean(document.querySelector('.composer-dock .goal-task-fallback:not([hidden]) .dock'))`),'Agent tasks');await screenshot('21-agent-tasks','Agent keeps its ordinary TaskDock');await select('Plan 对照');await screenshot('22-plan','Plan is unchanged');
 const unexpected=logs.split(String.fromCharCode(10)).filter(line=>/"level":"(?:error|fatal)"/.test(line));assert.deepEqual(unexpected,[]);
 await writeFile(join(output,'verification.json'),JSON.stringify({fixtureOnly:true,source:'Actual built Desktop, real isolated Rust data, controlled loopback model',requests,captures,checks,budgetMetrics,sandbox},null,2));

}catch(error){if(page){try{await writeFile(join(output,'failure-dom.json'),JSON.stringify(await page.evaluate(`({text:document.body.innerText,html:document.body.innerHTML,api:Boolean(window.__PI_DESKTOP__)})`),null,2));const im=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'failure.png'),Buffer.from(im.data,'base64'));}catch{}}
await writeFile(join(output,'failure.log'),String(error.stack)+'\n'+logs);throw error;}
finally{
 try{await main?.evaluate(`(async()=>{const {app}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');app.quit();return true;})()`);}catch{}
 await Promise.race([exit,delay(8000)]);if(!closed)child.kill();page?.close();main?.close();for(const res of held)res.destroy();await new Promise(r=>model.close(r));await writeFile(join(output,'application.log'),logs);
}
console.log(JSON.stringify({result:'PASS',captures:captures.length,checks}));
