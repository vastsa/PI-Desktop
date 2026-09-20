import { setTimeout as delay } from "node:timers/promises";

export async function checkSidebarRowStates({ cdp, check, waitFor, seed }) {
  const group = (key) => `[data-sidebar-project-group=${JSON.stringify(key)}]`;
  const row = (id) => `[data-sidebar-session-row=${JSON.stringify(id)}]`;
  const title = (key) => `${group(key)} .project-toggle`;
  const header = (key) => `${group(key)} .sidebar-session-group-header`;
  const transparent = "rgba(0, 0, 0, 0)";
  const originalTheme = await cdp.evaluate("document.documentElement.dataset.theme");

  const paint = (selector) => cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing row-state target');
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor, color: style.color,
      radius: style.borderRadius, transition: style.transition,
      duration: parseFloat(style.transitionDuration),
      outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
      focusVisible: element.matches(':focus-visible'), hovered: element.matches(':hover'),
      selected: element.classList.contains('active'),
      current: element.getAttribute('data-current-workspace'),
    };
  })()`);
  const point = async (selector) => {
    let target;
    await waitFor(async () => {
      target = await cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: 'nearest' });
        const box = element.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: hit === element || element.contains(hit) };
      })()`);
      return target?.hit;
    }, `row-state target is hittable: ${selector}`);
    return target;
  };
  const move = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await delay(180);
  };
  const hover = async (selector) => {
    const target = await point(selector);
    await move(target.x, target.y);
  };
  const click = async (selector) => {
    const target = await point(selector);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: target.x, y: target.y, button: "left", buttons: 1, clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1,
    });
  };
  const selectedIds = () => cdp.evaluate(`
    [...document.querySelectorAll('.thread-item.active')].map(el => el.dataset.sidebarSessionRow)
  `);
  const select = async (id) => {
    await click(`${row(id)} .thread-item-main`);
    await waitFor(async () => {
      const ids = await selectedIds();
      return ids.length === 1 && ids[0] === id;
    }, `only session ${id} is selected`);
    await move(600, 120);
  };
  const pressTab = async (reverse = false) => {
    const modifiers = reverse ? 8 : 0;
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers,
    });
  };

  try {
    await cdp.evaluate("window.dispatchEvent(new Event('focus'))");
    for (const theme of ["dark", "light"]) {
      await cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      const id = seed.alphaSessionIds[0];
      await select(id);
      const selectedRest = await paint(row(id));
      const groupRest = await paint(header(seed.paths.alpha));
      const context = await paint(group(seed.paths.alpha));
      check(
        groupRest.background === transparent && context.current === "true" && !context.selected &&
          selectedRest.selected && selectedRest.background !== transparent,
        `${theme} selected conversation is independent from the unfilled current workspace`,
        JSON.stringify({ groupRest, context, selectedRest }),
      );
      await hover(title(seed.paths.alpha));
      const groupHover = await paint(header(seed.paths.alpha));
      const titleHover = await paint(title(seed.paths.alpha));
      await hover(`${row(seed.alphaSessionIds[1])} .thread-item-main`);
      const rowHover = await paint(row(seed.alphaSessionIds[1]));
      check(
        groupHover.hovered && rowHover.hovered && groupHover.background !== transparent &&
          groupHover.background === rowHover.background && groupHover.color === rowHover.color &&
          groupHover.radius === rowHover.radius && groupHover.transition === rowHover.transition &&
          titleHover.background === transparent,
        `${theme} project and conversation hover share one row surface, never a nested title fill`,
        JSON.stringify({ groupHover, titleHover, rowHover }),
      );
      await hover(`${row(id)} .thread-item-main`);
      const selectedHover = await paint(row(id));
      check(
        selectedHover.hovered && selectedHover.background === selectedRest.background,
        `${theme} selected fill wins over hover without a second background`,
        JSON.stringify({ selectedRest, selectedHover }),
      );

      await hover(title(seed.paths.alpha));
      await cdp.evaluate("window.dispatchEvent(new Event('blur'))");
      await delay(180);
      const blurredHeader = await paint(header(seed.paths.alpha));
      const blurredSelected = await paint(row(id));
      check(
        blurredHeader.background === transparent && blurredSelected.background === selectedRest.background,
        `${theme} window-blur handling releases hover but preserves selection`,
        JSON.stringify({ blurredHeader, blurredSelected }),
      );
      await cdp.evaluate("window.dispatchEvent(new Event('focus'))");
      await hover(title(seed.paths.alpha));
      await cdp.evaluate(`document.querySelector(${JSON.stringify(group(seed.paths.alpha))}).classList.add('is-drop-target')`);
      await delay(180);
      const dropHover = await paint(header(seed.paths.alpha));
      check(
        dropHover.background !== groupHover.background && dropHover.outline === "solid",
        `${theme} drop-target styling retains priority over header hover`,
        JSON.stringify(dropHover),
      );
      await cdp.evaluate(`document.querySelector(${JSON.stringify(group(seed.paths.alpha))}).classList.remove('is-drop-target')`);

      await hover(`${header(seed.paths.alpha)} .sidebar-session-group-add`);
      const actionHover = await paint(`${header(seed.paths.alpha)} .sidebar-session-group-add`);
      check(
        actionHover.hovered && actionHover.background !== transparent &&
          (await paint(title(seed.paths.alpha))).background === transparent,
        `${theme} independent project action keeps its own hover feedback`,
        JSON.stringify(actionHover),
      );
      await move(600, 120);
      await cdp.evaluate(`document.querySelector(${JSON.stringify(title(seed.paths.alpha))}).focus()`);
      await pressTab();
      await pressTab(true);
      const focusedTitle = await paint(title(seed.paths.alpha));
      check(
        focusedTitle.focusVisible && focusedTitle.outline !== "none" && focusedTitle.outlineWidth > 0 &&
          focusedTitle.background === transparent && (await paint(header(seed.paths.alpha))).background === transparent,
        `${theme} keyboard focus has an outline without a second selection surface`,
        JSON.stringify(focusedTitle),
      );
      await click(title(seed.paths.alpha));
      await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(group(seed.paths.alpha) + ' .sidebar-session-group-body')}).inert`), "selected group folds");
      await move(600, 120);
      check(
        (await selectedIds()).join() === id && (await paint(header(seed.paths.alpha))).background === transparent,
        `${theme} folding a selected conversation never transfers selection to its project`,
      );
      await click(title(seed.paths.alpha));
      await waitFor(() => cdp.evaluate(`!document.querySelector(${JSON.stringify(group(seed.paths.alpha) + ' .sidebar-session-group-body')}).inert`), "selected group reopens");
      await delay(250);

      const pinnedId = seed.pinnedSessionIds[0];
      await select(pinnedId);
      check(
        (await paint(group(seed.paths.delta))).current === "true" &&
          (await paint(header(seed.paths.delta))).background === transparent &&
          (await paint(row(pinnedId))).background === selectedRest.background,
        `${theme} pinned conversations use the same selection without selecting their group`,
      );
      await select("e2e-state-standalone");
      check(
        (await paint(row("e2e-state-standalone"))).background === selectedRest.background &&
          await cdp.evaluate("!document.querySelector('.project-group.active') && !document.querySelector('[data-current-workspace]')"),
        `${theme} standalone conversation selection clears workspace context without selecting a group`,
      );
      await select(id);
      await click('[data-nav="settings"]');
      await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-shell')"), "settings opens");
      await move(600, 120);
      check(
        (await selectedIds()).length === 0 && await cdp.evaluate("!document.querySelector('.sidebar')"),
        `${theme} settings replaces navigation without leaving stale selected rows`,
      );
      await click('[data-nav="back-to-app"]');
      await waitFor(() => cdp.evaluate("!!document.querySelector('.sidebar')"), "sidebar returns from settings");
      await move(600, 120);
      check(
        (await selectedIds()).join() === id && (await paint(group(seed.paths.alpha))).current === "true" &&
          (await paint(header(seed.paths.alpha))).background === transparent,
        `${theme} returning from settings restores conversation selection and independent workspace context`,
      );
    }
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const reducedHeader = await paint(header(seed.paths.alpha));
    const reducedRow = await paint(row(seed.alphaSessionIds[0]));
    check(
      reducedHeader.duration <= 0.00001 && reducedRow.duration <= 0.00001,
      "reduced motion suppresses both project and conversation hover transitions",
      JSON.stringify({ reducedHeader, reducedRow }),
    );
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)};
      document.querySelectorAll('.project-group.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
      window.dispatchEvent(new Event('focus'));
    })()`);
  }
}
