/** Host responses for a fresh renderer while a Desktop turn remains alive. */
export function seedRunningSessionApi(api, protocolVersion, runningSessionIds = ["running"]) {
  const sessions = ["running", "idle"].map((id) => ({
    id, title: id, source: "desktop", mode: "agent", permissionMode: "inherit",
    providerId: "provider", modelId: "model", thinkingLevel: "off", messageCount: 1,
    createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z",
  }));
  const snapshot = { sessions, ...(runningSessionIds ? { runningSessionIds } : {}) };
  Object.assign(api, {
    getSettings: async () => ({ defaultMode: "agent" }),
    getVersion: async () => ({ protocolVersion }),
    health: async () => ({ ok: true }),
    listSessions: async () => snapshot,
    listProviders: async () => ({ providers: [] }),
    getProject: async () => ({ workspace: null }),
    getOnboarding: async () => ({}),
    listPlugins: async () => ({ plugins: [] }),
    listNotifications: async () => ({ notifications: [{
      id: "old-completion", sessionId: "running", kind: "task.completed",
      createdAt: "2026-10-26T00:00:00Z", readAt: null,
    }], unreadCount: 1 }),
    pendingPlans: async () => ({ plans: [] }),
    listPluginViews: async () => [],
    listQueuedPrompts: async () => ({ entries: [] }),
    pendingInteractive: async () => ({ permissions: [], asks: [] }),
    markNotificationRead: async () => ({}),
    getSession: async (id) => ({ session: { ...sessions.find((item) => item.id === id),
      messages: [{ id: "answer", role: "assistant", content: "Working", createdAt: "2026-10-27T00:00:00Z" }],
    } }),
  });
  return snapshot;
}
