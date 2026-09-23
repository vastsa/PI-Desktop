import { collectSessionReferenceIds, normalizeSessionId } from './dist/references.js';
import { prepareReferencedMessage } from './dist/prepare.js';
import { budgetPercent, referenceBudget, referencePage } from './context.mjs';

/** All I/O is through the reviewed host API; no file-system/database/global-store access. */
export function createSessionMentionService(host) {
  let disposed = false;
  const active = new Set();
  const check = () => { if (disposed) throw new Error('Session Mentions was unloaded.'); };
  const invoke = async (operation, args = []) => {
    check();
    const value = await host.desktop.invoke({ operation, args });
    check();
    return value;
  };
  const summaries = async () => {
    const result = await invoke('session/list');
    if (!Array.isArray(result?.sessions)) throw new Error('Session list is unavailable.');
    return result.sessions.filter((row) => normalizeSessionId(row.id) &&
      (!row.source || row.source === 'desktop'));
  };
  return {
    dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      active.clear();
    },
    async call(method, args = {}) {
      check();
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments.');
      if (method === 'sessions.search') {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase().slice(0, 256) : '';
        const exclude = normalizeSessionId(args.sessionId);
        const rows = (await summaries()).filter((row) => normalizeSessionId(row.id) !== exclude &&
          `${row.title}\n${row.id}`.toLowerCase().includes(query));
        rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
        return { items: rows.slice(0, 30).map((row) => ({ id: normalizeSessionId(row.id), title: row.title || row.id })),
          truncated: rows.length > 30 };
      }
      if (method === 'sessions.labels') {
        const ids = new Set(Array.isArray(args.ids) ? args.ids.map(normalizeSessionId).filter(Boolean).slice(0, 100) : []);
        return (await summaries()).filter((row) => ids.has(normalizeSessionId(row.id)))
          .map((row) => ({ id: normalizeSessionId(row.id), title: row.title || row.id }));
      }
      if (method === 'sessions.open') {
        const id = normalizeSessionId(args.id);
        if (!id) throw new Error('Invalid session identity.');
        // This explicit click is the only write action this service performs.
        return invoke('session/open', [id]);
      }
      if (method === 'references.validate') {
        if (typeof args.text !== 'string') throw new Error('Missing draft text.');
        const ids = collectSessionReferenceIds(args.text, [], args.sessionId);
        if (!ids.length) return { ok: true };
        const settings = await host.plugin.getSettings();
        check();
        const controller = new AbortController();
        active.add(controller);
        try {
          const result = await prepareReferencedMessage(args.text, {
            excludeSessionId: args.sessionId,
            budgetTokens: referenceBudget(args.text, args, budgetPercent(settings.budgetPercent)),
            signal: controller.signal,
            loadPage: async (id, before, signal) => {
              signal.throwIfAborted();
              const answer = await invoke('session/get', [{ id, messageLimit: 400,
                ...(before === undefined ? {} : { messageBefore: before }) }]);
              signal.throwIfAborted();
              if (!answer?.session) return null;
              return referencePage(answer.session, id);
            },
          });
          // Validation never returns conversation contents to the renderer.
          return result.status === 'ready' ? { ok: true } : { ok: false, reason: result.reason };
        } finally { active.delete(controller); }
      }
      throw new Error(`Unknown Session Mentions method: ${method}`);
    },
  };
}
