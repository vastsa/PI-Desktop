"use strict";

const { randomUUID } = require("node:crypto");
const { createStore } = require("./store.js");
const {
  SCOPES, LIMITS, fail, fields, settingsPatch, limitsFor, contentText, scopeOwner,
  visibleEntries, publicEntry, sameContext, isActive, recall, normalizeProjectPath, projectOwner,
} = require("./model.js");

/** Normalizing the title gives a stable key for same-key supersession. */
function normalizeKey(title) {
  return String(title ?? "").normalize("NFKC").trim().toLowerCase();
}

function titleText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 200 || value.includes("\0")) {
    fail("INVALID_INPUT", "Memory title must be at most 200 characters without null bytes.");
  }
  return value.trim();
  return value.trim();
}

const PROPOSAL_NOTE = "User memory can only be written by the user. This proposal is now waiting in Enhancements settings and was not saved.";
function createMemoryService(api) {
  const store = createStore(() => api.plugin.getDataPath());
  let tail = Promise.resolve();
  let disposed = false;

  function check(signal) {
    if (disposed) fail("UNAVAILABLE", "Memory is unavailable after plugin unload.");
    if (signal?.aborted) fail("CANCELLED", "The memory operation was cancelled.");
  }

  function serial(operation, signal) {
    const result = tail.then(async () => { check(signal); return operation(); });
    tail = result.catch(() => {});
    return result;
  }

  async function context(toolContext) {
    check(toolContext?.signal);
    if (toolContext && (typeof toolContext.sessionId !== "string" || !toolContext.sessionId)) {
      fail("NO_SESSION", "Memory tools require a host-bound session.");
    }
    const active = await api.session.getActive();
    if (toolContext && active?.sessionId !== toolContext.sessionId) {
      fail("SESSION_CHANGED", "The invoking session is no longer selected. Retry in that session.");
    }
    if (!active) return { sessionId: null, projectKey: null, projectLabel: null };
    const path = typeof active.projectPath === "string" && active.projectPath ? active.projectPath : null;
    // The owner key is the sidebar's grouping key, so the panel groups projects
    // exactly as the sidebar does. A label is cosmetic and never a key.
    const projectKey = projectOwner(path);
    const workspace = path ? await api.workspace.get() : null;
    const after = await api.session.getActive();
    check(toolContext?.signal);
    if (active.sessionId !== after?.sessionId || active.projectPath !== after?.projectPath) {
      fail(toolContext ? "SESSION_CHANGED" : "CONTEXT_CHANGED", "The selected session changed. Refresh memories before retrying.");
    }
    const sameFolder = workspace && normalizeProjectPath(workspace.path) === normalizeProjectPath(path);
    const label = sameFolder && workspace.name
      ? workspace.name
      : (path ? path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path : null);
    return {
      sessionId: active.sessionId,
      projectKey,
      projectLabel: projectKey ? label : null,
    };
  }

  function snapshot(data, bound) {
    return {
      ok: true,
      settings: { ...data.settings },
      context: { ...bound },
      entries: visibleEntries(data.entries, bound).filter(isActive).map(publicEntry),
      proposals: data.proposals.map(({ id, title, content, createdAt }) => ({ id, title, content, createdAt })),
      limits: {
        user: limitsFor("user"),
        project: limitsFor("project"),
      },
    };
  }

  async function guard(bound, toolContext) {
    check(toolContext?.signal);
    const current = await context(toolContext);
    if (!sameContext(bound, current)) {
      fail("CONTEXT_CHANGED", "The selected session or project changed. Refresh memories before retrying.");
    }
  }

  function requireRevision(args, entry) {
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision !== entry.revision) {
      fail("CONFLICT", "This memory changed. Refresh it before editing or deleting.");
    }
  }

  function findOwned(data, args, owner) {
    return data.entries.findIndex((entry) => entry.id === args.id
      && entry.scope === args.scope && entry.owner === owner);
  }

  /** Retire an entry without deleting it, so history and rollback survive. */
  function supersede(entry, byId, now) {
    entry.validUntil = now;
    entry.supersededBy = byId;
    entry.updatedAt = now;
  }

  function change(data, args, bound, source, remove) {
    const owner = scopeOwner(args.scope, bound);
    const limits = limitsFor(args.scope);
    if (args.id !== undefined && (typeof args.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(args.id))) {
      fail("INVALID_INPUT", "Invalid memory ID.");
    }
    if (remove && !args.id) fail("INVALID_INPUT", "A memory ID is required for deletion.");
    const now = new Date().toISOString();

    if (args.id) {
      const index = findOwned(data, args, owner);
      if (index < 0) fail("NOT_FOUND", "No memory with that ID exists in this scope.");
      const entry = data.entries[index];
      requireRevision(args, entry);
      if (remove) {
        supersede(entry, null, now);
        return { id: entry.id, deleted: true };
      }
      const content = contentText(args.content, args.scope);
      const title = args.title === undefined ? entry.title ?? "" : titleText(args.title);
      const duplicate = data.entries.some((other) => other.id !== entry.id && other.scope === args.scope
        && other.owner === owner && isActive(other) && other.content === content);
      if (duplicate) fail("CONFLICT", "This scope already contains that memory.");
      const updated = { ...entry, title, content, revision: entry.revision + 1, updatedAt: now, source };
      data.entries[index] = updated;
      return publicEntry(updated);
    }

    if (args.expectedRevision !== undefined) fail("INVALID_INPUT", "A revision requires a memory ID.");
    const content = contentText(args.content, args.scope);
    const title = titleText(args.title);
    const key = normalizeKey(title);
    const owned = data.entries.filter((entry) => entry.scope === args.scope
      && entry.owner === owner && isActive(entry));

    // Same key + same body is idempotent; same key + different body supersedes.
    const sameKey = key ? owned.filter((entry) => normalizeKey(entry.title) === key) : [];
    const identical = owned.find((entry) => entry.content === content);
    if (identical && (!key || sameKey.some((entry) => entry.id === identical.id))) return publicEntry(identical);

    const totalChars = owned.reduce((sum, entry) => sum + entry.content.length, 0);
    if (owned.length >= limits.entries || totalChars + content.length > limits.totalChars) {
      fail("CAPACITY", `This memory level is full (${limits.entries} entries / ${limits.totalChars} characters). Remove or supersede records first.`);
    }

    const entry = {
      id: randomUUID(), scope: args.scope, owner, title, content,
      revision: 1, source, createdAt: now, updatedAt: now,
      validUntil: null, supersededBy: null,
    };
    for (const stale of sameKey) supersede(stale, entry.id, now);
    data.entries.push(entry);
    return publicEntry(entry);
  }

  async function manual(args, remove) {
    fields(args, remove
      ? ["context", "scope", "id", "expectedRevision"]
      : ["context", "scope", "id", "expectedRevision", "content", "title"]);
    const bound = await context();
    if (!sameContext(args.context, bound)) {
      fail("CONTEXT_CHANGED", "The selected session or project changed. Refresh memories before retrying.");
    }
    const data = await store.read();
    change(data, args, bound, "manual", remove);
    await store.write(data, () => guard(bound));
    return snapshot(data, bound);
  }

  /**
   * User-level memories shape every future conversation, so the assistant may
   * only propose them. The proposal returns to the caller and the user writes it
   * through the panel, which keeps a bad guess from leaking everywhere.
   */
  function propose(data, args, bound) {
    const owner = scopeOwner("user", bound);
    const content = contentText(args.content, "user");
    const title = titleText(args.title);
    const duplicate = data.entries.some((entry) => entry.scope === "user" && entry.owner === owner
      && isActive(entry) && entry.content === content);
    if (duplicate) return { ok: true, duplicate: true };
    const pending = data.proposals.find((item) => item.content === content);
    if (pending) return { ok: true, proposed: true, proposal: { ...pending }, note: PROPOSAL_NOTE };
    if (data.proposals.length >= LIMITS.proposals) {
      fail("CAPACITY", "Too many unconfirmed proposals. Confirm or dismiss them in settings first.");
    }
    const proposal = { id: randomUUID(), title, content, createdAt: new Date().toISOString() };
    data.proposals.push(proposal);
    return { ok: true, proposed: true, proposal: { ...proposal }, note: PROPOSAL_NOTE };
  }

  /**
   * Turn a pending proposal into a user-level entry. The user is the author, so
   * the entry is written directly here rather than through `change`, which would
   * demand a project context the panel may not have.
   */
  function acceptProposal(data, args, now) {
    const index = data.proposals.findIndex((item) => item.id === args.id);
    if (index < 0) fail("NOT_FOUND", "That proposal is no longer pending.");
    const proposal = data.proposals[index];
    const content = contentText(proposal.content, "user");
    const identical = data.entries.find((entry) => entry.scope === "user" && entry.owner === "local-user"
      && isActive(entry) && entry.content === content);
    if (identical) {
      data.proposals.splice(index, 1);
      return { ok: true, entry: publicEntry(identical), duplicate: true };
    }
    const owned = data.entries.filter((entry) => entry.scope === "user" && entry.owner === "local-user" && isActive(entry));
    const limits = limitsFor("user");
    const totalChars = owned.reduce((sum, entry) => sum + entry.content.length, 0);
    if (owned.length >= limits.entries || totalChars + content.length > limits.totalChars) {
      fail("CAPACITY", `User memory is full (${limits.entries} entries / ${limits.totalChars} characters).`);
    }
    const key = normalizeKey(proposal.title);
    const entry = {
      id: randomUUID(), scope: "user", owner: "local-user", title: proposal.title, content,
      revision: 1, source: "manual", createdAt: now, updatedAt: now,
      validUntil: null, supersededBy: null,
    };
    if (key) {
      for (const stale of owned.filter((item) => normalizeKey(item.title) === key)) supersede(stale, entry.id, now);
    }
    data.entries.push(entry);
    data.proposals.splice(index, 1);
    return { ok: true, entry: publicEntry(entry) };
  }

  return {
    state: () => serial(async () => {
      const bound = await context();
      const data = await store.read();
      await guard(bound);
      return snapshot(data, bound);
    }),
    updateSettings: (partial) => serial(async () => {
      settingsPatch(partial);
      const bound = await context();
      const data = await store.read();
      data.settings = { ...data.settings, ...partial };
      await store.write(data, () => guard(bound));
      return snapshot(data, bound);
    }),
    acceptProposal: (args) => serial(async () => {
      fields(args, ["id", "context"]);
      const bound = await context();
      if (args.context !== undefined && !sameContext(args.context, bound)) {
        fail("CONTEXT_CHANGED", "The selected project changed. Refresh memories before retrying.");
      }
      const data = await store.read();
      acceptProposal(data, args, new Date().toISOString());
      await store.write(data, () => guard(bound));
      return snapshot(data, bound);
    }),
    rejectProposal: (args) => serial(async () => {
      fields(args, ["id"]);
      const bound = await context();
      const data = await store.read();
      const index = data.proposals.findIndex((item) => item.id === args.id);
      if (index < 0) fail("NOT_FOUND", "That proposal is no longer pending.");
      data.proposals.splice(index, 1);
      await store.write(data, () => guard(bound));
      return snapshot(data, bound);
    }),
    save: (args) => serial(() => manual(args, false)),
    remove: (args) => serial(() => manual(args, true)),
    execute: (args, ctx) => serial(async () => {
      fields(args, ["action", "scope", "query", "limit", "content", "title", "id", "expectedRevision"]);
      if (!["recall", "save", "delete"].includes(args.action)) fail("INVALID_INPUT", "Unknown memory action.");
      const read = args.action === "recall";
      fields(args, read
        ? ["action", "scope", "query", "limit"]
        : args.action === "save"
          ? ["action", "scope", "content", "title", "id", "expectedRevision"]
          : ["action", "scope", "id", "expectedRevision"]);
      const bound = await context(ctx ?? {});
      const data = await store.read();
      if (!data.settings.enabled) fail("DISABLED", "Memory is turned off. The user can enable it in Enhancements settings.");
      if (!data.settings[read ? "aiReadEnabled" : "aiWriteEnabled"]) {
        fail("DISABLED", read ? "AI memory recall is turned off." : "AI memory writes are turned off. Use manual memory management instead.");
      }
      if (!read && ctx?.mode && ctx.mode !== "agent") fail("DISABLED", "Memory writes require Agent mode.");
      if (read) {
        const result = recall(data.entries, bound, data.settings, args);
        await guard(bound, ctx);
        return result;
      }
      scopeOwner(args.scope, bound);
      if (!data.settings[`${args.scope}Enabled`]) fail("SCOPE_DISABLED", "This memory level is disabled.");
      // A user-level write from the assistant is a proposal: it is stored so the
      // user can confirm it, but it never becomes an entry on its own.
      if (args.scope === "user" && args.action === "save") {
        const proposed = propose(data, args, bound);
        if (proposed.proposed && !proposed.duplicate) await store.write(data, () => guard(bound, ctx));
        return proposed;
      }
      const result = change(data, args, bound, "ai", args.action === "delete");
      await store.write(data, () => guard(bound, ctx));
      return { ok: true, memory: result };
    }, ctx?.signal),
    dispose: () => { disposed = true; return tail; },
  };
}

module.exports = { createMemoryService };
