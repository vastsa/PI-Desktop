export async function checkSidebarHoverPreview({ cdp, check, waitFor, measure, clickSidebarToggle, targets, connect, openBrowser }) {
  await openBrowser();
  let native;
  await waitFor(async () => {
    native = (await targets()).find(target => target.type === "page" && target.url.includes("pi.browser"));
    return native?.webSocketDebuggerUrl;
  }, "native Browser plugin view");
  const browser = await connect(native.webSocketDebuggerUrl);
  try {
    await browser.send("Runtime.enable");
    await waitFor(() => browser.evaluate("!document.hidden"), "native Browser visible");
    if (await cdp.evaluate('!!document.querySelector(".sidebar:not(.is-floating)")')) await clickSidebarToggle();
    await waitFor(() => cdp.evaluate('!document.querySelector(".sidebar")'), "sidebar fully collapsed");
    const baseline = await measure();
    const toggle = '[data-nav="toggle-sidebar"]';
    const point = selector => cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    const move = async selector => {
      const target = await point(selector);
      if (!target) throw new Error("Pointer target missing: " + selector);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target });
    };
    const key = async (name, code) => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
    };
    await move(toggle);
    await waitFor(() => cdp.evaluate('!!document.querySelector(".sidebar.is-floating")'), "native pointer hover opens preview");
    const preview = await measure();
    check(Math.abs(preview.main - baseline.main) <= 1 && preview.windowWidth === baseline.windowWidth,
      "hover preview preserves chat and native window width", JSON.stringify({ baseline, preview }));
    await waitFor(() => browser.evaluate("document.hidden"), "preview hides the native Browser view");
    check(true, "native Browser yields to the floating navigation");
    await move(".sidebar-header");
    await key("Escape", 27);
    await waitFor(() => cdp.evaluate('!document.querySelector(".sidebar.is-floating")'), "Escape closes preview");
    await waitFor(() => browser.evaluate("!document.hidden"), "dismissal restores native Browser");
    check(await cdp.evaluate('document.activeElement?.matches(\'[data-nav="toggle-sidebar"]\')'),
      "Escape restores focus to the connected titlebar trigger");
    await key("ArrowDown", 40);
    await waitFor(() => cdp.evaluate('!!document.querySelector(".sidebar.is-floating") && !!document.activeElement?.closest(".sidebar")'), "keyboard entry focuses navigation");
    check(true, "ArrowDown opens the actual sidebar with keyboard focus");
    await key("Escape", 27);
    await waitFor(() => cdp.evaluate('!document.querySelector(".sidebar.is-floating")'), "keyboard preview closes");
    await move(".main-pane");
    await move(toggle);
    await waitFor(() => cdp.evaluate('!!document.querySelector(".sidebar.is-floating")'), "preview reopens before docking");
    await cdp.evaluate('document.querySelector(\'.sidebar [data-nav="toggle-sidebar"]\').click()');
    await waitFor(() => cdp.evaluate('!!document.querySelector(".sidebar:not(.is-floating)")'), "header docks existing sidebar");
    check(true, "preview header docks navigation without replacing its model");
  } finally {
    browser.ws.close();
  }
}
