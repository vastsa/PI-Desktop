export async function checkSidebarResponsiveHeight({ cdp, check, waitFor, seed }) {
  const pinned = ".sidebar-session-group-body.pinned";
  const recent = ".sidebar-session-group-body.standalone";
  const projects = ".sidebar-session-groups";
  const loadMore = '[data-action="recent-sessions-load-more"]';
  const projectRow = `${projects} [data-sidebar-session-row=${JSON.stringify(seed.alphaSessionIds[1])}] .thread-item-main`;
  const originalWidth = await cdp.evaluate("window.innerWidth");
  const setHeight = async (height) => {
    // These are CSS viewport heights, which are what both window resizing
    // and Electron page zoom change for the renderer's layout.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(originalWidth, 1000), height, deviceScaleFactor: 0, mobile: false,
    });
    await waitFor(() => cdp.evaluate(`window.innerHeight === ${height}`), `viewport height ${height}`);
  };
  const measure = (revealProject = false) => cdp.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(projectRow)});
    if (${revealProject}) target?.scrollIntoView({ block: 'nearest' });
    const body = document.querySelector('.sidebar-body');
    const projectList = document.querySelector(${JSON.stringify(projects)});
    const size = (selector) => {
      const list = document.querySelector(selector);
      return { height: list.clientHeight, content: list.scrollHeight, top: list.scrollTop };
    };
    const point = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const node = document.elementFromPoint(x, y);
      const hit = element.contains(node);
      return { x, y, hit, blockedBy: hit ? undefined : node?.outerHTML?.slice(0, 180) ?? null };
    };
    const row = target?.closest('[data-sidebar-session-row]')?.getBoundingClientRect();
    const projectBox = projectList.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    return {
      pinned: size(${JSON.stringify(pinned)}), recent: size(${JSON.stringify(recent)}),
      projects: size(${JSON.stringify(projects)}), body: size('.sidebar-body'),
      projectRow: point(${JSON.stringify(projectRow)}), loadMore: point(${JSON.stringify(loadMore)}),
      projectRowFullyVisible: Boolean(row && row.top >= Math.max(projectBox.top, bodyBox.top) - 0.5 &&
        row.bottom <= Math.min(projectBox.bottom, bodyBox.bottom) + 0.5),
      recentRows: document.querySelectorAll(${JSON.stringify(`${recent} [data-sidebar-session-row]`)}).length,
    };
  })()`);
  // Check the pointer target in the measured viewport before activating the
  // real button; CDP mouse coordinates vary with native desktop scaling.
  const click = (selector, point) => {
    if (!point?.hit) throw new Error(`Not reachable: ${selector} (${JSON.stringify(point)})`);
    return cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const resetScroll = () => cdp.evaluate(`for (const list of document.querySelectorAll(${JSON.stringify(`.sidebar-body, ${pinned}, ${recent}, ${projects}`)})) list.scrollTop = 0;`);
  const zoom = (action) => cdp.evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke.nativeMenuAction, ${JSON.stringify({ action })})`);

  try {
    await setHeight(900);
    await resetScroll();
    const initial = await measure();
    await click(loadMore, initial.loadMore);
    await waitFor(async () => (await measure()).recentRows > initial.recentRows, "Recent sessions loads another page");
    const roomy = await measure();

    await setHeight(490);
    const compact = await measure();
    check(
      compact.projectRowFullyVisible && compact.projectRow?.hit && compact.body.content <= compact.body.height + 1,
      "a loaded Recent list leaves a complete, clickable project session at compact height",
      JSON.stringify(compact),
    );
    check(
      compact.pinned.height < roomy.pinned.height && compact.pinned.content > compact.pinned.height &&
        compact.recent.height < roomy.recent.height && compact.recent.content > compact.recent.height,
      "Pinned and Recent shrink and scroll inside their own lists instead of crowding Projects",
      JSON.stringify({ roomy, compact }),
    );
    await cdp.evaluate(`for (const selector of ${JSON.stringify([pinned, recent])}) {
      const list = document.querySelector(selector);
      list.scrollTop = list.scrollHeight;
    }`);
    const afterScroll = await measure();
    check(
      afterScroll.pinned.top > 0 && afterScroll.recent.top > 0 &&
        afterScroll.projects.top === compact.projects.top && afterScroll.body.top === compact.body.top,
      "scrolling Pinned and Recent does not move the project list or sidebar chrome",
      JSON.stringify(afterScroll),
    );
    await click(loadMore, afterScroll.loadMore);
    const loaded = await waitFor(async () => {
      const layout = await measure();
      return layout.recentRows > compact.recentRows ? layout : null;
    }, "Load more remains reachable from the compact Recent scroller");
    check(loaded.projectRowFullyVisible && loaded.projectRow?.hit, "loading more at compact height leaves Projects usable");

    await setHeight(300);
    const shortest = await measure(true);
    check(
      shortest.body.top > 0 && shortest.projectRowFullyVisible && shortest.projectRow?.hit,
      "projects remain reachable when the sidebar needs an outer scroll",
      JSON.stringify(shortest),
    );
    await setHeight(900);
    await resetScroll();
    const restored = await measure();
    check(
      restored.recentRows === loaded.recentRows && restored.recent.height === roomy.recent.height &&
        restored.pinned.height === roomy.pinned.height && restored.projectRow?.hit,
      "restoring height restores the list viewports without reloading sessions",
      JSON.stringify(restored),
    );

    await cdp.send("Emulation.clearDeviceMetricsOverride");
    const unzoomed = await cdp.evaluate("window.innerHeight");
    try {
      for (let step = 0; step < 3; step += 1) await zoom("zoomIn");
      await waitFor(() => cdp.evaluate(`window.innerHeight < ${unzoomed}`), "native page zoom reduces the CSS viewport");
      const zoomed = await measure(true);
      check(zoomed.projectRowFullyVisible && zoomed.projectRow?.hit, "native Zoom In keeps project sessions reachable", JSON.stringify(zoomed));
    } finally {
      await zoom("resetZoom");
      await waitFor(() => cdp.evaluate(`window.innerHeight === ${unzoomed}`), "original zoom restored");
    }

    // Opening a conversation changes the shell's focus and active workspace.
    // Finish the geometry checks before exercising that navigation.
    await setHeight(490);
    await resetScroll();
    await click(projectRow, (await measure()).projectRow);
    await waitFor(
      () => cdp.evaluate(`document.querySelector(${JSON.stringify(projectRow)})?.getAttribute('aria-current') === 'page'`),
      "project session can be opened from the compact sidebar",
      10_000,
    );
    check(true, "selecting a visible project session opens it at compact height");
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await resetScroll();
  }
}
