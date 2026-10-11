/**
 * The transcript card for a sent reference (`blockRenderer` for the
 * `pi.session-mentions:chat` fence). The block reaches the model unchanged;
 * the chat window only shows one line (the session title, the turns
 * included or left out, the approximate size) until the user opens it.
 * Copying the message copies its source, so the full block is never lost.
 */
import { createElement as h, useState } from 'react';
import { displayTitle, isZh } from './lib/references.js';

const OPEN_TAG = /^\s*<referenced-chat\b([^>]*)>/;
const encoder = new TextEncoder();

function attribute(attributes, name) {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined ? undefined : value.replaceAll('&quot;', '"').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/** What the card head shows, read from the block's opening tag; `null` when the fence holds no block. */
export function parseReference(source) {
  const match = OPEN_TAG.exec(String(source ?? ''));
  if (!match) return null;
  const attributes = match[1];
  return {
    id: attribute(attributes, 'id') ?? '',
    title: attribute(attributes, 'title') || attribute(attributes, 'id') || '',
    turns: count(attribute(attributes, 'turns')),
    firstTurn: attribute(attributes, 'first-turn') === 'true',
    omitted: count(attribute(attributes, 'omitted')),
    unread: attribute(attributes, 'unread') === 'true' || attribute(attributes, 'older-unread') === 'true',
    clipped: /some text was clipped to fit/.test(String(source)),
    bytes: encoder.encode(String(source)).length,
  };
}

const kb = (bytes) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;

/** The card's facts line, in the app's language (`zh*` or English). */
export function referenceFacts(info, lang) {
  const zh = isZh(lang);
  const partial = info.omitted > 0 || info.unread;
  const parts = [];
  if (zh) {
    parts.push(info.firstTurn && partial ? `首轮 + 最近 ${Math.max(0, info.turns - 1)} 轮` : `${info.turns} 轮问答`);
    if (info.omitted > 0) parts.push(info.firstTurn ? `中间省略 ${info.omitted} 轮` : `省略 ${info.omitted} 轮`);
    if (info.unread) parts.push(info.firstTurn ? '中间部分未读取' : '更早的未读取');
    if (info.clipped) parts.push('已截断');
    parts.push(`约 ${kb(info.bytes)}`);
  } else {
    parts.push(info.firstTurn && partial
      ? `first + ${Math.max(0, info.turns - 1)} recent turn${info.turns === 2 ? '' : 's'}`
      : `${info.turns} Q&A turn${info.turns === 1 ? '' : 's'}`);
    if (info.omitted > 0) parts.push(`${info.omitted} ${info.firstTurn ? 'between' : 'older'} omitted`);
    if (info.unread) parts.push(info.firstTurn ? 'some between not read' : 'older not read');
    if (info.clipped) parts.push('clipped');
    parts.push(`~${kb(info.bytes)}`);
  }
  return parts.join(' · ');
}

const appLanguage = () => (typeof document === 'undefined' ? '' : document.documentElement?.lang ?? '');

/** The card, open or closed; `ReferenceCard` holds the state (closed at first). */
export function ReferenceCardView({ source, open, onToggle, lang = appLanguage() }) {
  const info = parseReference(source);
  // Not a block this plugin wrote: show the text as it is.
  if (!info) return h('pre', { className: 'psm-raw' }, source);
  const zh = isZh(lang);
  return h('div', { className: 'psm-card', 'data-psm-open': open ? 'true' : 'false', 'data-session-id': info.id },
    h('button', {
      type: 'button', className: 'psm-head', 'aria-expanded': open,
      title: zh ? (open ? '收起引用内容' : '展开引用内容') : (open ? 'Hide the referenced text' : 'Show the referenced text'),
      onClick: onToggle,
    },
    h('span', { className: 'psm-chevron', 'aria-hidden': true }, open ? '▾' : '▸'),
    h('span', { className: 'psm-kind' }, zh ? '引用会话' : 'Referenced chat'),
    h('span', { className: 'psm-title' }, displayTitle(info.title, lang)),
    h('span', { className: 'psm-facts' }, referenceFacts(info, lang))),
    open ? h('pre', { className: 'psm-body' }, source) : null);
}

export function ReferenceCard({ source }) {
  const [open, setOpen] = useState(false);
  return h(ReferenceCardView, { source, open, onToggle: () => setOpen((value) => !value) });
}

export const REFERENCE_CARD_CSS = `
.psm-card {
  margin: 4px 0;
  border: 1px solid var(--ds-border-default);
  border-radius: 8px;
  color: var(--ds-text-primary);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
}
.psm-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.psm-chevron, .psm-kind, .psm-facts {
  color: var(--ds-text-muted);
}
.psm-title {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.psm-body, .psm-raw {
  margin: 0;
  padding: 8px 10px;
  max-height: 360px;
  overflow: auto;
  border-top: 1px solid var(--ds-border-default);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.psm-raw {
  border-top: 0;
}
`;
