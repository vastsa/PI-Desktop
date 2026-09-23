import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { Host } from "./host.mjs";
import { PROTOCOL_VERSION } from "../../packages/shared/dist/protocol.js";

export async function withScenario(
  id,
  fn,
  binary,
  tempRoot,
  protocolVersion = PROTOCOL_VERSION,
) {
  const scenarioRoot = await mkdtemp(join(tempRoot, id.toLowerCase() + "-"));
  const dataDir = join(scenarioRoot, "data");
  const workspace = join(scenarioRoot, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const host = new Host(binary, dataDir);
  let primaryError = null;
  try {
    await host.start(protocolVersion);
    await host.call("workspace.set", { path: workspace });
    return await fn({ id, host, dataDir, workspace, scenarioRoot });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    try {
      await host.stop();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await rm(scenarioRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    } catch (error) {
      cleanupError ||= error;
    }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}
