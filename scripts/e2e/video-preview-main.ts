import { app, BrowserWindow, dialog, ipcMain, net } from 'electron';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { IPC } from '@pi-desktop/shared';
import { resolveRealOpenablePath } from '@pi-desktop/host-runtime';
import { registerVideoPreviewIpc } from '../../apps/desktop/electron/main/ipc/video-preview-ipc';
import { registerPluginAssetScheme } from '../../apps/desktop/electron/main/plugin-asset-protocol';
import { VIDEO_SCHEME } from '../../apps/desktop/electron/main/video-preview';
import { resolveChatFileRef } from '../../apps/desktop/electron/main/chat-ref-resolve';

app.setPath('userData', join(__dirname, 'profile'));
registerPluginAssetScheme([{ scheme: VIDEO_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') } });
  const scratch = join(__dirname, 'scratch');
  const path = join(scratch, '海 洋.mp4');
  let saves = 0;
  // Mock only the native dialog. The real IPC, streaming and file copy remain wired.
  Object.defineProperty(dialog, 'showSaveDialog', { value: async () => {
    saves++;
    if (saves === 2) return { canceled: true };
    if (saves === 3) throw new Error('Fixture save failure');
    return { canceled: false, filePath: join(__dirname, 'saved.mp4') };
  } });
  const handleWithEvent = (channel, handler) => ipcMain.handle(channel, async (event, input) => {
    try { return { ok: true, data: await handler(event, input) }; }
    catch (error) { return { ok: false, error: { code: 'FIXTURE', message: String(error) } }; }
  });
  registerVideoPreviewIpc({ ipcMain, handleWithEvent, handle: (channel, handler) => handleWithEvent(channel, (_event, input) => handler(input)), assertMainWindowSender: (event) => { if (event.sender !== window.webContents) throw new Error('wrong sender'); } },
    (ref) => resolveRealOpenablePath(ref, null, [scratch]), () => window);
  handleWithEvent(IPC.invoke.fsResolveRef, async (_event, input) => ({ match: await resolveChatFileRef(input.ref, { project: [], scratch, attachments: join(__dirname, 'attachments') }) }));
  handleWithEvent('fixture:state', async (_event, input) => ({ saves, status: input?.url ? (await net.fetch(input.url)).status : null, equal: saves === 1 ? (await readFile(join(__dirname, 'saved.mp4'))).equals(await readFile(path)) : null }));
  window.webContents.on('console-message', (event) => console.error(event.message));
  try {
    await window.loadFile(join(__dirname, 'index.html'));
    const result = await window.webContents.executeJavaScript(`globalThis.videoPreviewProbe(${JSON.stringify(path)})`);
    console.log('VIDEO_PREVIEW_PROBE ' + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error('VIDEO_PREVIEW_PROBE ' + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
