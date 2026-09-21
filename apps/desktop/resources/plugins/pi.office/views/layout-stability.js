(function installOfficeLayoutStability() {
  "use strict";

  const RESIZE_SETTLE_MS = 96;
  const attached = new WeakSet();
  let userGestureRevision = 0;

  function pageAnchor(scroller) {
    const viewport = scroller.getBoundingClientRect();
    const pages = Array.from(scroller.querySelectorAll(".doc-page"));
    const pageIndex = pages.findIndex((page) => {
      const rect = page.getBoundingClientRect();
      return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
    });
    const page = pageIndex >= 0 ? pages[pageIndex] : null;
    const pageRect = page?.getBoundingClientRect();
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return {
      pageIndex,
      pageOffset: pageRect ? pageRect.top - viewport.top : null,
      scrollTop: scroller.scrollTop,
      scrollRatio: maxScrollTop > 0 ? scroller.scrollTop / maxScrollTop : 0,
      scrollLeft: scroller.scrollLeft,
      revision: userGestureRevision,
    };
  }

  function restoreAnchor(scroller, anchor) {
    if (anchor.revision !== userGestureRevision || !scroller.isConnected) return;

    const viewport = scroller.getBoundingClientRect();
    const pages = Array.from(scroller.querySelectorAll(".doc-page"));
    const page = anchor.pageIndex >= 0 ? pages[anchor.pageIndex] : null;
    let nextTop = anchor.scrollTop;
    if (page && anchor.pageOffset !== null) {
      const currentOffset = page.getBoundingClientRect().top - viewport.top;
      nextTop = scroller.scrollTop + currentOffset - anchor.pageOffset;
    } else {
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      nextTop = maxScrollTop * anchor.scrollRatio;
    }

    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(maxScrollTop, Math.max(0, nextTop));
    scroller.scrollLeft = anchor.scrollLeft;
  }

  function stopResizeLock(state) {
    state.resizing = false;
    state.anchor = null;
    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
  }

  function markUserGesture(state) {
    userGestureRevision += 1;
    stopResizeLock(state);
    state.lastAnchor = pageAnchor(state.scroller);
  }

  function scheduleResizeLock(state) {
    if (state.frame || !state.resizing) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      if (!state.resizing || !state.scroller.isConnected) return;

      // GenOffice recalculates fit-to-width asynchronously. Correct the anchor
      // in the same rendering cycle, then keep doing so until the resize settles.
      restoreAnchor(state.scroller, state.anchor);
      if (performance.now() - state.lastResizeAt < RESIZE_SETTLE_MS) {
        scheduleResizeLock(state);
        return;
      }

      restoreAnchor(state.scroller, state.anchor);
      state.resizing = false;
      state.anchor = null;
      state.lastAnchor = pageAnchor(state.scroller);
    });
  }

  function attach(scroller) {
    if (attached.has(scroller)) return;
    attached.add(scroller);
    const state = {
      scroller,
      frame: 0,
      lastResizeAt: 0,
      lastAnchor: pageAnchor(scroller),
      anchor: null,
      resizing: false,
    };
    let previousWidth = scroller.clientWidth;
    scroller.style.overflowAnchor = "none";
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      scroller.addEventListener(event, () => markUserGesture(state), { passive: true });
    }
    scroller.addEventListener("scroll", () => {
      if (!state.resizing) state.lastAnchor = pageAnchor(scroller);
    }, { passive: true });

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? scroller.clientWidth;
      if (Math.abs(width - previousWidth) < 0.5) return;
      previousWidth = width;
      if (!state.resizing) {
        state.anchor = state.lastAnchor ?? pageAnchor(scroller);
        state.resizing = true;
      }
      state.lastResizeAt = performance.now();
      restoreAnchor(scroller, state.anchor);
      scheduleResizeLock(state);
    });
    observer.observe(scroller);
  }

  function scan() {
    document.querySelectorAll(".editor-scroll").forEach(attach);
  }

  scan();
  new MutationObserver(scan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
