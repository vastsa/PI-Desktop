import { memo, useContext, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import { observeTranscriptContent } from "../../../lib/transcript-content-observer";
import { hasStatefulTranscriptContent, shouldMountTranscriptContent } from "../../../lib/transcript-content-window";
import { ScopeContext } from "./disclosure-scope";

/** Keep the existing prose shell and message anchors while releasing its renderer. */
export const TranscriptProse = memo(function TranscriptProse({ source, streaming }: {
  source: string;
  streaming: boolean;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const { visible } = useContext(ScopeContext);
  const [window, setWindow] = useState({ source, mounted: true, height: 0 });
  const mounted = visible && (streaming || window.source !== source || window.mounted);
  const mountedRef = useRef(mounted);
  useLayoutEffect(() => { mountedRef.current = mounted; });
  useLayoutEffect(() => {
    const element = elementRef.current;
    const viewport = element?.closest<HTMLElement>(".thread-scroll");
    if (!element || !viewport || streaming || !visible || hasStatefulTranscriptContent(source)) return;
    let measuredHeight: number | null = null;
    let measuredWidth: number | null = null;
    return observeTranscriptContent(element, () => {
      if (!element.isConnected || viewport.clientHeight === 0) return;
      const rect = element.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (mountedRef.current && rect.height > 0) {
        measuredHeight = rect.height;
        measuredWidth = rect.width;
      }
      const selection = element.ownerDocument.getSelection();
      const protectedContent = element.contains(element.ownerDocument.activeElement) ||
        Boolean(selection && !selection.isCollapsed && selection.containsNode(element, true)) ||
        Boolean(element.closest(".transcript-search-target"));
      const next = shouldMountTranscriptContent({
        top: rect.top - viewportRect.top,
        bottom: rect.bottom - viewportRect.top,
        viewportHeight: viewport.clientHeight,
        width: rect.width,
        measuredHeight,
        measuredWidth,
        mounted: mountedRef.current,
        protected: protectedContent,
      });
      if (next !== mountedRef.current) {
        setWindow({ source, mounted: next, height: measuredHeight ?? 0 });
      }
    });
  }, [source, streaming, visible]);
  return <div
    ref={elementRef}
    className="prose-chat"
    data-transcript-content={mounted ? "mounted" : "placeholder"}
    style={mounted ? undefined : { height: window.height }}
  >
    {mounted ? <Markdown source={source} streaming={streaming} /> : null}
  </div>;
});
