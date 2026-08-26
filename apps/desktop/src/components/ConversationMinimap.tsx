import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import {
  buildConversationMinimapMarkers,
  type ConversationMinimapMarker,
} from "../lib/conversation-minimap";

/* Codex-style conversation minimap: a packed stack of dashes on the left edge
 * of the thread, one per user turn or assistant response. Moving the cursor
 * along the rail magnifies nearby dashes with a macOS-Dock cosine falloff, the
 * nearest turn shows a preview popover, and clicking jumps to that turn. Dashes
 * grow horizontally only, so magnification never shifts the stack layout. */

/* Dock magnification: reach of the falloff and peak growth factor. */
const MAGNIFY_RADIUS = 46;
const MAGNIFY_BOOST = 1.3;
/* Cursor must be this close to a dash for the popover to pick it. */
const POPOVER_SNAP = 24;
const POPOVER_HEIGHT = 132;
/* Hide the rail until content actually overflows one viewport. */
const OVERFLOW_EPSILON_PX = 1;

export const ConversationMinimap = memo(function ConversationMinimap({
  scrollRef,
  messages,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  messages: UiMessage[];
}) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    marker: ConversationMinimapMarker;
    top: number;
  } | null>(null);
  const [overflows, setOverflows] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const markerEls = useRef(new Map<string, HTMLButtonElement>());
  const moveRaf = useRef(0);

  /* Cached offsets to avoid O(n) DOM queries on every scroll frame. */
  const cachedOffsetsRef = useRef<{ id: string; offset: number }[]>([]);
  /* Guards to skip setState when value hasn't changed. */
  const activeIdRef = useRef<string | null>(null);
  const overflowsRef = useRef(false);

  const markers = useMemo(
    () => buildConversationMinimapMarkers(messages),
    [messages],
  );
  const markerIdentity = useMemo(
    () => markers.map((marker) => marker.id).join("\u0000"),
    [markers],
  );
  const markersRef = useRef(markers);
  markersRef.current = markers;

  /* Recompute cached offsets from DOM. Called on resize / marker changes only. */
  const recomputeOffsets = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      cachedOffsetsRef.current = [];
      return;
    }
    const baseTop = el.getBoundingClientRect().top;
    const markerIds = new Set(markersRef.current.map((marker) => marker.id));
    const out: { id: string; offset: number }[] = [];
    el.querySelectorAll<HTMLElement>("[data-minimap-id]").forEach((node) => {
      const id = node.dataset.minimapId || "";
      if (!markerIds.has(id)) return;
      out.push({
        id,
        offset: node.getBoundingClientRect().top - baseTop + el.scrollTop,
      });
    });
    cachedOffsetsRef.current = out;
  }, [scrollRef]);

  /**
   * Vertical centers of the dashes, in rail-local pixels.
   *
   * Dashes have a CSS-fixed height and magnify horizontally only, so their
   * centers change with the rail's layout, not with the cursor. Measuring them
   * once per layout keeps hover off the critical path: `applyMagnify` runs on
   * every mousemove frame, and reading `offsetTop` there — interleaved with the
   * `--magnify` writes it makes in the same loop — forced a synchronous reflow per
   * dash, so hovering a long conversation's rail cost O(markers) layouts a frame.
   */
  const magnifyCentersRef = useRef<{ id: string; center: number }[]>([]);

  const measureMagnifyCenters = useCallback(() => {
    const centers: { id: string; center: number }[] = [];
    // Read-only pass: no style writes, so layout is computed at most once.
    for (const [id, btn] of markerEls.current) {
      centers.push({ id, center: btn.offsetTop + btn.offsetHeight / 2 });
    }
    centers.sort((a, b) => a.center - b.center);
    magnifyCentersRef.current = centers;
  }, []);

  /* Fresh offset query used only by jumpTo (needs pixel-accurate data). */
  const getOffsets = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return [];
    const baseTop = el.getBoundingClientRect().top;
    const markerIds = new Set(markersRef.current.map((marker) => marker.id));
    const out: { id: string; offset: number }[] = [];
    el.querySelectorAll<HTMLElement>("[data-minimap-id]").forEach((node) => {
      const id = node.dataset.minimapId || "";
      if (!markerIds.has(id)) return;
      out.push({
        id,
        offset: node.getBoundingClientRect().top - baseTop + el.scrollTop,
      });
    });
    return out;
  }, [scrollRef]);

  /* Use cached offsets + binary search for O(log n) active tracking. */
  const updateActive = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const offsets = cachedOffsetsRef.current;
    if (offsets.length === 0) return;
    const anchor = el.scrollTop + el.clientHeight * 0.3;
    // Binary search for the last offset <= anchor
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (offsets[mid].offset <= anchor) lo = mid;
      else hi = mid - 1;
    }
    const id = offsets[lo].id;
    if (id !== activeIdRef.current) {
      activeIdRef.current = id;
      setActiveId(id);
    }
  }, [scrollRef]);

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      if (overflowsRef.current) {
        overflowsRef.current = false;
        setOverflows(false);
      }
      return;
    }
    // One-page content has no scroll range; the rail is only useful when overflowing.
    const nowOverflows = el.scrollHeight - el.clientHeight > OVERFLOW_EPSILON_PX;
    if (nowOverflows !== overflowsRef.current) {
      overflowsRef.current = nowOverflows;
      setOverflows(nowOverflows);
    }
  }, [scrollRef]);

  useEffect(() => {
    recomputeOffsets();
    updateOverflow();
    measureMagnifyCenters();
  }, [markerIdentity, measureMagnifyCenters, recomputeOffsets, updateOverflow]);

  useEffect(() => {
    updateActive();
  }, [markerIdentity, updateActive]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let scrollRaf = 0;
    let resizeRaf = 0;
    const scheduleScroll = () => {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        updateActive();
        updateOverflow();
      });
    };
    const scheduleResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        recomputeOffsets();
        updateActive();
        updateOverflow();
        // The rail's gap is marker-count dependent and its height follows the
        // composer, so dash centers move without the marker set changing.
        measureMagnifyCenters();
      });
    };
    // Initial offset computation
    recomputeOffsets();
    el.addEventListener("scroll", scheduleScroll, { passive: true });
    // Streamed content can change layout between marker identity changes.
    const content = el.firstElementChild;
    const ro =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleResize)
        : null;
    if (ro && content) ro.observe(content);
    // Viewport resizes can create or remove overflow without content changes.
    window.addEventListener("resize", scheduleResize);
    return () => {
      el.removeEventListener("scroll", scheduleScroll);
      ro?.disconnect();
      cancelAnimationFrame(scrollRaf);
      cancelAnimationFrame(resizeRaf);
      window.removeEventListener("resize", scheduleResize);
    };
  }, [measureMagnifyCenters, scrollRef, updateActive, updateOverflow, recomputeOffsets]);

  const jumpTo = useCallback(
    (id: string) => {
      const el = scrollRef.current;
      if (!el) return;
      const target = getOffsets().find((entry) => entry.id === id);
      if (!target) return;
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      el.scrollTo({
        top: Math.max(0, target.offset - 24),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    },
    [scrollRef, getOffsets],
  );

  /* Dock magnification, applied imperatively so mousemove never re-renders.
   * Dash buttons keep a fixed height, so scaling is layout-stable. Centers come
   * from the cached measurement: writing `--magnify` while reading `offsetTop`
   * in the same loop would force one layout per dash on every hover frame. */
  const applyMagnify = useCallback((cursorY: number | null) => {
    const centers = magnifyCentersRef.current;
    if (centers.length === 0) {
      // Nothing measured yet (first frame after mount): fall back to a
      // measurement rather than skipping the effect the user asked for.
      measureMagnifyCenters();
    }
    let nearest: { id: string; dist: number; center: number } | null = null;
    for (const { id, center } of magnifyCentersRef.current) {
      const btn = markerEls.current.get(id);
      if (!btn) continue;
      let scale = 1;
      if (cursorY != null) {
        const dist = Math.abs(center - cursorY);
        if (dist < MAGNIFY_RADIUS) {
          scale = 1 + MAGNIFY_BOOST * Math.cos((dist / MAGNIFY_RADIUS) * (Math.PI / 2));
        }
        if (dist <= POPOVER_SNAP && (!nearest || dist < nearest.dist)) {
          nearest = { id, dist, center };
        }
      }
      btn.style.setProperty("--magnify", scale.toFixed(3));
    }
    if (nearest) {
      const marker = markersRef.current.find((m) => m.id === nearest!.id);
      const rail = railRef.current;
      if (marker && rail) {
        const top = Math.min(
          Math.max(nearest.center - 36, 0),
          Math.max(rail.clientHeight - POPOVER_HEIGHT, 0),
        );
        setHovered((prev) =>
          prev?.marker.id === marker.id && prev.top === top
            ? prev
            : { marker, top },
        );
        return;
      }
    }
    setHovered(null);
  }, [measureMagnifyCenters]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const rail = railRef.current;
      if (!rail) return;
      const y = event.clientY - rail.getBoundingClientRect().top;
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = requestAnimationFrame(() => applyMagnify(y));
    },
    [applyMagnify],
  );

  const handleMouseLeave = useCallback(() => {
    cancelAnimationFrame(moveRaf.current);
    applyMagnify(null);
  }, [applyMagnify]);

  useEffect(() => () => cancelAnimationFrame(moveRaf.current), []);

  if (markers.length < 2 || !overflows) return null;

  const roleLabel = (role: ConversationMinimapMarker["role"]) =>
    role === "user" ? t("chat.userMessage") : t("chat.assistantMessage");

  return (
    <nav
      className="minimap-rail"
      ref={railRef}
      aria-label={t("chat.minimap")}
      style={{ "--minimap-marker-count": markers.length } as CSSProperties}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {markers.map((marker) => (
        <button
          key={marker.id}
          ref={(node) => {
            if (node) markerEls.current.set(marker.id, node);
            else markerEls.current.delete(marker.id);
          }}
          className={`minimap-marker ${marker.role} ${
            marker.id === activeId ? "active" : ""
          }`}
          aria-label={roleLabel(marker.role)}
          aria-current={marker.id === activeId ? "true" : undefined}
          onFocus={(event) =>
            setHovered({
              marker,
              top: Math.max(0, event.currentTarget.offsetTop - 36),
            })
          }
          onBlur={() => setHovered(null)}
          onClick={() => jumpTo(marker.id)}
        />
      ))}
      {hovered && hovered.marker.preview ? (
        <div
          className="minimap-popover"
          role="tooltip"
          style={{ top: `${hovered.top}px` }}
        >
          <div className="minimap-popover-role">
            {roleLabel(hovered.marker.role)}
          </div>
          <div className="minimap-popover-text">{hovered.marker.preview}</div>
        </div>
      ) : null}
    </nav>
  );
});
