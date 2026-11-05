// Run with a provisioned Electron executable, not a package installer.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const diagramDir = process.env.PI_GOAL_DIAGRAM_DIR || 'goal-flow';
assert(['goal-flow', 'goal-flow-review'].includes(diagramDir));
const out = path.join(root, 'docs/artifacts', diagramDir);
assert(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR is required');
const profile = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, 'goal-diagram-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  try {
    await win.loadURL('data:text/html,<html><body style="margin:0;background:white"><main></main></body></html>');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'apps/desktop/node_modules/mermaid/dist/mermaid.min.js'), 'utf8') + ';void 0;');
    const source = fs.readFileSync(path.join(out, 'lifecycle.mmd'), 'utf8');
    const result = await win.webContents.executeJavaScript(`(async()=>{
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{fontFamily:'Arial, sans-serif',fontSize:'18px',primaryColor:'#edf2f7',primaryTextColor:'#1c2d3e',primaryBorderColor:'#65778a',lineColor:'#65778a'},flowchart:{htmlLabels:false,useMaxWidth:false,curve:'linear',nodeSpacing:45,rankSpacing:55}});
      await mermaid.parse(${JSON.stringify(source)});
      const {svg}=await mermaid.render('goalLifecycle',${JSON.stringify(source)});
      document.querySelector('main').innerHTML=svg;
      const node=document.querySelector('svg');const box=node.viewBox.baseVal;
      node.setAttribute('width',Math.ceil(box.width));node.setAttribute('height',Math.ceil(box.height));
      node.style.maxWidth='none';
      const bounds=node.getBoundingClientRect();
      const boxes=[...document.querySelectorAll('.node')].map(n=>n.getBoundingClientRect());
      const overlaps=boxes.flatMap((a,i)=>boxes.slice(i+1).filter(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
      const clipped=[...document.querySelectorAll('svg text')].filter(n=>{const b=n.getBoundingClientRect();return b.left<bounds.left-1||b.top<bounds.top-1||b.right>bounds.right+1||b.bottom>bounds.bottom+1;});
      return {svg:node.outerHTML,width:Math.ceil(box.width),height:Math.ceil(box.height),nodes:boxes.length,overlaps:overlaps.length,clipped:clipped.length};
    })()`);
    assert(result.nodes >= 15);
    assert.equal(result.overlaps,0); assert.equal(result.clipped,0);
    assert(result.width < 5000 && result.height < 5000);
    fs.writeFileSync(path.join(out,'lifecycle.svg'),result.svg);
    win.setContentSize(result.width,result.height);
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out,'lifecycle.png'),png.toPNG());
    fs.writeFileSync(path.join(out,'preview.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><title>Autonomous Goal lifecycle</title><body style="margin:24px;font:16px system-ui"><h1>Autonomous Goal lifecycle</h1><p>Architecture diagram, not an execution trace. Editable source: lifecycle.mmd.</p><img alt="Autonomous Goal lifecycle, admission gates and stopping boundaries" style="max-width:100%;height:auto" src="lifecycle.svg"></body></html>');
    fs.writeFileSync(path.join(out,'render-verification.json'),JSON.stringify({renderer:'local Mermaid in isolated Electron',network:'blocked',width:result.width,height:result.height,nodes:result.nodes,syntax:'parsed',raster:'captured',overlappingNodes:result.overlaps,clippedText:result.clipped,visualReview:'pending separate pixel inspection'},null,2)+'\n');
    console.log(JSON.stringify({result:'PASS',width:result.width,height:result.height,nodes:result.nodes}));
  } catch(error) {console.error(error);process.exitCode=1;}
  finally {clearTimeout(deadline);win.destroy();app.exit(process.exitCode || 0);}
}).catch(error=>{console.error(error);app.exit(1);});
// Scratch profiles are cleaned by the session owner after Chromium releases its files.
