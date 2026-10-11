/**
 * Session Mentions — bundled first-party plugin (`pi.session-mentions`).
 *
 * The headless entry answers the renderer's `plugin.call`s: it lists local
 * sessions and builds each one's recent complete Q&A through the reviewed
 * `session/list` / `session/get` read operations of `pi.desktop.invoke`.
 */
import { createSessionMentionService } from './service.js';

let service;
export function onLoad() { service = createSessionMentionService(pi); }
export function onUnload() { service?.dispose(); service = undefined; }
export function onRendererCall(method, args) {
  if (!service) throw new Error('Session Mentions is not loaded.');
  return service.call(method, args ?? {});
}
