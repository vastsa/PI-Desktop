/** Non-serializable origin for calls routed through the internal control gateway. */
const automationRequests = new WeakSet<object>();
export function markAutomationRequest(request: unknown): void {
  if (request && typeof request === "object") automationRequests.add(request);
}
export function isAutomationRequest(request: object): boolean {
  return automationRequests.has(request);
}
