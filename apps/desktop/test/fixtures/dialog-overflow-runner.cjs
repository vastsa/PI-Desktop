const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.setName('PI Dialog Layout Test');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message); });
  await win.loadURL(process.env.PI_DIALOG_FIXTURE_URL);
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  await evaluate(`new Promise((resolve, reject) => { const deadline = Date.now() + 10000; function check() { if (window.dialogFixture) return resolve(); if (Date.now() > deadline) return reject(new Error('fixture did not mount')); requestAnimationFrame(check); } check(); })`);
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(detail ?? '')); };
  async function measure() {
    return evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const r = dialog.getBoundingClientRect();
      const close = dialog.querySelector('.session-rename-dialog-close,.project-instructions-dialog-close,.plugins-modal-head button');
      const c = close?.getBoundingClientRect();
      const source = dialog.querySelector('.extension-prompt-source-path');
      const sourceBounds = source?.getBoundingClientRect();
      const range = document.createRange();
      if (source) range.selectNodeContents(source);
      const sourceLines = source ? [...range.getClientRects()] : [];
      return { width: r.width, height: r.height, overflow: dialog.scrollWidth - dialog.clientWidth,
        contained: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1,
        closeContained: !c || (c.left >= r.left && c.right <= r.right),
        closeHit: !c || close.contains(document.elementFromPoint(c.x + c.width/2, c.y + c.height/2)),
        sourceWrapped: !source || (sourceLines.length > 1 && sourceLines.every(line =>
          line.left >= sourceBounds.left - 1 && line.right <= sourceBounds.right + 1 &&
          line.top >= sourceBounds.top - 1 && line.bottom <= sourceBounds.bottom + 1)),
      };
    })()`);
  }
  async function click(selector) {
    const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  await evaluate('window.dialogFixture.show("extension")');
  const original = await measure();
  check('extension source fits and close is reachable', original.contained && original.overflow <= 1 && original.closeContained && original.closeHit, original);
  check('full source path wraps without clipping or changing dialog width', original.sourceWrapped && original.width <= 420, original);
  writeFileSync(join(process.env.PI_DIALOG_ARTIFACT_DIR, 'extension-path.png'), (await win.webContents.capturePage()).toPNG());
  await click('.session-rename-dialog-close');
  check('close dismisses the extension prompt', await evaluate('!document.querySelector("[role=dialog]") && window.dialogFixture.responses.length === 1'));
  await evaluate('window.dialogFixture.show("extension")');
  for (const keyCode of 'Ann') win.webContents.sendInputEvent({ type: 'char', keyCode });
  await click('button[type="submit"]');
  check('typing and submit preserve the input answer', await evaluate('window.dialogFixture.responses[0]?.value === "Ann"'));
  for (const theme of ['light','dark']) for (const request of ['input','confirm','select']) {
    win.setContentSize(520, 480);
    await evaluate('window.dialogFixture.show("extension", ' + JSON.stringify({ theme, request, longTitle: true, locale: 'zh-CN' }) + ')');
    const m = await measure();
    check(theme + ' ' + request + ' wraps long content within the viewport', m.contained && m.overflow <= 1 && m.closeContained && m.sourceWrapped, m);
    if (request === 'select') {
      await click('input[type="radio"][value="Second option"]');
      await click('button[type="submit"]');
      check(theme + ' long option still allows selecting and submitting', await evaluate('window.dialogFixture.responses[0]?.value === "Second option"'));
    } else {
      await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
      check(theme + ' ' + request + ' Escape dismisses', await evaluate('!document.querySelector("[role=dialog]")'));
    }
  }
  for (const kind of ['rename','instructions','memory','delete','install','plugin-settings','plugin-review','oauth']) {
    win.setContentSize(1100, 800);
    await evaluate('window.dialogFixture.show(' + JSON.stringify(kind) + ')');
    const m = await measure();
    check('audit ' + kind + ' long text stays bounded', m.contained && m.overflow <= 1 && m.closeContained && m.closeHit, m);
    const dismiss = kind === 'rename' ? '.session-rename-dialog-close'
      : ['instructions','memory','delete'].includes(kind) ? '.project-instructions-dialog-close'
      : kind === 'oauth' ? '.provider-dialog-actions button' : '.plugins-modal-actions button';
    await click(dismiss);
    check('audit ' + kind + ' dismissal remains operable', await evaluate('window.dialogFixture.closed && !document.querySelector("[role=dialog]")'));
  }
  writeFileSync(join(process.env.PI_DIALOG_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log('SUMMARY ' + (results.length-failed) + '/' + results.length + ' passed');
  win.destroy();app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error.stack);app.exit(1); });
