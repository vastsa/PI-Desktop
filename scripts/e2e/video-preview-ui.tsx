import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { catalogs } from '@pi-desktop/i18n';
import { Markdown } from '../../apps/desktop/src/components/Markdown';
import '../../apps/desktop/src/styles/chat-links.css';
import { useAppStore } from '../../apps/desktop/src/stores/app-store';

declare global { var videoPreviewProbe: (path: string) => Promise<unknown>; }
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => boolean, message: string) {
  const deadline = performance.now() + 8000;
  while (!condition() && performance.now() < deadline) await painted();
  assert(condition(), message);
}

globalThis.videoPreviewProbe = async (path) => {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: catalogs.en } } });
  useAppStore.setState({ workspace: { path: '/project', name: 'Fixture' }, activeSessionId: 'fixture' });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (source: string) => flushSync(() => root.render(<I18nextProvider i18n={i18n}><Markdown source={source} /></I18nextProvider>));
  render(`[Download video](<${path}>)`);
  await until(() => Boolean(container.querySelector('video')), 'A saved video link must render an inline video player');
  const video = container.querySelector('video')!;
  await until(() => video.readyState >= 1, 'Local MP4 metadata must load under production CSP');
  assert(video.controls && video.duration > 0, 'Player has native controls and duration');
  video.muted = true;
  await video.play();
  await until(() => video.currentTime > 0, 'Playback must advance');
  video.pause();
  video.currentTime = 0.5;
  await until(() => !video.seeking && video.currentTime >= 0.5, 'Seeking must work');
  const clickSave = () => flushSync(() => container.querySelector<HTMLButtonElement>('button')!.click());
  clickSave();
  await until(() => !container.querySelector<HTMLButtonElement>('button')!.disabled && useAppStore.getState().toasts.at(-1)?.message === 'Video saved', 'Save must copy the video and show success');
  const state = await window.piDesktop!.invoke<{ saves: number; equal: boolean }>('fixture:state');
  assert(state.ok && state.data.equal, 'Saved bytes equal the original MP4');
  clickSave();
  await until(() => !container.querySelector<HTMLButtonElement>('button')!.disabled, 'Cancel returns control');
  clickSave();
  await until(() => useAppStore.getState().toasts.at(-1)?.message === 'Could not save the video. Try again.', 'Save errors must not be silent');
  const oldUrl = video.src;
  render('![Missing](/scratch/missing.mp4)');
  await until(() => Boolean(container.querySelector('[role="alert"]')), 'Missing video must show an error and retry');
  const released = await window.piDesktop!.invoke<{ status: number }>('fixture:state', { url: oldUrl });
  assert(released.ok && released.data.status === 404, 'Changing source releases its previous video lease');
  render(`![Video](<${path}>)`);
  await until(() => (container.querySelector('video')?.readyState ?? 0) >= 1, 'Image markdown video syntax must also play');
  const replay = container.querySelector('video')!;
  replay.dispatchEvent(new Event('error'));
  await until(() => Boolean(container.querySelector('[role="alert"]')), 'Decoder errors are visible');
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry preview')!;
  retry.click();
  await until(() => !container.querySelector('[role="alert"]') && (container.querySelector('video')?.readyState ?? 0) >= 1, 'Retry must restore playable media');
  render(`[File URI](file://${encodeURI(path)})`);
  await until(() => (container.querySelector('video')?.readyState ?? 0) >= 1, 'Local file URI links must be normalized, not opened as file URLs');
  render(`<video src="${path}"></video>`);
  await until(() => (container.querySelector('video')?.readyState ?? 0) >= 1, 'HTML video src uses the same contained player');
  root.unmount();
  return { ok: true, playback: true, seek: true, save: true, cancel: true, errors: true, leases: true };
};
