import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { probeWithChromium } from "./goal-browser-probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = String.raw`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {IPC} from '@pi-desktop/shared';
import {GoalSessionPanel} from './apps/desktop/src/features/goals/GoalSessionPanel';
import {GoalBudgetRow} from './apps/desktop/src/features/settings/GoalBudgetRow';
import {useAppStore} from './apps/desktop/src/stores/app-store';
import {autonomousGoalEn,autonomousGoalZhCN} from './packages/i18n/src/autonomous-goal';
const calls=[]; const listeners=new Set(); const saves=[]; const ticks=new Map(); let timerId=100000; let now=1800000000000;
Date.now=()=>now; const originalSetInterval=window.setInterval; const originalClearInterval=window.clearInterval;
window.setInterval=(fn,ms,...args)=>ms===1000?(ticks.set(++timerId,()=>fn(...args)),timerId):originalSetInterval(fn,ms,...args);
window.clearInterval=id=>ticks.delete(id)||originalClearInterval(id);
let hostGoal=null; let saveResolve,saveReject; let controlError=false; let defaults; let settingsKey=0; let renderSettings; let previewSequence=0; let todoMounts=0; let todoUnmounts=0; let holdDelete; let deleteResolve; let holdRead; let readResolve;
const base={id:'g',sessionId:'s',revision:1,status:'active',objective:'Repair all exported citation links and preserve the complete original bibliography — '+ 'long objective '.repeat(30),criteria:['All citations survive'],outcomes:[],progressSummary:'',roundsStarted:2,tokenUsage:200,budget:{maxTurns:20},activeTurnId:'turn',elapsedSeconds:3660,activeSinceMs:now-10000,audit:{version:1,objective:'Old objective',items:[],remainingWork:[]}};
window.piDesktop={on(channel,listener){if(channel===IPC.event.goalsChanged)listeners.add(listener);return()=>listeners.delete(listener)},async invoke(channel,request){
 calls.push({channel,request});
 if(channel===IPC.invoke.goalsGet){if(holdRead){holdRead=false;return new Promise(resolve=>readResolve=data=>resolve({ok:true,data}))}return {ok:true,data:{goal:hostGoal}}}
 if(channel===IPC.invoke.goalsControl){
  if(controlError){controlError=false;return {ok:false,error:{code:'REVISION_CONFLICT',message:'fixture revision conflict'}}}
  if(request.action==='delete'){
   const result={goal:null,goalId:hostGoal.id,revision:hostGoal.revision+1};hostGoal=null;
   if(holdDelete){holdDelete=false;return new Promise(resolve=>deleteResolve=()=>resolve({ok:true,data:result}))}
   return {ok:true,data:result};
  }
  hostGoal={...hostGoal,revision:hostGoal.revision+1,status:{pause:'paused',resume:'active',cancel:'cancelled',edit:'paused'}[request.action],...(request.budget?{budget:request.budget}:{}),...(request.action==='edit'?{objective:request.objective,criteria:[],outcomes:[],audit:undefined,progressSummary:''}:{})};
  return {ok:true,data:{goal:hostGoal}};
 }
 throw Error('Unexpected fixture IPC '+channel);
}};
const uiRoot=createRoot(document.getElementById('root'));
function SettingsFixture(){const [settings,setSettings]=useState({defaultGoalBudget:defaults});renderSettings=()=>setSettings({defaultGoalBudget:defaults});return <GoalBudgetRow settings={settings} saveSettings={patch=>new Promise((resolve,reject)=>{saves.push(patch);saveReject=reject;saveResolve=(apply=true)=>{if(apply){defaults=patch.defaultGoalBudget;setSettings({defaultGoalBudget:defaults})}resolve()}})}/>}
const todoData=[{id:'todo-1',content:'Retained fixture todo',status:'pending'}];
function TaskFixture(){const [draft,setDraft]=useState('Retained task UI');React.useEffect(()=>{todoMounts++;return()=>todoUnmounts++},[]);return <div data-testid='task-dock-stub'><span>{todoData[0].content}</span><input aria-label='Retained task draft' value={draft} onChange={e=>setDraft(e.target.value)}/></div>}
function render(){flushSync(()=>uiRoot.render(<main><p>{i18n.t('autonomousGoal.demo')}</p><section className='settings-panel'><SettingsFixture key={settingsKey}/></section><div className='composer-stack goal-session-slot'><GoalSessionPanel taskDock={<TaskFixture/>}><div className='composer-shell'><textarea aria-label='Fixture composer'/></div></GoalSessionPanel></div></main>))}
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function check(value,message){if(!value)throw Error(message)}
const query=s=>document.querySelector(s);
const settings=()=>query('[data-testid=goal-budget-settings]');
function button(label,scope=document){return [...scope.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())===label)}
async function click(label,scope=document){const n=button(label,scope);check(n,'Missing button '+label);check(!n.disabled,'Disabled button '+label);flushSync(()=>n.click());await settle();return n}
async function input(label,value,scope=document){const n=scope.querySelector('input[aria-label="'+label+'"],textarea[aria-label="'+label+'"]');check(n,'Missing input '+label);flushSync(()=>{Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}))});await settle();return n}
async function commit(label,key='Enter'){const n=settings().querySelector('input[aria-label="'+label+'"]');flushSync(()=>{if(key==='blur'){n.focus();n.blur()}else n.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}))});await settle()}
const controls=()=>calls.filter(n=>n.channel===IPC.invoke.goalsControl);
function emit(goal,identity={}){hostGoal=goal;flushSync(()=>listeners.forEach(n=>n({sessionId:'s',goal,...identity})));}
async function escape(){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle()}
const visibleTasks=()=>Boolean(query('[data-testid=task-dock-stub]')?.getClientRects().length);
window.goalProbe={async prepare(status='active',lang='en'){
 await i18n.changeLanguage(lang);useAppStore.setState({activeSessionId:'s',sessions:[{id:'s',source:'desktop',mode:'goal'}]});emit({...base,id:'preview-'+(++previewSequence),status,activeTurnId:undefined});await settle();check(query('[data-testid=goal-status-bar] [role=status]').textContent===i18n.t('autonomousGoal.status.'+status),'Preview accepted stale goal state');
},async run(){
 await settle();
 check(settings().querySelectorAll('.settings-row').length===1,'Budget must have exactly one SettingsRow');
 check(settings().querySelectorAll('input').length===2,'Budget must have exactly two inputs');
 check(!settings().querySelector('[role=switch],details'),'Budget must not have switches or Advanced');
 check(![...settings().querySelectorAll('button')].some(n=>n.textContent.includes('Save')),'Budget must not have permanent save button');
 check(settings().querySelector('input[aria-label=Turns]').value==='20','Missing fallback 20 turns');
 check(settings().querySelector('input[aria-label=Tokens]').value==='','Token default must be blank');
 check(!query('[data-testid=goal-status-bar]'),'Goal mode alone must not show goal');
 check(visibleTasks(),'Normal TaskDock must show without a current goal');
 const retained=query('[aria-label="Retained task draft"]');await input('Retained task draft','Kept across goals');
 check(!settings().querySelector('.help-icon,[role=alert],.goal-budget-help,.goal-hint'),'Budget row must not contain helper or validation text');
 for(const bad of ['-1','1.5','e','10001','9007199254740992']){await input('Turns',bad,settings());const count=saves.length;await commit('Turns');if(saves.length>count){check(saves.at(-1).defaultGoalBudget.maxTurns===null,'Invalid turns must normalize to unlimited');saveResolve();await settle()}const field=settings().querySelector('input[aria-label=Turns]');check(field.value===''&&field.placeholder==='Unlimited','Invalid draft must show Unlimited in the input');check(!settings().querySelector('[role=alert],.goal-hint'),'Invalid input showed explanatory text')}
 const savedBefore=saves.length;await input('Turns','25',settings());await input('Tokens','5000',settings());await commit('Tokens');
 check(saves.length===savedBefore+1&&settings().getAttribute('aria-busy')==='true','Enter must start awaited save');
 await commit('Tokens');check(saves.length===savedBefore+1,'Duplicate Enter started concurrent save');
 saveReject(Error('fixture save rejected'));await settle();check(settings().querySelector('input[aria-label=Turns]').value===''&&defaults.maxTurns===null,'Failed save must restore persisted values rather than fake success');check(!settings().querySelector('[role=alert],.goal-hint'),'Failure must not add a text row');
 await input('Turns','25',settings());await input('Tokens','5000',settings());await commit('Tokens','blur');saveResolve();await settle();check(defaults.maxTurns===25&&defaults.maxTokens===5000,'Blur failed to persist both values');
 check(!settings().querySelector('.goal-budget-save-status')&&!settings().textContent.includes('Goal defaults saved.'),'Successful autosave must stay silent');
 settingsKey++;render();await settle();check(settings().querySelector('input').value==='25','Saved defaults lost on remount');
 await input('Turns','0',settings());await input('Tokens','0',settings());await commit('Tokens');check(!settings().querySelector('[role=alert]'),'Zero is unlimited, not an error');saveResolve();await settle();check(defaults.maxTurns===null&&!Object.hasOwn(defaults,'maxTokens'),'Zero must normalize to explicit unlimited');await input('Turns','26',settings());await commit('Turns');saveResolve();await settle();await input('Turns','  ',settings());await input('Tokens','',settings());await commit('Tokens');saveResolve();await settle();check(defaults.maxTurns===null&&!Object.hasOwn(defaults,'maxTokens'),'Blank must persist explicit unlimited turns and omitted tokens');
 settingsKey++;render();await settle();check([...settings().querySelectorAll('input')].every(n=>!n.disabled&&n.value===''),'Blank unlimited lost on remount');
 await input('Turns','26',settings());await commit('Turns');defaults={maxTurns:77};flushSync(()=>renderSettings());await settle();saveResolve(false);await settle();check(settings().querySelector('input').value==='77'&&!settings().textContent.includes('Goal defaults saved.'),'Stale save overwrote newer props or showed success');
 defaults={maxTurns:25,maxTokens:5000};flushSync(()=>renderSettings());await settle();check(controls().length===0,'Defaults executed a goal');
 flushSync(()=>useAppStore.setState({activeSessionId:'s',sessions:[{id:'s',source:'desktop',mode:'goal'}]}));await settle();check(visibleTasks(),'Goal mode without current goal must preserve TaskDock');
 emit(base);await settle();check(!visibleTasks(),'Actual goal must hide TaskDock');check(todoData.length===1&&todoMounts===1&&todoUnmounts===0,'Goal presence removed todo data or unmounted retained task UI');
 check(listeners.size===1,'Goal visibility and header must share one subscription');
 const bar=query('[data-testid=goal-status-bar]');check(bar.textContent.includes('Running goal'),'Running status is not explicit');
 check(query('[data-testid=goal-elapsed]').textContent==='01h01m10s','Timer must derive persisted elapsed + active interval');
 now+=3000;flushSync(()=>ticks.forEach(fn=>fn()));await settle();check(query('[data-testid=goal-elapsed]').textContent==='01h01m13s','Timer did not tick from host epoch');
 const height=query('.goal-session-slot').getBoundingClientRect().height;
 const detailsButton=button('View goal details',bar);detailsButton.focus();await click('View goal details',bar);
 check(detailsButton.querySelector('.lucide-circle-ellipsis')&&!detailsButton.querySelector('.lucide-chevron-down'),'Details entry must be a circle with three dots');
 const details=query('[data-testid=goal-details-dialog]');check(details&&!query('.goal-session-slot').contains(details),'Details must portal outside measured dock');check(query('.goal-session-slot').getBoundingClientRect().height===height,'Dialog changed dock height');
 check(document.activeElement===button('Close details',details),'Dialog initial focus missing');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));check(details.contains(document.activeElement),'Focus trap failed');
 check(details.textContent.includes(base.objective)&&details.textContent.includes('not independently verified'),'Details objective/model disclaimer missing');
 await escape();check(!query('[role=dialog]')&&document.activeElement===detailsButton,'Escape lost focus');
 check(!settings().querySelector('.goal-budget-save-status'),'Saving/saved feedback must not be visible');const running=hostGoal;hostGoal=null;flushSync(()=>useAppStore.setState({activeSessionId:'timer-away',sessions:[{id:'timer-away',source:'desktop',mode:'agent'}]}));await settle();check(ticks.size===0,'View switch leaked active timer');hostGoal=running;flushSync(()=>useAppStore.setState({activeSessionId:'s',sessions:[{id:'s',source:'desktop',mode:'goal'}]}));await settle();check(query('[data-testid=goal-elapsed]').textContent==='01h01m13s'&&ticks.size===1,'View switch reset elapsed time or duplicated timer');
 const edit=await click('Edit goal');let dialog=query('[data-testid=goal-edit-dialog]');check(dialog,'Edit dialog missing');check(controls().at(-1).request.action==='pause','Opening active edit must explicitly pause');
 check(dialog.textContent.includes('Waiting for the current turn'),'Edit must expose waiting state');check(dialog.querySelector('textarea').disabled&&button('Save changes',dialog).disabled,'Editing allowed before claimed turn settled');
 emit({...hostGoal,revision:hostGoal.revision+1,activeTurnId:undefined,elapsedSeconds:3673,activeSinceMs:undefined});await settle();check(!dialog.querySelector('textarea').disabled,'Settled pause must allow edit');check(ticks.size===0,'Paused timer leaked interval');const frozen=query('[data-testid=goal-elapsed]').textContent;now+=65000;flushSync(()=>ticks.forEach(fn=>fn()));await settle();check(query('[data-testid=goal-elapsed]').textContent===frozen,'Paused time advanced');
 await input('Goal objective','Revised citation objective',dialog);await click('Dismiss',dialog);check(hostGoal.objective===base.objective&&hostGoal.status==='paused','Dismiss saved draft or resumed goal');check(document.activeElement===edit,'Edit dismissal lost trigger focus');
 await click('Edit goal');dialog=query('[data-testid=goal-edit-dialog]');await input('Goal objective','Revised citation objective',dialog);controlError=true;await click('Save changes',dialog);check(query('[data-testid=goal-edit-dialog] [role=alert]'),'Edit failure not recoverable');await click('Reload status',dialog);await click('Save changes',dialog);
 check(!query('[role=dialog]'),'Successful edit did not close');check(hostGoal.status==='paused'&&hostGoal.objective==='Revised citation objective','Edit resumed goal or lost objective');check(hostGoal.budget.maxTurns===20&&hostGoal.tokenUsage===200&&hostGoal.roundsStarted===2,'Edit changed budget or usage');check(!hostGoal.audit&&hostGoal.criteria.length===0,'Edit did not display host-cleared reports');
 check(controls().at(-1).request.expectedRevision===hostGoal.revision-1&&!Object.hasOwn(controls().at(-1).request,'budget'),'Edit lacks CAS or sent budget');
 const detailTrigger=await click('View goal details');await click('Adjust budget and resume',query('[role=dialog]'));check(query('[data-testid=goal-resume-dialog]'),'Paused budget adjustment must remain reachable from details');await escape();check(document.activeElement===detailTrigger&&hostGoal.status==='paused','Details budget dismissal resumed or lost focus');
 await click('Resume');check(!Object.hasOwn(controls().at(-1).request,'budget'),'Ordinary resume widened budget');
 emit({...hostGoal,revision:hostGoal.revision+1,status:'budget_exhausted',roundsStarted:20,budget:{maxTurns:20,maxTokens:200},activeTurnId:undefined});await settle();
 const before=controls().length;const resume=await click('Resume');dialog=query('[data-testid=goal-resume-dialog]');check(dialog&&dialog.querySelectorAll('input').length===2&&!dialog.querySelector('[role=switch],details'),'Resume must use two blankable inputs');check(button('Adjust budget and resume',dialog).disabled,'Exhausted total cap must block confirmation');await escape();check(controls().length===before&&document.activeElement===resume,'Dismissal mutated goal or lost focus');
 await click('Resume');dialog=query('[data-testid=goal-resume-dialog]');await input('Turns','21',dialog);check(button('Adjust budget and resume',dialog).disabled,'Exhausted token cap ignored');await input('Tokens','201',dialog);check(!button('Adjust budget and resume',dialog).disabled,'Sufficient total caps blocked');await input('Turns','0',dialog);await input('Tokens','0',dialog);check(!button('Adjust budget and resume',dialog).disabled,'Zero must remove both total caps');await input('Turns','e',dialog);await input('Tokens','-1',dialog);flushSync(()=>{const n=dialog.querySelector('input');n.focus();n.blur()});await settle();check([...dialog.querySelectorAll('input')].every(n=>n.value===''&&n.placeholder==='Unlimited'),'Invalid resume drafts must normalize inside fields');check(!dialog.querySelector('.goal-budget .goal-hint,[aria-invalid=true]'),'Resume showed numeric hints');check(controls().length===before,'Invalid/zero input must not resume implicitly');await click('Adjust budget and resume',dialog);check(!query('[role=dialog]'),'Resume did not close');check(hostGoal.budget.maxTurns===null&&!Object.hasOwn(hostGoal.budget,'maxTokens'),'Invalid resume budget not canonical unlimited');check(defaults.maxTurns===25,'Resume changed defaults');
 emit({...hostGoal,revision:hostGoal.revision+1,status:'completed',elapsedSeconds:9999});await settle();check(!button('Edit goal')&&!button('Pause')&&!button('Resume')&&button('Remove goal'),'Terminal actions incorrect');
 const remove=await click('Remove goal');dialog=query('[data-testid=goal-delete-dialog]');check(dialog.textContent.includes('chat and task history are retained'),'Delete confirmation lacks history guarantee');check(!dialog.querySelector('header button'),'Remove dialog must not have a header Close');check([...dialog.querySelectorAll('button')].filter(n=>n.textContent.trim()==='Dismiss').length===1,'Remove dialog needs exactly one bottom close');check(document.activeElement===button('Dismiss',dialog),'Safe close must receive initial focus');await click('Dismiss',dialog);check(hostGoal&&document.activeElement===remove,'Bottom close changed goal or lost focus');await click('Remove goal');dialog=query('[data-testid=goal-delete-dialog]');await escape();check(hostGoal&&document.activeElement===remove,'Delete dismissal mutated goal or lost focus');
 await click('Remove goal');await click('Stop and remove goal',query('[role=dialog]'));check(!query('[data-testid=goal-status-bar]')&&visibleTasks(),'Delete did not restore TaskDock');check(query('[aria-label="Retained task draft"]')===retained&&retained.value==='Kept across goals','TaskDock lost retained UI');
 check(document.activeElement===query('[aria-label="Fixture composer"]'),'Removing focused goal must return focus to composer');
 emit({...base,revision:999});await settle();check(!query('[data-testid=goal-status-bar]')&&visibleTasks(),'Late event resurrected removed goal');
 emit({...base,id:'replacement',status:'paused',activeTurnId:undefined});await settle();holdDelete=true;await click('Remove goal');await click('Stop and remove goal',query('[role=dialog]'));
 emit({...base,id:'newer',status:'paused',activeTurnId:undefined});await settle();deleteResolve();await settle();check(query('[data-testid=goal-status-bar]').textContent.includes(base.objective.slice(0,30))&&!visibleTasks(),'Old delete erased newer goal');
 await click('Edit goal');holdRead=true;hostGoal=null;flushSync(()=>useAppStore.setState({activeSessionId:'next',sessions:[{id:'next',source:'desktop',mode:'goal'}]}));await settle();check(!query('[role=dialog]')&&!query('[data-testid=goal-status-bar]')&&!visibleTasks(),'Session transition must close dialogs and fail closed while loading');readResolve({goal:null});await settle();check(visibleTasks()&&listeners.size===1,'Empty next session must restore TaskDock with one subscription');
 await this.prepare('paused');
 return {checks:['single-row two fields; invalid/zero/blank normalize to Unlimited; no hints; Enter/blur; failed save rollback and stale props','Goal-mode empty fallback; actual goal suppression + retained Todo data/UI + single subscription','backend elapsed + deterministic active ticking + paused cleanup','circle-ellipsis details + portaled bounded dialog + focus containment/Escape return','edit pause + wait activeTurn cleared + dismiss/no resume + CAS/error/retry + budget/usage/report preservation','exhausted TOTAL caps + unlimited resume + independent defaults','terminal delete + confirmation/dismiss + TaskDock restoration + retired events + late reply/new goal + session fence']};
}};
await i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:{autonomousGoal:autonomousGoalEn}},'zh-CN':{translation:{autonomousGoal:autonomousGoalZhCN}}}});
useAppStore.setState({activeSessionId:null,sessions:[],settings:{defaultMode:'goal'}});render();window.goalReady=true;
`;

test("real Goal user path: blankable defaults → attached header → pause/edit → resume → remove → retained TaskDock", {
  timeout: 240000,
  skip: process.platform === "linux" && !process.env.DISPLAY && !process.env.PI_GOAL_TEST_CHROMIUM
    ? "Electron requires a display; the Electron E2E job runs this test under Xvfb"
    : false,
}, async () => {
  const output = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "goal-ui-"));
  await build({ stdin: { resolveDir: root, contents: fixture, loader: "tsx" }, bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    outfile: path.join(output, "fixture.js"), nodePaths: [path.join(root, "apps/desktop/node_modules")], alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") }, define: { "process.env.NODE_ENV": '"production"' } });
  let css = (await readFile(path.join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?:\s+inline)?\s*\{/g, ":root {");
  for (const file of ["ui-kit.css", "settings.css", "composer.css"]) css += "\n" + await readFile(path.join(root, "apps/desktop/src/styles", file), "utf8");
  css += "\n*{box-sizing:border-box}body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary);font-family:var(--font-sans,system-ui)}main{max-width:760px;padding:16px;margin:auto}button,input{font:inherit}.btn{padding:6px 10px}main>p{font-size:var(--text-xs);color:var(--ds-text-secondary)}textarea{width:100%;height:80px}.composer-shell>textarea{display:block;background:transparent;color:inherit;border:0;padding:12px}";
  await writeFile(path.join(output, "foundation.css"), css);
  await writeFile(path.join(output, "index.html"), '<!doctype html><html data-theme="dark" lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="foundation.css"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  if (process.env.PI_GOAL_TEST_CHROMIUM) {
    const result = await probeWithChromium(process.env.PI_GOAL_TEST_CHROMIUM, output);
    assert.ok(result.checks.length >= 11);
    console.log(`Goal isolated Chromium artifacts: ${output}\n${JSON.stringify(result)}`);
    return;
  }
  await writeFile(path.join(output, "runner.cjs"), String.raw`
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();for(const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});const web=win.webContents;web.setFrameRate(60);const errors=[];
web.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
web.on('console-message',event=>{if(event.level==='error'&&!event.message.includes('Content Security Policy'))errors.push(event.message)});
try{await win.loadFile(path.join(__dirname,'index.html'));web.debugger.attach('1.3');
const {checkGoalBrowser}=await import(${JSON.stringify(pathToFileURL(path.join(root, "apps/desktop/test/goal-browser-probe.mjs")).href)});
const result=await checkGoalBrowser({js:code=>web.executeJavaScript(code,true),send:(method,params)=>web.debugger.sendCommand(method,params),viewport:async(width,height)=>{win.setContentSize(width,height)}});
assert.deepEqual(errors,['Goal defaults persistence failed Error']);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.join(__dirname,'interim.png'),(await web.capturePage()).toPNG());console.log(JSON.stringify(result));win.destroy();app.exit(0);
}catch(error){console.error(error);win.destroy();app.exit(1)}});
`);
  const { electronBinary } = resolveElectronBinary(root);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [path.join(output, "runner.cjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; }); child.stderr.on("data", (chunk) => { log += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, `Isolated Goal component browser failed (${output})\n${log}`);
  const result = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
  assert.ok(result.checks.length >= 11);
  console.log(`Goal isolated browser artifacts: ${output}\n${JSON.stringify(result)}`);
});
