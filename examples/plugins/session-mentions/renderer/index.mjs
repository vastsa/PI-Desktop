import { createElement as h, useEffect, useState } from 'react';
import { collectSessionReferenceIds } from '../dist/references.js';

const words = (locale) => locale?.toLowerCase().startsWith('zh') ? {
  sessions: '会话', loading: '正在查找会话…', more: '结果较多，请输入更完整的标题。',
  unavailable: '会话不可用', changed: '草稿或光标已变化，请重新选择。',
} : { sessions: 'Sessions', loading: 'Finding sessions…', more: 'Type a longer title to narrow the results.',
  unavailable: 'Session unavailable', changed: 'The draft or cursor changed. Select the session again.' };

function CompletionSource({ mode, query, sessionId, acceptText, dispatch, locale }) {
  const [state, setState] = useState({ key: '', items: [], loading: false });
  const key = JSON.stringify([mode, query, sessionId]);
  useEffect(() => {
    if (mode !== 'file') return;
    let alive = true;
    setState({ key, items: [], loading: true });
    const timer = setTimeout(() => {
      dispatch('plugin.call', { method: 'sessions.search', args: { query, sessionId } })
        .then((result) => { if (alive) setState({ key, ...result, loading: false }); })
        .catch((error) => { if (alive) setState({ key, items: [], error: String(error.message ?? error) }); });
    }, 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [key, mode, query, sessionId, dispatch]);
  if (mode !== 'file') return null;
  const copy = words(locale);
  const current = state.key === key ? state : { items: [], loading: true };
  const select = (id) => {
    if (!acceptText?.(`@session:${id} `)) {
      void dispatch('ui.toast', { message: copy.changed, variant: 'error' }).catch(() => {});
    }
  };
  return h('section', { className: 'session-mentions-list', 'aria-label': copy.sessions },
    h('strong', null, copy.sessions),
    current.loading ? h('span', { role: 'status' }, copy.loading) : null,
    current.error ? h('span', { role: 'alert' }, current.error) : null,
    current.items.map((item) => h('button', { key: item.id, type: 'button', className: 'pi-slot-btn',
      title: item.id, onMouseDown: (event) => { event.preventDefault(); select(item.id); },
      onClick: (event) => { if (event.detail === 0) select(item.id); } }, item.title)),
    current.truncated ? h('small', null, copy.more) : null);
}

function ReferenceChips({ draft, sessionId, dispatch, locale }) {
  const ids = collectSessionReferenceIds(draft ?? '', [], sessionId);
  const key = ids.join(',');
  const [labels, setLabels] = useState({ key: '', rows: [] });
  useEffect(() => {
    let alive = true;
    if (!key) return;
    dispatch('plugin.call', { method: 'sessions.labels', args: { ids: key.split(',') } })
      .then((rows) => { if (alive) setLabels({ key, rows }); })
      .catch(() => { if (alive) setLabels({ key, rows: [] }); });
    return () => { alive = false; };
  }, [key, dispatch]);
  if (!ids.length) return null;
  const current = new Map((labels.key === key ? labels.rows : []).map((row) => [row.id, row.title]));
  return h('div', { className: 'session-mentions-chips', 'aria-label': words(locale).sessions },
    ids.map((id) => h('button', { key: id, type: 'button', className: 'pi-slot-chip pi-slot-btn', title: id,
      onClick: () => { void dispatch('plugin.call', { method: 'sessions.open', args: { id } })
        .catch((error) => dispatch('ui.toast', { message: String(error.message ?? error), variant: 'error' }).catch(() => {})); },
    }, current.get(id) ?? (labels.key === key ? `${words(locale).unavailable}: ${id}` : id))));
}

export function onLoad(pi) {
  pi.ui.injectStyle(`
    .session-mentions-list { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.5rem; color: var(--pi-slot-text); }
    .session-mentions-list button { text-align: start; overflow-wrap: anywhere; }
    .session-mentions-chips { display: flex; flex-wrap: wrap; gap: 0.375rem; padding: 0.25rem; }
  `);
  pi.slots.register('completionSource', CompletionSource);
  pi.slots.register('composerReference', ReferenceChips, {
    validateSend: async ({ text, sessionId, contextWindow, usedTokens, maxOutputTokens, hasAttachments, steering, signal, dispatch }) => {
      if (!collectSessionReferenceIds(text, [], sessionId).length) return { ok: true };
      signal.throwIfAborted();
      const result = await dispatch('plugin.call', { method: 'references.validate', args: {
        text, sessionId, contextWindow, usedTokens, maxOutputTokens, hasAttachments, steering,
      } });
      signal.throwIfAborted();
      return result;
    },
  });
}
