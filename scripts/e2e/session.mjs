import { assert, shortJson } from "./assert.mjs";

export async function createSession(host, workspace, title, mode = "agent") {
  const response = await host.call("session.create", {
    title,
    mode,
    projectPath: workspace,
  });
  assert(
    response?.session?.id,
    "session.create returned no session: " + shortJson(response),
  );
  return response.session;
}

export async function configureSession(host, session, mode, permissionMode) {
  const response = await host.call("session.configure", {
    id: session.id,
    mode,
    permissionMode,
  });
  assert(
    response?.session?.id === session.id,
    "session.configure failed: " + shortJson(response),
  );
  return response.session;
}

export async function beginTurn(host, sessionId) {
  const response = await host.call("session.beginTurn", { sessionId });
  assert(
    response?.turnId,
    "session.beginTurn returned no turn: " + shortJson(response),
  );
  return response.turnId;
}

export async function endTurn(host, turnId, status = "completed") {
  return host.call("session.endTurn", {
    turnId,
    status,
    createNotification: false,
  });
}
