import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { discoverPiSkillPackages } = await import('../electron/main/pi-skill-discovery.ts');
const { generateImportedExtensionPlugin } = await import('../electron/main/agent-extensions.ts');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modules = join(root, '.pi/agent/npm/node_modules');
  const imports = join(root, 'imports');
  const write = (name, path, body) => { const target = join(modules, name, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); };
  const pkg = (name) => { write(name, 'package.json', JSON.stringify({ name, pi: { skills: ['SKILL.md'] } })); write(name, 'SKILL.md', '---\nname: planning\ndescription: Plan work\n---\nRead references/guide.md'); write(name, 'references/guide.md', '# Guide'); };
  return { root, modules, imports, write, pkg };
}
test('discovers installed plain and scoped packages without importing or executing them', async t => {
  const f = fixture(t); f.pkg('planning-with-files'); f.pkg('@scope/skills');
  f.write('planning-with-files', 'index.js', "throw new Error('must not execute')");
  const result = await discoverPiSkillPackages(f.modules);
  assert.deepEqual(result.candidates.map(c => c.name), ['@scope/skills', 'planning-with-files']);
  assert.ok(result.candidates.every(c => c.skills.length === 1 && !c.hasExtensions && !c.imported));
  assert.equal(existsSync(f.imports), false);
});
test('hidden directories inside scoped packages do not produce discovery errors', async t => {
  const f = fixture(t);
  mkdirSync(join(f.modules, '@img', '.sharp-win32-x64-temp'), { recursive: true });
  f.pkg('healthy');
  const result = await discoverPiSkillPackages(f.modules);
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['healthy']);
  assert.deepEqual(result.errors, []);
});
test('hoisted npm dependencies do not prevent discovery of installed skills', async t => {
  const f = fixture(t);
  for (let index = 0; index < 300; index++) {
    const name = `dependency-${index}`;
    f.write(name, 'package.json', JSON.stringify({ name, version: '1.0.0' }));
  }
  f.pkg('planning-with-files');
  f.pkg('@scope/skills');
  const result = await discoverPiSkillPackages(f.modules);
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['@scope/skills', 'planning-with-files']);
  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(f.imports), false);
});
test('one malformed package does not hide healthy candidates; links are not followed', async t => {
  const f = fixture(t); f.pkg('healthy'); f.write('broken', 'package.json', '{');
  symlinkSync(join(f.modules, 'healthy'), join(f.modules, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await discoverPiSkillPackages(f.modules);
  assert.deepEqual(result.candidates.map(c => c.name), ['healthy']);
  assert.ok(result.errors.some(e => e.includes('broken')));
});
test('an unreadable scope reports a diagnostic without hiding healthy packages', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = fixture(t); f.pkg('healthy');
  const blocked = join(f.modules, '@blocked');
  mkdirSync(blocked); chmodSync(blocked, 0);
  try {
    const result = await discoverPiSkillPackages(f.modules);
    assert.deepEqual(result.candidates.map(candidate => candidate.name), ['healthy']);
    assert.ok(result.errors.some(error => error.includes('@blocked') && error.includes('EACCES')));
  } finally { chmodSync(blocked, 0o755); }
});
test('existing imports remain recognized after rediscovery without a second registry', async t => {
  const f = fixture(t); f.pkg('planning-with-files');
  const imported = generateImportedExtensionPlugin(join(f.modules, 'planning-with-files'), f.imports);
  const { readFileSync } = await import("node:fs");
  const description = JSON.parse(readFileSync(join(imported.path, "manifest.json"), "utf8")).description;
  const result = await discoverPiSkillPackages(f.modules, [description]);
  assert.equal((await discoverPiSkillPackages(f.modules)).candidates[0].imported, false, "unregistered leftover directories must not block import");
  assert.equal(result.candidates[0].imported, true);
});
test('missing npm directory is empty, not a failure', async t => {
  const f = fixture(t);
  assert.deepEqual(await discoverPiSkillPackages(f.modules), { candidates: [], errors: [] });
});

const { registerPiSkillDiscoveryIpc } = await import('../electron/main/pi-skill-discovery-ipc.ts');
const { IPC } = await import('../../../packages/shared/dist/index.js');
const { PluginRuntime } = await import('../electron/main/plugin-runtime.ts');
const { fork } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
function harness(f, t, confirm = async () => ({ response: 1 })) {
  const handlers = new Map();
  const descriptions = [];
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL('../electron/main/plugin-host-process.mjs', import.meta.url)),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      return { postMessage: m => { if (child.connected) child.send(m); }, onMessage: h => child.on('message', h), onExit: h => child.on('exit', c => h(c ?? 0)), kill: () => child.kill() };
    }, audit: () => {},
  });
  t.after(async () => { for (const item of runtime.listLoaded()) await runtime.unload(item.manifest.id); runtime.disposeWatchers(); });
  registerPiSkillDiscoveryIpc({
    handle: (key, fn) => handlers.set(key, fn), importRoot: f.imports,
    bridge: { respond: () => false }, window: () => null,
    dialogs: { showMessageBox: confirm }, getLocale: () => 'en',
    getNpmPath: () => undefined, setNpmPath: () => {},
    getImportedDescriptions: async () => descriptions,
    loadDevPlugin: async path => {
      const { readFileSync } = await import("node:fs");
      // Production persists host registration before starting the plugin child.
      descriptions.push(JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).description);
      return runtime.loadFromPath(path);
    },
    runCommand: async () => ({ handled: false }),
  }, f.modules);
  return { runtime, discover: () => handlers.get(IPC.invoke.piSkillDiscover)(), enable: id => handlers.get(IPC.invoke.piSkillImport)({ id }) };
}
test('discover → cancel → confirm → read skill and resources → reload; duplicate import refused', async t => {
  const f = fixture(t); f.pkg('planning-with-files');
  let consent = false;
  const h = harness(f, t, async options => { assert.equal(options.defaultId, 0); return { response: consent ? 1 : 0 }; });
  const { candidates } = await h.discover();
  assert.deepEqual(h.runtime.getSkills(), []);
  assert.deepEqual(await h.enable(candidates[0].id), { canceled: true });
  assert.equal(existsSync(f.imports), false);
  consent = true;
  const imported = await h.enable(candidates[0].id);
  assert.equal(imported.canceled, false);
  const skill = h.runtime.getSkills()[0];
  assert.equal(skill.name, 'planning');
  assert.equal(h.runtime.loadSkillBody(skill.id).body, 'Read references/guide.md');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(imported.path, 'src/references/guide.md'), 'utf8'), '# Guide');
  assert.equal((await h.discover()).candidates[0].imported, true);
  await assert.rejects(h.enable(candidates[0].id), /already imported/);
  await h.runtime.unload(imported.id);
  assert.deepEqual(h.runtime.getSkills(), []);
  await h.runtime.loadFromPath(imported.path);
  assert.equal(h.runtime.loadSkillBody(skill.id).body, 'Read references/guide.md');
});
test('metadata change during native confirmation invalidates consent', async t => {
  const f = fixture(t); f.pkg('planning-with-files');
  const h = harness(f, t, async () => {
    f.write('planning-with-files', 'package.json', JSON.stringify({ name: 'planning-with-files', pi: { skills: ['SKILL.md'], extensions: ['index.ts'] } }));
    return { response: 1 };
  });
  const { candidates } = await h.discover();
  await assert.rejects(h.enable(candidates[0].id), /changed during confirmation/);
  assert.equal(existsSync(f.imports), false);
});
test('renderer cannot supply arbitrary paths or import concurrent confirmations', async t => {
  const f = fixture(t); f.pkg('planning-with-files');
  let release;
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const h = harness(f, t, () => new Promise(resolve => { release = resolve; opened(); }));
  await assert.rejects(h.enable('/tmp/arbitrary'), /Invalid/);
  const { candidates } = await h.discover();
  const first = h.enable(candidates[0].id);
  await ready;
  await assert.rejects(h.enable(candidates[0].id), /already in progress/);
  release({ response: 0 });
  await first;
});

test('published planning-with-files package follows discovery and confirmed import', { skip: !process.env.PI_SKILL_PACKAGE_FIXTURE }, async t => {
  const f = fixture(t);
  const { cpSync, readFileSync } = await import('node:fs');
  mkdirSync(f.modules, { recursive: true });
  cpSync(process.env.PI_SKILL_PACKAGE_FIXTURE, join(f.modules, 'planning-with-files'), { recursive: true });
  const h = harness(f, t, async options => {
    assert.match(options.detail, /executable extensions/);
    return { response: 1 };
  });
  const { candidates, errors } = await h.discover();
  assert.deepEqual(errors, []);
  assert.equal(candidates[0].hasExtensions, true);
  const imported = await h.enable(candidates[0].id);
  assert.equal(imported.dependencies.state, 'skipped');
  const skill = h.runtime.getSkills().find(s => s.name === 'pi-planning-with-files');
  assert.ok(skill, 'the reported package skill reaches the runtime catalog');
  assert.ok(h.runtime.loadSkillBody(skill.id).body.length > 100);
  assert.equal(readFileSync(join(imported.path, 'src/SKILL.md'), 'utf8'), readFileSync(join(f.modules, 'planning-with-files/SKILL.md'), 'utf8'));
  assert.equal(h.runtime.getAgentExtensions().length, 1);
});
