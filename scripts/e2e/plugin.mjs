import { waitForNotification } from "./wait.mjs";
import { assert, shortJson } from "./assert.mjs";

export async function loadDevelopmentPlugin(host, path) {
  const result = await host.call("plugins.loadDev", { path });
  assert(
    result?.plugin?.id,
    "plugins.loadDev returned no plugin: " + shortJson(result),
  );
  return result.plugin;
}

export async function resolvePluginExecution(host, notification, response) {
  if (!notification) return false;
  await host.call("plugins.resolveExecution", {
    executionId: notification.params.executionId,
    ...response,
  });
  return true;
}

export async function waitForPluginExecution(host, toolName, timeoutMs = 5_000) {
  return waitForNotification(
    host.notifications,
    (notification) =>
      notification.method === "plugins.execute" &&
      notification.params?.toolName === toolName,
    timeoutMs,
  );
}
