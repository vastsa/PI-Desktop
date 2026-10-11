import { displayTitle, isZh, normalizeSessionId } from './lib/references.js';
import { ownTypedText } from './lib/prompt.js';
import { pairCompletedQaTurns } from './lib/qa.js';
import { readSessionReferenceSource } from './lib/reader.js';
import {
  budgetPercent, buildSessionSnapshot, DEFAULT_BUDGET_PERCENT, MARK_SEND_MAX_BYTES, MAX_TURNS_CHOICES,
  maxTurnsOf, referenceBudget,
} from './lib/snapshot.js';

/** Rows one `@` list offers; also the host's mark limit per draft. */
export const MAX_ROWS = 8;
/** `plugin.call` answers are capped at 64KB by the host; stay well under it. */
export const ANSWER_MAX_BYTES = 56 * 1024;
/** The host gives a trigger 2s and a `plugin.call` 2s; one answer never takes longer. */
export const MAX_CALL_DEADLINE_MS = 1_500;
export const PAGE_LIMIT = 400;
/** Longest single message read; anything longer cannot fit in a mark anyway. */
export const CONTENT_LIMIT = 40_000;
export const MAX_PAGES = 4;
const LIST_TTL_MS = 3_000;
const SNAPSHOT_CACHE_MAX = 64;
const LABEL_MAX_CHARS = 64;
const DETAIL_MAX_CHARS = 256;
/** Characters of the first question shown on a row. */
export const SNIPPET_MAX_CHARS = 40;
/** Rows read from the start of a long session to find its first turn and question. */
export const FIRST_PAGE_LIMIT = 48;

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const oneLine = (text) => String(text ?? '').replace(/[\uE000-\uF8FF\uFFFC]/g, '')
  .replace(/[\r\n\u2028\u2029\s]+/g, ' ').trim();

function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** A mark label: one line, no chip tokens, at most 64 characters; `suffix` is never cut. */
export function markLabel(title, id, suffix = '') {
  const text = oneLine(title) || `Session ${id.slice(0, 8)}`;
  return suffix ? `${clip(text, LABEL_MAX_CHARS - Array.from(suffix).length)}${suffix}` : clip(text, LABEL_MAX_CHARS);
}

const pad = (n) => String(n).padStart(2, '0');

/** `MM-DD HH:mm` in the machine's local time, or '' for an unreadable time. */
export function shortStamp(updatedAt) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Labels for the rows of one list, untitled sessions named as the app names
 * them in `lang`. Sessions sharing a title (e.g. several "new task") get their short update time, and the id's first four
 * characters if that still collides; a unique title stays as it is, so the
 * chip in the draft is just the title.
 */
export function rowLabels(input, lang) {
  const rows = input.map((row) => ({ ...row, title: displayTitle(row.title, lang) }));
  const base = rows.map((row) => markLabel(row.title, row.id));
  const count = (labels) => labels.reduce((map, label) => map.set(label, (map.get(label) ?? 0) + 1), new Map());
  const firstPass = count(base);
  const stamped = rows.map((row, i) => {
    if (firstPass.get(base[i]) === 1) return base[i];
    const stamp = shortStamp(row.updatedAt);
    return stamp ? markLabel(row.title, row.id, ` · ${stamp}`) : base[i];
  });
  const secondPass = count(stamped);
  return rows.map((row, i) => secondPass.get(stamped[i]) === 1 ? stamped[i]
    : markLabel(row.title, row.id, `${stamped[i] === base[i] ? '' : ` · ${shortStamp(row.updatedAt)}`} #${row.id.slice(0, 4)}`));
}

/** How long ago a session was updated, short and localized. */
export function relativeTime(updatedAt, locale, nowMs = Date.now()) {
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return '';
  const zh = isZh(locale);
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return zh ? `${days} 天前` : `${days} d ago`;
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The user's own words of a question, one line, quoted and short; '' when there are none. */
export function questionSnippet(text) {
  const line = oneLine(ownTypedText(String(text ?? '')));
  return line ? `“${clip(line, SNIPPET_MAX_CHARS)}”` : '';
}

function words(locale) {
  return isZh(locale) ? {
    turns: (n) => `${n} 轮问答`, first: (n) => n > 1 ? `首轮 + 最近 ${n - 1} 轮` : '仅首轮',
    omitted: (n) => `省略 ${n} 轮更早的`, between: (n) => `中间省略 ${n} 轮`,
    unread: '更早的未读取', betweenUnread: '中间部分未读取', clipped: '已截断',
    contextFull: (raise) => raise ? '上下文剩余不足：先 /compact 压缩，或在 设置 › AI 里调高引用预算'
      : '上下文快满了，先 /compact 压缩再引用',
  } : {
    turns: (n) => `${n} Q&A turn${n === 1 ? '' : 's'}`,
    first: (n) => n > 1 ? `first + ${n - 1} most recent turn${n === 2 ? '' : 's'}` : 'first turn only',
    omitted: (n) => `${n} older omitted`, between: (n) => `${n} between omitted`,
    unread: 'older history not read', betweenUnread: 'some turns between not read', clipped: 'clipped',
    contextFull: (raise) => raise
      ? 'Not enough context left: run /compact, or raise the reference budget in Settings › AI'
      : 'Context is nearly full: run /compact first, then reference this session again',
  };
}

/**
 * What a row sends when not even one complete turn fits the current context:
 * a one-line note, never a clipped snapshot, so a pick made anyway is harmless.
 */
export function contextFullNote(title) {
  const name = String(title ?? '').replace(/[\uE000-\uF8FF\uFFFC]/g, '').replace(/[\r\n"]+/g, ' ').trim();
  return `[Session "${name}" was not attached: the current context is nearly full. Run /compact, then reference it again.]`;
}

/** The row hint for a context-full session; suggests a larger budget unless it is already 100%. */
export function contextFullDetail(locale, percent = DEFAULT_BUDGET_PERCENT) {
  return words(locale).contextFull(budgetPercent(percent) < 100);
}

export function snapshotDetail(snapshot, locale, snippet = '') {
  const w = words(locale);
  const parts = [...(snippet ? [snippet] : [])];
  const partial = snapshot.omittedKnown > 0 || snapshot.unread;
  if (snapshot.firstTurn && partial) {
    parts.push(w.first(snapshot.includedTurns));
    if (snapshot.omittedKnown > 0) parts.push(w.between(snapshot.omittedKnown));
    if (snapshot.unread) parts.push(w.betweenUnread);
  } else {
    parts.push(w.turns(snapshot.includedTurns));
    if (snapshot.omittedKnown > 0) parts.push(w.omitted(snapshot.omittedKnown));
    if (snapshot.unread) parts.push(w.unread);
  }
  if (snapshot.clipped) parts.push(w.clipped);
  return Array.from(parts.join(' · ')).slice(0, DETAIL_MAX_CHARS).join('');
}

/** Whitelist Q&A fields at the host boundary; never forward thinking or tool payloads. */
export function referencePage(value, expectedId) {
  const id = normalizeSessionId(value?.id ?? value?.sessionId);
  if (!id || id !== expectedId || !Array.isArray(value?.messages)) {
    throw new Error('The referenced session returned an invalid transcript page.');
  }
  const messages = [];
  for (const row of value.messages) {
    if (!row || typeof row !== 'object') throw new Error('Invalid transcript row.');
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (row.parentToolCallId) continue;
    if (row.content !== undefined && typeof row.content !== 'string') {
      throw new Error('The host did not provide plain-text message content.');
    }
    messages.push({
      ...(typeof row.id === 'string' ? { id: row.id } : {}),
      role: row.role, content: row.content ?? '',
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(row.contentTruncated ? { contentTruncated: true } : {}),
      ...(Array.isArray(row.attachments) && row.attachments.length ? { attachments: [{}] } : {}),
    });
  }
  return { id, title: typeof value.title === 'string' ? value.title : id, messages,
    messageStart: value.messageStart, messageEnd: value.messageEnd,
    hasMoreBefore: value.hasMoreBefore ?? false };
}

/**
 * The plugin process side of the `@` trigger. All I/O goes through the
 * reviewed `pi.desktop.invoke` read operations `session/list` and
 * `session/get`; no file-system, database or renderer-store access.
 *
 * A trigger row has to carry its mark text up front, so snapshots are built
 * ahead of the pick. Transcripts are cached by `id@updatedAt`; a snapshot's
 * key adds the byte budget and turn limit it was built for
 * (`id@updatedAt#bytes/turns`), so the renderer's copies stay valid exactly
 * as long as the session and both limits do. An answer holds as many
 * snapshots as fit its size and time budget; the rest are reported pending
 * and keep building, so the renderer can ask again.
 *
 * Both limits are the host's Settings › AI › Session references preferences,
 * which the renderer passes on from the trigger query
 * (`args.references = { budgetPercent, maxTurns }`); without them 25 % and
 * 10 turns. The budget is that share of the current session's remaining
 * context (the query's `context`), capped at the 32 KB mark limit; see
 * `referenceBudget`.
 */
export function createSessionMentionService(host, options = {}) {
  const maxBytes = options.maxBytes ?? MARK_SEND_MAX_BYTES;
  const answerMaxBytes = options.answerMaxBytes ?? ANSWER_MAX_BYTES;
  let disposed = false;
  let list = null;
  const sources = new Map();
  const building = new Map();
  const controller = new AbortController();
  const check = () => { if (disposed) throw new Error('Session Mentions was unloaded.'); };
  const invoke = async (operation, args = []) => {
    check();
    const value = await host.desktop.invoke({ operation, args });
    check();
    return value;
  };

  const summaries = async () => {
    if (list && now() - list.at < LIST_TTL_MS) return list.rows;
    const result = await invoke('session/list');
    if (!Array.isArray(result?.sessions)) throw new Error('Session list is unavailable.');
    const rows = [];
    for (const row of result.sessions) {
      const id = normalizeSessionId(row?.id);
      if (!id || row.scheduledRun || (row.source && row.source !== 'desktop')) continue;
      const updatedAt = String(row.updatedAt ?? '');
      rows.push({ id, title: typeof row.title === 'string' ? row.title : '', updatedAt, key: `${id}@${updatedAt}` });
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    list = { at: now(), rows };
    return rows;
  };

  /**
   * The UI language the host passed with the query (`args.locale`, what the
   * app is drawn in); else the host's app locale, read afresh each time.
   */
  const localeOf = async (args) => typeof args.locale === 'string' && args.locale ? args.locale
    : await Promise.resolve(host.app?.getLocale?.()).catch(() => '') ?? '';

  const loadPage = async (id, before, signal) => {
    signal.throwIfAborted();
    const answer = await invoke('session/get', [{ id, messageLimit: PAGE_LIMIT, contentLimit: CONTENT_LIMIT,
      ...(before === undefined ? {} : { messageBefore: before }) }]);
    signal.throwIfAborted();
    if (!answer?.session) return null;
    return referencePage(answer.session, id);
  };

  const remember = (key, value) => {
    sources.delete(key);
    sources.set(key, value);
    while (sources.size > SNAPSHOT_CACHE_MAX) sources.delete(sources.keys().next().value);
  };

  /**
   * The session's start, when the transcript read does not reach it (the
   * reader pages backwards from the newest rows): one read of its first rows
   * gives the first complete Q&A turn (only once a later question closes it,
   * or the read covers the whole session) and the first question with words
   * the user typed (a message that only carried referenced chats falls
   * through to the next one) for the row's second line. Best effort: either
   * may be missing, and the reference then starts at the newest turns.
   */
  const startOf = async (id, source) => {
    const fromRows = (messages) => messages.find((message) => message.role === 'user' &&
      !message.parentToolCallId && questionSnippet(message.content))?.content;
    if (!source.hasMoreBefore) return { firstQuestion: fromRows(source.messages) ?? '' };
    try {
      const answer = await invoke('session/get', [{ id, messageBefore: FIRST_PAGE_LIMIT,
        messageLimit: FIRST_PAGE_LIMIT, contentLimit: CONTENT_LIMIT }]);
      if (answer?.session) {
        const page = referencePage(answer.session, id);
        const turns = pairCompletedQaTurns(page.messages);
        const closed = turns.length > 1 || page.messages.at(-1)?.role === 'user'
          || answer.session.messages.length < FIRST_PAGE_LIMIT;
        return {
          ...(closed && turns.length ? { firstTurn: turns[0] } : {}),
          firstQuestion: fromRows(page.messages) ?? fromRows(source.messages) ?? '',
        };
      }
    } catch {
      // fall back to what was read
    }
    return { firstQuestion: fromRows(source.messages) ?? '' };
  };

  /** Read (once) the transcript of one row; failures are cached as `null` until the session changes. */
  const read = (row) => {
    if (sources.has(row.key)) return Promise.resolve(sources.get(row.key));
    const running = building.get(row.key);
    if (running) return running;
    const work = (async () => {
      try {
        const source = await readSessionReferenceSource(row.id, loadPage, {
          // Enough for the largest turn limit, so one read serves every setting.
          budgetTokens: Math.ceil(maxBytes / 3), enoughTurns: Math.max(...MAX_TURNS_CHOICES) + 1,
          maxPages: MAX_PAGES, signal: controller.signal,
        });
        if (!source) return null;
        return { ...source, title: source.title || row.title, ...await startOf(row.id, source) };
      } catch (error) {
        if (disposed) throw error;
        return null;
      }
    })().then((source) => {
      if (!disposed) remember(row.key, source);
      return source;
    }).finally(() => building.delete(row.key));
    building.set(row.key, work);
    return work;
  };

  /** The row's mark text for this answer's budget; pure, from the cached transcript. */
  const snapshotOf = (source, budget) => {
    const contextBytes = budget.contextBound ? budget.bytes : undefined;
    const { maxTurns } = budget;
    let snapshot = buildSessionSnapshot(source, { maxBytes, maxTurns, contextBytes });
    // JSON escaping must not push one snapshot past the answer budget.
    for (let limit = maxBytes; snapshot.status === 'ready' && jsonBytes(snapshot.send) > answerMaxBytes - 1024 && limit > 2048;) {
      limit = Math.floor(limit * 0.75);
      snapshot = buildSessionSnapshot(source, { maxBytes: limit, maxTurns, contextBytes });
    }
    return snapshot;
  };
  const keyOf = (row, budget) => `${row.key}#${budget.bytes}/${budget.maxTurns}`;

  /** No complete Q&A turn to reference (a new or unanswered session, often the current one). */
  const empty = (source) => pairCompletedQaTurns(source.messages).length === 0;
  /** Known to have nothing to reference: unreadable, or no complete turn. */
  const hidden = (row) => sources.has(row.key) && (!sources.get(row.key) || empty(sources.get(row.key)));

  /** As many ready snapshots of `rows` as fit; the rest pending. */
  const pack = async (rows, deadlineMs, budget, lang) => {
    const until = now() + deadlineMs;
    const all = Promise.all(rows.map((row) => read(row).catch(() => null)));
    await Promise.race([all, sleep(Math.max(0, until - now()))]);
    const ready = [];
    const pending = [];
    let used = 1024;
    for (const row of rows) {
      const key = keyOf(row, budget);
      if (!sources.has(row.key)) { pending.push(key); continue; }
      const source = sources.get(row.key);
      if (!source || empty(source)) continue;
      let snapshot;
      try { snapshot = snapshotOf(source, budget); } catch { continue; }
      const entry = snapshot.status === 'context-full'
        ? { key, send: contextFullNote(source.title), detail: contextFullDetail(lang, budget.percent), contextFull: true }
        : { key, send: snapshot.send, detail: snapshotDetail(snapshot, lang, questionSnippet(source.firstQuestion)) };
      const size = jsonBytes(entry);
      if (used + size > answerMaxBytes) { pending.push(key); continue; }
      used += size;
      ready.push(entry);
    }
    return { snapshots: ready, pending };
  };

  const deadlineOf = (args) => {
    const value = Number(args.deadlineMs);
    return Number.isFinite(value) ? Math.min(MAX_CALL_DEADLINE_MS, Math.max(0, value)) : MAX_CALL_DEADLINE_MS;
  };
  /**
   * This answer's limits: the host's turn limit, and its budget share of the
   * remaining context the renderer passed on (`args.context`, the trigger
   * query's figures), or the mark limit when there are none.
   */
  const budgetOf = (args) => {
    const references = args.references && typeof args.references === 'object' ? args.references : {};
    const percent = budgetPercent(references.budgetPercent);
    const context = args.context && typeof args.context === 'object' ? args.context : undefined;
    return { ...referenceBudget(context, percent, maxBytes), percent, maxTurns: maxTurnsOf(references.maxTurns) };
  };
  const keysOf = (value) => new Set(Array.isArray(value)
    ? value.filter((key) => typeof key === 'string' && key.length <= 128).slice(0, 64) : []);

  return {
    dispose() {
      disposed = true;
      controller.abort(new Error('Session Mentions was unloaded.'));
      sources.clear();
      building.clear();
    },
    async call(method, args = {}) {
      check();
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments.');
      if (method === 'sessions.items') {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase().slice(0, 256) : '';
        const cached = keysOf(args.cached);
        // The session being typed in, when the host told the renderer: it cannot reference itself.
        const exclude = normalizeSessionId(args.exclude);
        const lang = await localeOf(args);
        const rows = (await summaries())
          .filter((row) => row.id !== exclude && !hidden(row)
            && `${row.title}\n${displayTitle(row.title, lang)}\n${row.id}`.toLowerCase().includes(query))
          .slice(0, MAX_ROWS);
        const budget = budgetOf(args);
        const packed = await pack(rows.filter((row) => !cached.has(keyOf(row, budget))), deadlineOf(args), budget, lang);
        // Sessions found empty while packing leave the list before labels are disambiguated.
        const visible = rows.filter((row) => !hidden(row));
        const labels = rowLabels(visible, lang);
        return {
          rows: visible.map((row, i) => ({ key: keyOf(row, budget), label: labels[i], when: relativeTime(row.updatedAt, lang) })),
          ...packed,
        };
      }
      if (method === 'sessions.snapshots') {
        const wanted = keysOf(args.keys);
        const budget = budgetOf(args);
        const rows = (await summaries()).filter((row) => wanted.has(keyOf(row, budget)));
        return pack(rows, deadlineOf(args), budget, await localeOf(args));
      }
      throw new Error(`Unknown Session Mentions method: ${method}`);
    },
  };
}
