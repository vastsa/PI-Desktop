import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { repositoryRoot, resolveElectronBinary } from '../../../scripts/e2e/boot.mjs';

const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {en} from '@pi-desktop/i18n/locales/en';
import {ConversationSettings} from './features/settings/pages/ConversationSettings';
import {SubagentPresenceBar} from './components/SubagentPresenceBar';
const items = Array.from({length:8},(_,n)=>({ id:String(n),agent:'agent-'+n,task:'Inspect inputs',detail:'Read files',model:'fixture-model',status:n<3?'running':n<7?'completed':'failed',inputTokens:18200,outputTokens:1900,turns:6,startedAt:Date.now()-24000,completedAt:null }));
let opened, stopped;
function Harness(){const [settings,set]=useState({subagentStyle:'unknown'});return <><ConversationSettings settings={settings} saveSettings={async patch=>set({...settings,...patch})}/>{settings.subagentStyle==='bar' && <div style={{overflow:'hidden'}}><SubagentPresenceBar items={items} onOpen={i=>opened=i.id} onStop={rows=>stopped=rows.map(i=>i.id).join(',')}/></div>}</>}
window.probe=async()=>{
  await i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:en}},interpolation:{escapeValue:false}});
  flushSync(()=>createRoot(document.getElementById('root')).render(<Harness/>));
  const check=(ok,msg)=>{if(!ok)throw Error(msg)};
  const until=async(fn)=>{const deadline=performance.now()+3000;while(!fn()){if(performance.now()>deadline)throw Error('timed out: '+fn+'; focus='+document.activeElement.outerHTML.slice(0,300)+'; bar='+document.querySelector('.subagent-bar')?.innerHTML.slice(0,400));await new Promise(requestAnimationFrame)}};
  const q=s=>document.querySelector(s),all=s=>[...document.querySelectorAll(s)];
  check(!q('.subagent-bar'),'unknown style must not add a row');
  const picker=q('button[aria-label="Subagent style"]');check(picker?.textContent.includes('In transcript'),'style fallback');
  flushSync(()=>picker.click()); const option=all('button').find(b=>b.textContent.trim()==='Composer bar');check(option,'select option');flushSync(()=>option.click());
  check(all('.presence-avatar').length===6 && q('.presence-more').textContent==='+2','overflow cap');
  q('.presence-avatar').focus(); await until(()=>q('.presence-card'));check(q('.presence-card').textContent.includes('↑18.2k ↓1.9k'),'usage');
  q('.presence-card footer button').click();check(opened==='0','single record');
  const more=q('.presence-more');more.focus();await until(()=>q('.presence-roster'));check(more.getAttribute('aria-controls')===q('.presence-roster').id && !q('.presence-card'),'exclusive, linked roster');
  check(all('.presence-roster section').map(g=>g.querySelectorAll('.presence-row').length).join(',')==='3,5','status groups');
  q('.presence-roster footer button').click();check(stopped==='0,1,2','stop only running workers');
  q('.presence-row').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>!q('.presence-roster'));check(document.activeElement===more && more.getAttribute('aria-expanded')==='false','Escape restores focus');
  flushSync(()=>more.click());all('.presence-row').at(-1).click();check(opened==='7','failed worker record');
  return true;
};`;

test('select bar, inspect a delegate, navigate and stop from the overflow roster', {skip: process.platform === 'linux' && !process.env.DISPLAY}, async()=>{
  const root=repositoryRoot(), temp=await mkdtemp(join(tmpdir(),'pi-presence-'));
  try {
    await build({stdin:{contents:fixture,resolveDir:join(root,'apps/desktop/src'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(temp,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'}});
    await writeFile(join(temp,'index.html'), '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
    await writeFile(join(temp,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});w.webContents.on('console-message',e=>console.error(e.message));w.show();w.focus();await w.loadFile(require('node:path').join(__dirname,'index.html'));await w.webContents.executeJavaScript('window.probe()');console.log('PASS presence');app.exit(0)}).catch(e=>{console.error(e);app.exit(1)});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const {stdout}=await promisify(execFile)(resolveElectronBinary(root).electronBinary,[join(temp,'main.cjs')],{env,timeout:30000});
    assert.match(stdout,/PASS presence/);
  } finally {await rm(temp,{recursive:true,force:true,maxRetries:5});}
});
