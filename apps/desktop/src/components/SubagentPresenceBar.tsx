import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui";
import { portalToBody } from "../lib/portal-visibility";
import { isActiveDelegate, presenceMetrics, type SubagentPresenceItem as Item } from "../lib/subagent-presence";
import { formatToolDuration } from "../lib/tool-display";
import "../styles/subagent-presence.css";

type Props = { items: readonly Item[]; onOpen: (item: Item) => void; onStop: (items: readonly Item[]) => void };
type Popup = { id: string | null; anchor: HTMLButtonElement };
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const tokens = (n: number | null) => n === null ? "—" : compact.format(n).toLowerCase();
const initials = (item: Item) => Array.from(item.agent.split("-").at(-1) || item.agent).slice(0,2).join("").toUpperCase();

export function SubagentPresenceBar({ items, onOpen, onStop }: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const [popup, setPopup] = useState<Popup | null>(null);
  const [now, setNow] = useState(Date.now);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressed = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  const close = () => { cancel(); setPopup(null); };
  const leave = () => { cancel(); timer.current = setTimeout(close, 160); };
  const select = (id: string | null, anchor: HTMLButtonElement, immediate = false) => {
    cancel();
    if (suppressed.current) return;
    const show = () => { setNow(Date.now()); setPopup({ id, anchor }); };
    if (immediate) show(); else timer.current = setTimeout(show, 120);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!popup) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation(); close();
      if (panel.current?.contains(document.activeElement)) {
        suppressed.current = true; popup.anchor.focus(); suppressed.current = false;
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !popup.anchor.contains(event.target)) close();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => { clearInterval(tick); document.removeEventListener("keydown", escape, true); document.removeEventListener("pointerdown", outside); };
  }, [popup]);
  const item = popup && items.find(row => row.id === popup.id);
  const roster = !!popup && popup.id === null && items.length > 6;
  useLayoutEffect(() => {
    if (!popup) return;
    const layer = panel.current;
    if (!layer || !popup.anchor.isConnected) { close(); return; }
    const place = () => {
      const a = popup.anchor.getBoundingClientRect(), h = layer.offsetHeight;
      layer.style.left = `${Math.max(8, Math.min(a.left, innerWidth - layer.offsetWidth - 8))}px`;
      layer.style.top = `${Math.max(8, a.top - h >= 14 ? a.top - h - 6 : Math.min(a.bottom + 6, innerHeight - h - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(layer); observer.observe(popup.anchor);
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [popup, item?.id, roster]);
  const active = items.filter(isActiveDelegate);
  if (!active.length) return null;
  const name = (row: Item) => row.agent || t("chat.subagentUnnamed");
  const status = (row: Item) => row.status === "queued" ? t("chat.subagentCreating") : t(`chat.subagentStatus.${row.status}`);
  const metrics = (row: Item) => {
    const { elapsed, speed } = presenceMetrics(row, now);
    return { time: elapsed === null ? "—" : formatToolDuration(elapsed / 1000), turns: t("chat.presenceTurns", { n: row.turns ?? "—" }), usage: `↑${tokens(row.inputTokens)} ↓${tokens(row.outputTokens)}`, speed: speed === null ? "—" : t("chat.usageThroughput", {count: Math.round(speed)}) };
  };
  const trigger = (row?: Item) => {
    const id = row?.id ?? null, expanded = popup?.id === id;
    return <button type="button" key={id ?? 'overflow'} className={row ? 'presence-avatar' : 'presence-more'} data-status={row?.status}
      aria-label={row ? `${name(row)} · ${status(row)}` : t("chat.subagentCount", {count: items.length})}
      aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
      onPointerEnter={e => select(id, e.currentTarget)} onPointerLeave={leave}
      onFocus={e => select(id, e.currentTarget)} onBlur={leave} onClick={e => select(id, e.currentTarget, true)}
      onKeyDown={e => { if (expanded && (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey))) { e.preventDefault(); panel.current?.querySelector('button')?.focus(); } }}>
      {row ? initials(row) : `+${items.length - 6}`}</button>;
  };
  const openRecord = (row: Item) => { close(); onOpen(row); };
  const renderCard = (row: Item) => {
    const m = metrics(row);
    return <><header><strong>{name(row)}</strong><span>{status(row)}</span></header>
      <p>{row.task || '—'}</p><p className={row.status === 'running' ? 'presence-live' : undefined}>{t(isActiveDelegate(row) ? 'chat.presenceCurrent' : 'chat.presenceResult')}: {row.detail || '—'}</p>
      <p className="presence-model">{row.model || '—'}</p><dl><dt>{t('chat.usageTotal')}</dt><dd>{m.usage}</dd><dt>{t('chat.usageThroughputLabel')}</dt><dd>{m.speed}</dd></dl>
      <div className="presence-pair"><span>{t('modes.run.elapsed', {duration: m.time})}</span><span>{m.turns}</span></div>
      <footer><Button size="sm" variant="ghost" onClick={() => openRecord(row)}>{t('chat.presenceRecord')}</Button>{row.status === 'running' && <Button size="sm" variant="ghost" onClick={() => onStop([row])}>{t('chat.stopSubagent')}</Button>}</footer></>;
  };
  const renderRoster = () => <><header><strong>{t('chat.subagentCount', {count: items.length})}</strong><small>{[...new Set(items.map(i => i.status))].map(s => `${items.filter(i=>i.status === s).length} ${status(items.find(i=>i.status === s)!)}`).join(' · ')}</small></header>
    {[active, items.filter(i => !isActiveDelegate(i))].map((group, index) => group.length > 0 && <section key={index}><strong>{t(index ? 'chat.processCompleted' : 'chat.processRunning')} {group.length}</strong>
      {group.map(row => { const m = metrics(row); return <button type="button" className="presence-row" key={row.id} onClick={() => openRecord(row)}>
        <span className="presence-name"><b>{name(row)}</b> {status(row)}</span><span className="presence-time">{m.time} · {m.turns}</span>
        <span className="presence-model">{row.model || '—'}</span><span className="presence-usage">{m.usage}</span><span>{m.speed}</span></button>; })}</section>)}
    <footer><span>{t('chat.presenceRecord')}</span><Button size="sm" variant="ghost" disabled={!active.some(i => i.status === 'running')} onClick={() => onStop(active.filter(i => i.status === 'running'))}>{t('chat.stopAllSubagentsShort')}</Button></footer></>;
  return <div className="subagent-bar" role="group" aria-label={t('chat.subagentTopology')}>
    {items.slice(0,6).map(trigger)}{items.length > 6 && trigger()}
    {popup && (item || roster) && portalToBody(<div id={panelId} role="dialog" aria-label={item ? name(item) : t('chat.subagentTopology')} ref={panel}
      className={`presence-popup ${roster ? 'presence-roster' : 'presence-card'}`}
      onPointerEnter={cancel} onPointerLeave={e => { if (!e.currentTarget.contains(document.activeElement)) leave(); }} onFocus={cancel}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) leave(); }}>
      {item ? renderCard(item) : renderRoster()}</div>)}
  </div>;
}
