import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { catalogs, flattenCatalog } from '@pi-desktop/i18n';
import { IPC } from '@pi-desktop/shared';
import { ProjectMemoryDialog } from '../../src/components/ProjectMemoryDialog';

const projects = new Map([
  ['project-a', { owner: 'owner-a', enabled: false, memory: {
    content: 'Manually pinned\n\nUse pnpm\n\nRun targeted tests\n\nCheck release notes', updatedAt: 1,
    entries: [
      { id: 'entry-a', title: 'Pinned context', content: 'Manually pinned' },
      { id: 'entry-b', title: 'Package manager', content: 'Use pnpm' },
      { id: 'entry-c', title: 'Tests', content: 'Run targeted tests' },
      { id: 'entry-d', title: 'Release', content: 'Check release notes' },
    ] } }],
  ['project-b', { owner: 'owner-b', enabled: false, memory: {
    content: 'Never show in A\n\nOnly project B', updatedAt: 1,
    entries: [
      { id: 'other-a', title: 'Other project context', content: 'Never show in A' },
      { id: 'other-b', title: 'Other note', content: 'Only project B' },
    ] } }],
]);
const requests = [];
const pending = new Map();
const clone = (value) => structuredClone(value);
const editorFor = (state) => ({ owner: state.owner,
  memory: clone(state.memory), autoRecordEnabled: state.enabled });
const failure = (code, message) => ({ ok: false, error: { code, message } });
const response = (channel, input) => {
  const state = projects.get(input.projectPath);
  if (!state) return failure('NOT_FOUND', 'Unknown project');
  if (channel === IPC.invoke.projectMemoryEditorGet) return { ok: true, data: { editor: editorFor(state) } };
  if (channel === IPC.invoke.projectAutoMemorySetEnabled) {
    if (input.expectedOwner !== state.owner) return failure('CONFLICT', 'Project memory owner changed');
    state.enabled = input.enabled;
    return { ok: true, data: { autoRecordEnabled: state.enabled } };
  }
  if (channel === IPC.invoke.projectMemoryEditorSave) {
    const current = editorFor(state);
    if (input.expectedOwner !== current.owner || JSON.stringify(input.expectedMemory) !== JSON.stringify(current.memory)) {
      return failure('CONFLICT', 'Project memory changed in another session');
    }
    state.memory = { content: input.entries.map((entry) => entry.content).join('\n\n'),
      entries: clone(input.entries), updatedAt: state.memory.updatedAt + 1 };
    return { ok: true, data: { editor: editorFor(state) } };
  }
  return failure('UNKNOWN_CHANNEL', channel);
};
window.piDesktop = {
  platform: 'win32', on: () => () => {},
  invoke(channel, input) {
    const request = { channel, input: clone(input) };
    requests.push(request);
    const key = `${channel}:${input?.projectPath}`;
    if (pending.has(key)) return new Promise((resolve) => pending.get(key).push({ resolve, request,
      snapshot: channel === IPC.invoke.projectMemoryEditorGet ? response(channel, input) : null }));
    return Promise.resolve(response(channel, input));
  },
};
await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById('root'));
const alert = document.createElement('div');
alert.setAttribute('role', 'alert');
alert.setAttribute('aria-live', 'assertive');
document.body.append(alert);
const fixture = {
  requests, errors: [], saved: 0, closed: 0,
  state(path) { return clone(projects.get(path)); },
  overwrite(path, id, title) { projects.get(path).memory.entries.find((entry) => entry.id === id).title = title; },
  block(channel, path) { pending.set(`${IPC.invoke[channel]}:${path}`, []); },
  blocked(channel, path) { return pending.get(`${IPC.invoke[channel]}:${path}`)?.length ?? 0; },
  release(channel, path, error) {
    const key = `${IPC.invoke[channel]}:${path}`;
    const queue = pending.get(key);
    pending.delete(key);
    if (!queue?.length) throw new Error(`No pending request: ${key}`);
    for (const { resolve, request } of queue) resolve(error
      ? failure('INJECTED', error) : response(request.channel, request.input));
  },
  releaseOne(channel, path, index, fresh = false) {
    const key = `${IPC.invoke[channel]}:${path}`;
    const queue = pending.get(key);
    if (!queue || index >= queue.length) throw new Error(`No pending request: ${key}[${index}]`);
    const [{ resolve, request, snapshot }] = queue.splice(index, 1);
    if (!queue.length) pending.delete(key);
    resolve(fresh ? response(request.channel, request.input) : snapshot);
  },
  change(path, strict = false) {
    alert.textContent = '';
    const component = <ProjectMemoryDialog project={{ name: path, path }}
      onClose={() => { fixture.closed++; flushSync(() => root.render(null)); }}
      onSaved={() => fixture.saved++} onError={(error) => {
        fixture.errors.push(error.message);
        alert.textContent = error.message;
      }} />;
    flushSync(() => root.render(strict ? <React.StrictMode>{component}</React.StrictMode> : component));
  },
  async open(path = 'project-a') {
    this.change(path);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  },
};
window.memoryFixture = fixture;
