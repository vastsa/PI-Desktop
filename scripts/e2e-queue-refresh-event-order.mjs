import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, cp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveElectronBinary } from './e2e/boot.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const { build } = require('esbuild');
const { electronBinary } = resolveElectronBinary(root);
const scratch = await mkdtemp(join(tmpdir(), 'pi-queue-refresh-event-order-'));
try {
  await build({
    entryPoints: [join(root, 'scripts/e2e/queue-refresh-event-order.tsx')],
    outfile: join(scratch, 'renderer.js'), bundle: true, platform: 'browser',
    format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    alias: {
      '@pi-desktop/shared': join(root, 'packages/shared/src/index.ts'),
      '@pi-desktop/i18n': join(root, 'packages/i18n/src/index.ts'),
      react: join(root, 'apps/desktop/node_modules/react'),
      'react-dom': join(root, 'apps/desktop/node_modules/react-dom'),
    },
    nodePaths: [join(root, 'apps/desktop/node_modules')],
    plugins: [{ name: 'local-url-assets', setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: 'local-url-asset' }));
      builder.onLoad({ filter: /.*/, namespace: 'local-url-asset' }, async ({ path }) => ({ contents: await readFile(path), loader: 'file' }));
    } }],
  });
  const renderer = join(root, 'apps/desktop/out/renderer');
  const appHtml = await readFile(join(renderer, 'index.html'), 'utf8');
  const styles = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map(match => match[1]);
  assert(styles.length, 'A compatible host stylesheet is required');
  await cp(join(renderer, 'assets'), join(scratch, 'assets'), { recursive: true });
  await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>queue-refresh-event-order</title>${styles.map(path => `<link rel="stylesheet" href="${path}">`).join('')}<body><script src="renderer.js"></script>`);
  await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    const result = await window.webContents.executeJavaScript('globalThis.maintenanceProbe()');
    console.log('MAINTENANCE_RESULT ' + JSON.stringify(result));
    app.quit();
  } catch (error) { console.error(String(error?.stack ?? error)); app.exit(1); }
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(scratch, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(code, 0, output.slice(-5000));
  const line = output.split(/\r?\n/).find(line => line.startsWith('MAINTENANCE_RESULT '));
  assert(line, output.slice(-5000));
  assert.equal(JSON.parse(line.slice('MAINTENANCE_RESULT '.length)).ok, true);
  console.log('PASS queue-refresh-event-order: real Electron, production renderer/store, controlled external API');
} finally { await rm(scratch, { recursive: true, force: true }); }
