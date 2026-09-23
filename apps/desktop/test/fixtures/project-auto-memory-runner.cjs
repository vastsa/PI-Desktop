const { app, BrowserWindow } = require('electron');

app.setName('PI Project Memory Fixture');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 730, height: 540, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message); });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const until = (expression) => evaluate(`new Promise((resolve, reject) => {
    const started = performance.now(); function check() {
      try { if (${expression}) return resolve(true); } catch (error) { return reject(error); }
      if (performance.now() - started > 8000) return reject(new Error('Timed out: ' + JSON.stringify({
        requests: window.memoryFixture?.requests.slice(-3), errors: window.memoryFixture?.errors,
        clicks: window.__fixtureClicks, events: window.__pointerEvents,
      })));
      requestAnimationFrame(check);
    } check();
  })`);
  const check = async (name, expression) => {
    if (!await evaluate(expression)) throw new Error(`FAIL ${name}: ${expression}`);
    console.log(`PASS ${name}`);
  };
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing element: ${selector}');
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const bounds = element.getBoundingClientRect();
      const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Obstructed: ${selector}');
      return { x, y, disabled: !!element.disabled };
    })()`);
    const count = await evaluate('window.__fixtureClicks');
    const pointer = window.webContents.debugger;
    await pointer.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await pointer.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await pointer.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    if (!point.disabled) await until(`window.__fixtureClicks > ${count}`);
  };
  const pressEscape = async () => {
    const pointer = window.webContents.debugger;
    await pointer.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await pointer.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  const type = async (selector, value) => {
    await click(selector);
    await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)});
      input.focus(); const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
  };
  const list = '.project-memory-dialog-list';
  const card = (index) => `${list} > [role="listitem"]:nth-child(${index})`;
  const save = '.project-memory-dialog > .project-instructions-dialog-actions button:last-child';
  const cancel = '.project-memory-dialog > .project-instructions-dialog-actions button:first-child';
  const toggle = '.project-auto-memory-toggle input[type="checkbox"]';
  const close = '.project-instructions-dialog-close';
  try {
    await window.loadURL(process.env.PI_AUTO_MEMORY_FIXTURE_URL);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.bringToFront');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until('!!window.memoryFixture');
    await evaluate(`window.__fixtureClicks = 0; window.__pointerEvents = []; window.addEventListener('click', event => { window.__fixtureClicks++; window.__pointerEvents.push('click:' + event.target.tagName) }, true)`);
    await evaluate('window.memoryFixture.open()');
    await evaluate('Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))');
    await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 4`);
    await check('one unlabelled memory list has numbered accessible controls and one global save', `
      document.querySelectorAll('${list}').length === 1 &&
      document.querySelectorAll('${list} > [role="listitem"]').length === 4 &&
      !document.querySelector('.project-memory-source, [data-source]') &&
      [...document.querySelectorAll('${list} input, ${list} textarea, ${list} button')]
        .every(element => /[^0-9][0-9]+$/.test(element.getAttribute('aria-label') || '')) &&
      document.querySelector('${card(1)} input').value === 'Pinned context' &&
      document.querySelectorAll('${save}').length === 1 && !document.querySelector('${toggle}').checked`);
    await type(`${card(1)} textarea`, 'Hand edited');
    await type(`${card(2)} input`, 'Updated package manager');
    await click(`${card(4)} .project-memory-remove`);
    await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 3`);
    await click('.project-memory-dialog-toolbar button');
    await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 4`);
    await type(`${card(4)} input`, 'New note');
    await type(`${card(4)} textarea`, 'Custom context');
    await check('edit delete and add remain staged in one memory list', `
      window.memoryFixture.state('project-a').memory.entries.length === 4 &&
      window.memoryFixture.state('project-a').memory.entries[0].content === 'Manually pinned' &&
      window.memoryFixture.state('project-a').memory.entries[1].title === 'Package manager' &&
      document.querySelector('${card(4)} input').value === 'New note' &&
      !document.querySelector('${save}').disabled`);
    await click(toggle);
    await until(`window.memoryFixture.state('project-a').enabled`);
    await check('opt-in persists immediately while preserving drafts and CAS baseline', `
      document.querySelector('${card(1)} textarea').value === 'Hand edited' &&
      document.querySelector('${card(2)} input').value === 'Updated package manager' &&
      document.querySelector('${card(4)} textarea').value === 'Custom context' &&
      !window.memoryFixture.requests.some(({channel}) => channel.endsWith('/memory/editor/save'))`);
    await click(save);
    await until(`window.memoryFixture.state('project-a').memory.entries[0].content === 'Hand edited'`);
    await check('one CAS save updates the complete memory snapshot', `(() => {
      const state = window.memoryFixture.state('project-a');
      const request = window.memoryFixture.requests.find(({channel}) => channel.endsWith('/memory/editor/save'))?.input;
      return state.memory.entries.length === 4 && state.memory.entries[3].title === 'New note' &&
        state.memory.entries[1].title === 'Updated package manager' &&
        state.memory.entries.every(entry => entry.id !== 'entry-d') &&
        request?.expectedMemory.entries[0].content === 'Manually pinned' &&
        request?.entries.length === 4 && !('manualEntries' in request) &&
        !('automaticChanges' in request) && request.entries[3].content === 'Custom context';
    })()`);
    await click(cancel);
    await evaluate(`window.memoryFixture.open('project-a')`);
    await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 4`);
    await check('reopening shows every persisted memory', `
      document.querySelector('${card(1)} textarea').value === 'Hand edited' &&
      document.querySelector('${card(2)} input').value === 'Updated package manager' &&
      document.querySelector('${card(4)} input').value === 'New note'`);

    await type(`${card(1)} textarea`, 'Unsaved first');
    await type(`${card(2)} textarea`, 'Unsaved second');
    await click(toggle);
    await until(`!window.memoryFixture.state('project-a').enabled`);
    await check('disabling stops only automatic recording, existing memory remains editable', `
      !document.querySelector('${toggle}').checked &&
      document.querySelector('${card(1)} textarea').value === 'Unsaved first' &&
      document.querySelector('${card(2)} textarea').value === 'Unsaved second' &&
      !document.querySelector('${save}').disabled &&
      window.memoryFixture.state('project-a').memory.entries[0].content === 'Hand edited' &&
      window.memoryFixture.state('project-a').memory.entries[1].content === 'Use pnpm'`);
    await click(cancel);
    await evaluate(`window.memoryFixture.open('project-a')`);
    await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 4`);
    await check('Cancel discards staged edits but does not undo switch', `
      !document.querySelector('${toggle}').checked &&
      document.querySelector('${card(1)} textarea').value === 'Hand edited' &&
      document.querySelector('${card(2)} textarea').value === 'Use pnpm'`);
    await click(`${card(4)} .project-memory-remove`);
    await click(`${card(2)} .project-memory-remove`);
    await check('removing any memories is staged until Save', `
      window.memoryFixture.state('project-a').memory.entries.length === 4 &&
      document.querySelectorAll('${list} > [role="listitem"]').length === 2`);
    await click(cancel);
    await evaluate(`window.memoryFixture.open('project-a')`);
    await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 4`);
    await check('Cancel restores removed memories', `
      document.querySelector('${card(2)} input').value === 'Updated package manager' &&
      document.querySelector('${card(4)} input').value === 'New note'`);
    await type(`${card(1)} textarea`, 'Would be rolled back');
    await type(`${card(2)} input`, 'Conflicting draft');
    await evaluate(`window.memoryFixture.overwrite('project-a', 'entry-b', 'Concurrent edit')`);
    await click(save);
    await until(`document.querySelector('[role="alert"]')?.textContent.includes('changed in another session')`);
    await check('failed CAS save changes memory unchanged and draft editable', `(() => {
      const state = window.memoryFixture.state('project-a');
      return state.memory.entries[0].content === 'Hand edited' && state.memory.entries[1].title === 'Concurrent edit' &&
        document.querySelector('${card(1)} textarea').value === 'Would be rolled back' &&
        document.querySelector('${card(2)} input').value === 'Conflicting draft' &&
        !document.querySelector('${card(2)} input').disabled;
    })()`);
    await click(cancel);
    await evaluate(`window.memoryFixture.open('project-a')`);
    await until(`document.querySelector('${card(2)} input')?.value === 'Concurrent edit'`);

    await type(`${card(1)} textarea`, 'Saved after pending');
    await type(`${card(2)} textarea`, 'New context');
    await evaluate(`window.memoryFixture.block('projectMemoryEditorSave', 'project-a')`);
    await click(save);
    await until(`window.memoryFixture.blocked('projectMemoryEditorSave', 'project-a') === 1`);
    const previousCloses = await evaluate('window.memoryFixture.closed');
    await click(close);
    await pressEscape();
    await check('close and Escape blocked during atomic save', `window.memoryFixture.closed === ${previousCloses} &&
      !!document.querySelector('[role="dialog"]')`);
    await evaluate(`window.memoryFixture.change('project-b'); window.memoryFixture.release('projectMemoryEditorSave', 'project-a')`);
    await until(`document.querySelector('${card(1)} input')?.value === 'Other project context'`);
    await check('stale save completion cannot mix projects', `
      document.querySelectorAll('${list} > [role="listitem"]').length === 2 &&
      document.querySelector('${card(2)} input').value === 'Other note' &&
      window.memoryFixture.state('project-a').memory.entries[0].content === 'Saved after pending' &&
      window.memoryFixture.state('project-a').memory.entries[1].content === 'New context' &&
      window.memoryFixture.state('project-b').memory.entries[0].content === 'Never show in A' &&
      !document.querySelector('.project-memory-dialog-toolbar button').disabled`);

    await evaluate(`window.memoryFixture.block('projectMemoryEditorGet', 'project-a'); window.memoryFixture.change('project-a')`);
    await until(`window.memoryFixture.blocked('projectMemoryEditorGet', 'project-a') === 1`);
    await evaluate(`window.memoryFixture.change('project-b'); window.memoryFixture.release('projectMemoryEditorGet', 'project-a')`);
    await until(`document.querySelector('${card(1)} input')?.value === 'Other project context'`);
    await check('late project A load cannot leak into B', `
      document.querySelectorAll('${list} > [role="listitem"]').length === 2 &&
      document.querySelector('${card(2)} input').value === 'Other note'`);
    await click(cancel);

    await evaluate(`window.memoryFixture.change('project-a')`);
    await until(`document.querySelector('${card(1)} textarea')?.value === 'Saved after pending'`);
    await type(`${card(1)} textarea`, 'Old A pending');
    await type(`${card(2)} input`, 'Old A title pending');
    await evaluate(`window.memoryFixture.block('projectMemoryEditorSave', 'project-a')`);
    await click(save);
    await until(`window.memoryFixture.blocked('projectMemoryEditorSave', 'project-a') === 1`);
    await evaluate(`window.memoryFixture.change('project-b'); window.memoryFixture.change('project-a')`);
    await until(`document.querySelector('${card(1)} textarea')?.value === 'Saved after pending'`);
    await type(`${card(1)} textarea`, 'Fresh A first draft');
    await type(`${card(2)} textarea`, 'Fresh A second draft');
    const savedBeforeLateSave = await evaluate('window.memoryFixture.saved');
    await evaluate(`window.memoryFixture.release('projectMemoryEditorSave', 'project-a')`);
    await until(`window.memoryFixture.state('project-a').memory.entries[0].content === 'Old A pending'`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await check('A to B to A late save leaves newer A drafts and busy state untouched', `
      document.querySelector('${card(1)} textarea').value === 'Fresh A first draft' &&
      document.querySelector('${card(2)} textarea').value === 'Fresh A second draft' &&
      !document.querySelector('${save}').disabled &&
      !document.querySelector('.project-memory-dialog-toolbar button').disabled &&
      window.memoryFixture.saved === ${savedBeforeLateSave}`);
    await click(cancel);
    await evaluate(`window.memoryFixture.open('project-a')`);
    await until(`document.querySelector('${card(1)} textarea')?.value === 'Old A pending'`);
    await check('completed first A save remains persisted after reopen', `
      document.querySelector('${card(2)} input').value === 'Old A title pending'`);

    await type(`${card(1)} textarea`, 'Old A switch draft');
    await evaluate(`window.memoryFixture.block('projectAutoMemorySetEnabled', 'project-a')`);
    await click(toggle);
    await until(`window.memoryFixture.blocked('projectAutoMemorySetEnabled', 'project-a') === 1`);
    await evaluate(`window.memoryFixture.change('project-b'); window.memoryFixture.change('project-a')`);
    await until(`document.querySelector('${card(1)} textarea')?.value === 'Old A pending'`);
    await type(`${card(1)} textarea`, 'Fresh toggle first draft');
    await type(`${card(2)} textarea`, 'Fresh toggle second draft');
    const savedBeforeLateToggle = await evaluate('window.memoryFixture.saved');
    await evaluate(`window.memoryFixture.release('projectAutoMemorySetEnabled', 'project-a')`);
    await until(`window.memoryFixture.state('project-a').enabled`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await check('A to B to A late toggle keeps newer A drafts and enables editing', `
      document.querySelector('${card(1)} textarea').value === 'Fresh toggle first draft' &&
      document.querySelector('${card(2)} textarea').value === 'Fresh toggle second draft' &&
      !document.querySelector('${save}').disabled &&
      !document.querySelector('.project-memory-dialog-toolbar button').disabled &&
      window.memoryFixture.saved === ${savedBeforeLateToggle}`);
    await click(cancel);
    await evaluate(`window.memoryFixture.open('project-a')`);
    await until(`document.querySelector('${toggle}')?.checked`);
    await check('toggle persists but cancelled newer A drafts do not', `
      document.querySelector('${card(1)} textarea').value === 'Old A pending' &&
      document.querySelector('${card(2)} textarea').value === 'New context'`);
    await click(cancel);
    await evaluate(`window.memoryFixture.block('projectMemoryEditorGet', 'project-a'); window.memoryFixture.change('project-a', true)`);
    await until(`window.memoryFixture.blocked('projectMemoryEditorGet', 'project-a') === 2`);
    await evaluate(`window.memoryFixture.overwrite('project-a', 'entry-b', 'Fresh entry');
      window.memoryFixture.releaseOne('projectMemoryEditorGet', 'project-a', 1, true)`);
    await until(`document.querySelector('${card(2)} input')?.value === 'Fresh entry'`);
    await evaluate(`window.memoryFixture.releaseOne('projectMemoryEditorGet', 'project-a', 0)`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await check('StrictMode stale initial response cannot overwrite fresh editor', `
      document.querySelector('${card(2)} input')?.value === 'Fresh entry'`);
    window.setContentSize(520, 480);
    await check('narrow dialog and unified list remain reachable', `(() => {
      const dialog = document.querySelector('[role="dialog"]'), bounds = dialog.getBoundingClientRect();
      const field = document.querySelector('${card(2)} input'); field.focus();
      return bounds.left >= -1 && bounds.right <= innerWidth + 1 && bounds.top >= -1 &&
        bounds.bottom <= innerHeight + 1 && dialog.scrollWidth - dialog.clientWidth <= 1 &&
        document.activeElement === field && field.tabIndex >= 0;
    })()`);
    for (const width of [520, 360]) {
      window.setContentSize(width, 480);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await check(`title and remove controls are separate and reachable at ${width}px`, `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        dialog.querySelector('.project-memory-card input').scrollIntoView({ block: 'center', behavior: 'instant' });
        return dialog.scrollWidth <= dialog.clientWidth + 1 &&
          !dialog.querySelector('.project-memory-source, [data-source]') &&
          [...document.querySelectorAll('.project-memory-card')].every(card => {
            const index = card.querySelector('.project-memory-entry-index').getBoundingClientRect();
            const field = card.querySelector('input');
            const title = field.getBoundingClientRect();
            const button = card.querySelector('.project-memory-remove');
            const remove = button.getBoundingClientRect();
            return title.width >= 60 && index.right <= title.left && title.right <= remove.left &&
              Math.abs(title.y + title.height / 2 - remove.y - remove.height / 2) < 2 &&
              field.getAttribute('aria-label')?.endsWith(String([...card.parentElement.children].indexOf(card) + 1)) &&
              button.getAttribute('aria-label')?.endsWith(String([...card.parentElement.children].indexOf(card) + 1));
          });
      })()`);
      await click(`${card(1)} input`);
      await check(`title accepts a pointer click at ${width}px`,
        `document.activeElement === document.querySelector('${card(1)} input')`);
      await click(`${card(4)} .project-memory-remove`);
      await check(`remove accepts a pointer click at ${width}px`,
        `document.querySelectorAll('${list} > [role="listitem"]').length === 3`);
      await click(cancel);
      await evaluate(`window.memoryFixture.open('project-a')`);
      await until(`document.querySelectorAll('${list} > [role="listitem"]').length === 4`);
      await evaluate('Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))');    }
    await click(close);
    await check('close remains pointer reachable at narrow width', `window.memoryFixture.closed > ${previousCloses}`);
  } finally {
    window.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
