import { createSessionMentionService } from './service.mjs';
let service;
export function onLoad() { service = createSessionMentionService(pi); }
export function onUnload() { service?.dispose(); service = undefined; }
export function onRendererCall(method, args) {
  if (!service) throw new Error('Session Mentions is not loaded.');
  return service.call(method, args);
}
