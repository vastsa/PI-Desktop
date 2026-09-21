(() => {
  const NAVIGATION_CLASS = "pi-office-toolbar-nav";
  const OVERFLOW_CLASS = "pi-office-toolbar-overflow";
  const SCROLL_CLASS = "pi-office-toolbar-scroll";
  const HOST_CLASS = "pi-office-toolbar-host";
  const ORIGINAL_COLLAPSE_CLASS = "pi-office-original-collapse-control";
  const PARTIAL_ITEM_CLASS = "pi-office-toolbar-partial-item";
  const SINGLE_COLUMN_CLASS = "pi-office-toolbar-single-column";
  const PAGE_CONTROL_GUTTER = 6;
  const attachedRibbons = new WeakMap();
  let updateScheduled = false;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function getLabels() {
    const language = document.documentElement.lang || "";
    const isChinese = language.toLowerCase().startsWith("zh");
    return isChinese
      ? {
          previous: "上一页工具",
          next: "下一页工具",
        }
      : {
          previous: "Previous toolbar page",
          next: "Next toolbar page",
        };
  }

  function createArrow(direction, getBody) {
    const labels = getLabels();
    const button = document.createElement("button");
    const path = direction === "previous" ? "M14 5 8 12l6 7" : "m10 5 6 7-6 7";

    button.type = "button";
    button.className = `${NAVIGATION_CLASS} ${NAVIGATION_CLASS}-${direction}`;
    button.setAttribute("aria-label", labels[direction]);
    button.title = labels[direction];
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      pageToolbar(getBody(), direction === "previous" ? -1 : 1);
    });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = `<path d="${path}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>`;
    button.append(svg);
    return button;
  }

  function getToolbarItemBounds(container) {
    const containerRect = container.getBoundingClientRect();
    return Array.from(
      container.querySelectorAll(
        "button, input, select, textarea, [role='button'], .ribbon-sep",
      ),
    )
      .filter((item) => item.offsetParent !== null)
      .map((item) => {
        const rect = item.getBoundingClientRect();
        return {
          element: item,
          left: rect.left - containerRect.left + container.scrollLeft,
          right:
            rect.right - containerRect.left +
            container.scrollLeft +
            PAGE_CONTROL_GUTTER,
        };
      })
      .filter(({ left, right }) => Number.isFinite(left) && right > left)
      .sort((a, b) => a.left - b.left || a.right - b.right);
  }

  function getToolbarPageStarts(container) {
    const pageWidth = Math.max(1, container.clientWidth);
    const maxScroll = Math.max(0, container.scrollWidth - pageWidth);
    if (maxScroll <= 1) return [0];

    const items = getToolbarItemBounds(container);
    if (items.length === 0) {
      return [0, maxScroll];
    }

    const starts = [0];
    let start = 0;
    while (start < maxScroll - 1) {
      const viewportEnd = start + pageWidth;
      const nextItem = items.find(
        ({ left, right }) => left > start + 1 && right > viewportEnd + 1,
      );
      const nextStart = clamp(
        nextItem?.left ?? maxScroll,
        start + 1,
        maxScroll,
      );
      starts.push(nextStart);
      start = nextStart;
    }

    if (starts.at(-1) !== maxScroll) starts.push(maxScroll);
    return starts;
  }

  function updatePartialToolbarItems(container) {
    const leftEdge = container.scrollLeft + 1;
    const rightEdge = container.scrollLeft + container.clientWidth - 1;
    for (const { element, left, right } of getToolbarItemBounds(container)) {
      element.classList.toggle(
        PARTIAL_ITEM_CLASS,
        left < leftEdge || right > rightEdge,
      );
    }
  }

  function getDirectToolbarChild(container, element) {
    let current = element;
    while (current && current.parentElement !== container) {
      current = current.parentElement;
    }
    return current?.parentElement === container ? current : null;
  }

  function centerSingleColumn(container) {
    const containerRect = container.getBoundingClientRect();
    const viewportLeft = containerRect.left;
    const viewportRight = viewportLeft + container.clientWidth;
    const visibleItems = getToolbarItemBounds(container).filter(({ element, left, right }) => {
      if (element.classList.contains(PARTIAL_ITEM_CLASS)) return false;
      const itemLeft = left - container.scrollLeft + viewportLeft;
      const itemRight = right - container.scrollLeft + viewportLeft;
      return itemRight > viewportLeft + 1 && itemLeft < viewportRight - 1;
    });
    const modules = new Set(
      visibleItems
        .map(({ element }) => getDirectToolbarChild(container, element))
        .filter(
          (element) =>
            element?.classList.contains("ribbon-group") ||
            element?.classList.contains("table-ribbon-body"),
        ),
    );
    const isSingleColumn = modules.size === 1;
    container.classList.toggle(SINGLE_COLUMN_CLASS, isSingleColumn);
    if (!isSingleColumn) return;

    const [module] = modules;
    const moduleRect = module.getBoundingClientRect();
    if (moduleRect.width > container.clientWidth + 1) return;

    const shift =
      moduleRect.left + moduleRect.width / 2 - (viewportLeft + container.clientWidth / 2);
    if (Math.abs(shift) <= 1) return;

    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
    container.scrollLeft = clamp(container.scrollLeft + shift, 0, maxScroll);
    updatePartialToolbarItems(container);
  }

  function isRibbonExpanded(ribbon) {
    const body = ribbon.querySelector(":scope > .ribbon-body");
    return Boolean(body && !body.hidden && body.offsetParent !== null);
  }

  function toggleRibbonCollapse(ribbon) {
    const original = ribbon.querySelector(`.${ORIGINAL_COLLAPSE_CLASS}`);
    if (original) {
      original.click();
      return;
    }

    const isMac = (navigator.platform || "").toLowerCase().includes("mac");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: isMac ? "r" : "F1",
        code: isMac ? "KeyR" : "F1",
        ctrlKey: !isMac,
        metaKey: isMac,
        altKey: isMac,
      }),
    );
  }

  function bindCategoryToggle(ribbon) {
    ribbon
      .querySelectorAll(":scope > .ribbon-tabs > .ribbon-tab")
      .forEach((tab) => {
        if (tab.dataset.piOfficeCollapseBound === "true") return;
        tab.dataset.piOfficeCollapseBound = "true";
        tab.addEventListener(
          "click",
          (event) => {
            const isActive =
              tab.classList.contains("active") ||
              tab.getAttribute("aria-selected") === "true";
            if (isActive) {
              event.preventDefault();
              event.stopImmediatePropagation();
              toggleRibbonCollapse(ribbon);
              return;
            }

            if (!isRibbonExpanded(ribbon)) toggleRibbonCollapse(ribbon);
          },
          true,
        );
      });
  }

  function pageToolbar(container, direction) {
    if (!container) return;

    const starts = getToolbarPageStarts(container);
    const currentPage = starts.reduce(
      (page, start, index) =>
        start <= container.scrollLeft + 1 ? index : page,
      0,
    );
    const target = starts[clamp(currentPage + direction, 0, starts.length - 1)];
    if (Math.abs(target - container.scrollLeft) <= 1) return;

    container.scrollTo({
      left: target,
      behavior: "auto",
    });
  }

  function updateNavigation(container, state) {
    if (!container) {
      state.previous.hidden = false;
      state.next.hidden = false;
      state.previous.disabled = true;
      state.next.disabled = true;
      state.previous.setAttribute("aria-disabled", "true");
      state.next.setAttribute("aria-disabled", "true");
      return;
    }

    updatePartialToolbarItems(container);
    centerSingleColumn(container);

    const pageStarts = getToolbarPageStarts(container);
    const hasOverflow = pageStarts.length > 1;
    const currentPage = pageStarts.reduce(
      (page, start, index) =>
        start <= container.scrollLeft + 1 ? index : page,
      0,
    );
    const atStart = currentPage <= 0;
    const atEnd = currentPage >= pageStarts.length - 1;

    container.classList.toggle(OVERFLOW_CLASS, hasOverflow);
    state.previous.hidden = false;
    state.next.hidden = false;
    state.previous.disabled = !hasOverflow || atStart;
    state.next.disabled = !hasOverflow || atEnd;
    state.previous.setAttribute("aria-disabled", String(state.previous.disabled));
    state.next.setAttribute("aria-disabled", String(state.next.disabled));
  }

  function markOriginalCollapseControl(ribbon) {
    ribbon.querySelectorAll(".ribbon-collapse-btn").forEach((button) => {
      button.classList.add(ORIGINAL_COLLAPSE_CLASS);
    });
  }

  function removeNavigationButtons(ribbon, body) {
    ribbon
      .querySelectorAll(`:scope > .${NAVIGATION_CLASS}`)
      .forEach((button) => button.remove());
    body?.querySelectorAll(`:scope > .${NAVIGATION_CLASS}`).forEach((button) => {
      button.remove();
    });
  }

  function detachNavigation(ribbon) {
    const state = attachedRibbons.get(ribbon);
    if (state) detachBodyBinding(state);
    removeNavigationButtons(ribbon, state?.body);
    ribbon.classList.remove(HOST_CLASS);
    attachedRibbons.delete(ribbon);
  }

  function getOrCreateNavigationState(ribbon) {
    let state = attachedRibbons.get(ribbon);
    if (state) return state;

    removeNavigationButtons(ribbon);
    state = {
      body: null,
      previous: createArrow("previous", () => state.body),
      next: createArrow("next", () => state.body),
      onScroll: null,
      resizeObserver: null,
    };
    attachedRibbons.set(ribbon, state);
    return state;
  }

  function ensureNavigationControls(ribbon, state) {
    ribbon.classList.add(HOST_CLASS);
    if (!state.previous.isConnected || state.previous.parentElement !== ribbon) {
      ribbon.append(state.previous);
    }
    if (!state.next.isConnected || state.next.parentElement !== ribbon) {
      ribbon.append(state.next);
    }
  }

  function detachBodyBinding(state) {
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }

    if (state.onScroll && state.body) {
      state.body.removeEventListener("scroll", state.onScroll);
      state.body.classList.remove(SCROLL_CLASS, OVERFLOW_CLASS);
      state.body
        .querySelectorAll(`.${PARTIAL_ITEM_CLASS}`)
        .forEach((item) => item.classList.remove(PARTIAL_ITEM_CLASS));
    }

    state.onScroll = null;
  }

  function attachNavigation(ribbon, body) {
    const state = getOrCreateNavigationState(ribbon);
    ensureNavigationControls(ribbon, state);

    if (
      state.body === body &&
      state.previous.isConnected &&
      state.next.isConnected &&
      state.previous.parentElement === ribbon &&
      state.next.parentElement === ribbon
    ) {
      updateNavigation(body, state);
      return;
    }

    // Category changes replace .ribbon-body, but the fixed controls belong to
    // the outer ribbon and must survive that replacement.
    detachBodyBinding(state);
    state.body = body;
    body.classList.add(SCROLL_CLASS);

    state.onScroll = () => updateNavigation(state.body, state);
    body.addEventListener("scroll", state.onScroll, {
      passive: true,
    });

    if (typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(() => {
        updateNavigation(state.body, state);
      });
      resizeObserver.observe(ribbon);
      resizeObserver.observe(body);
      state.resizeObserver = resizeObserver;
    }

    updateNavigation(body, state);
  }

  function decorateToolbar(ribbon) {
    const clipboardLabels = new Set([
      "粘贴",
      "Paste",
      "貼り付け",
      "붙여넣기",
    ]);
    ribbon.querySelectorAll(".ribbon-body .ribbon-group").forEach((group) => {
      const hasPaste = Array.from(group.querySelectorAll(".rb-big")).some((button) =>
        clipboardLabels.has(button.textContent.trim()),
      );
      group.classList.toggle("pi-office-clipboard-group", hasPaste);
    });

    ribbon.querySelectorAll(".ribbon-body .layout-para").forEach((group) => {
      group.classList.add("pi-office-layout-para");
      group.querySelectorAll(".layout-col").forEach((column) => {
        column.classList.add("pi-office-layout-col");
      });
    });
  }

  function refresh() {
    document.querySelectorAll(".ribbon").forEach((ribbon) => {
      const tabs = ribbon.querySelector(".ribbon-tabs");
      const body = ribbon.querySelector(".ribbon-body");
      ribbon.classList.toggle("pi-office-ribbon-collapsed", !isRibbonExpanded(ribbon));
      if (tabs) {
        // Category switching stays in the fixed first row. Only the command
        // row is paged, so the arrows never cover save or tab controls.
        tabs.classList.add("pi-office-toolbar-tabs");
        bindCategoryToggle(ribbon);
      }
      markOriginalCollapseControl(ribbon);
      if (body) attachNavigation(ribbon, body);
      else {
        // A category switch can temporarily remove the command row before
        // inserting its replacement. Keep the fixed controls on the outer
        // ribbon and only pause the old row's listeners during that window.
        const state = getOrCreateNavigationState(ribbon);
        detachBodyBinding(state);
        state.body = null;
        ensureNavigationControls(ribbon, state);
        updateNavigation(null, state);
      }
      decorateToolbar(ribbon);
    });
  }

  function scheduleRefresh() {
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(() => {
      updateScheduled = false;
      refresh();
    });
  }

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", scheduleRefresh, { passive: true });
  scheduleRefresh();
})();
