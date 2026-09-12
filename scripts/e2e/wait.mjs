import { setTimeout as delay } from "node:timers/promises";

export async function waitFor(predicate, timeoutMs, label, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("timeout waiting for " + label);
}

export async function waitForNotification(
  notifications,
  predicate,
  timeoutMs = 5_000,
  intervalMs = 50,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = notifications.find(predicate);
    if (match) return match;
    await delay(intervalMs);
  }
  return null;
}
