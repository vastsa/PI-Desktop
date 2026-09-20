import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function checkSidebarSettings({ cdp, check, waitFor, artifactDir }) {
  const original = await cdp.evaluate(`({
    platform: document.documentElement.dataset.platform,
    theme: document.documentElement.dataset.theme,
    style: document.documentElement.getAttribute('style'),
  })`);
  const capture = async (name) => {
    if (!artifactDir) return;
    await mkdir(artifactDir, { recursive: true });
    const image = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(artifactDir, `${name}.png`), Buffer.from(image.data, "base64"));
  };
  const click = async (selector) => {
    let target;
    await waitFor(async () => {
      target = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest' });
        const rect = el.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: hit === el || el.contains(hit) };
      })()`);
      return target?.hit;
    }, `settings probe target: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type, x: target.x, y: target.y, button: "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
      });
    }
  };
  const settingsShortcut = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type, key: ",", code: "Comma", windowsVirtualKeyCode: 188,
        modifiers: original.platform === "darwin" ? 4 : 2,
      });
    }
  };
  const material = (selector) => cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const ancestors = [];
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(getComputedStyle(parent).backgroundColor);
    }
    return {
      color: style.backgroundColor, image: style.backgroundImage,
      size: style.backgroundSize, repeat: style.backgroundRepeat,
      animation: style.animationName, opacity: style.opacity,
      width: rect.width, height: rect.height, top: rect.top, ancestors,
      content: getComputedStyle(document.querySelector('.settings-content, .main-pane')).backgroundColor,
      titlebar: document.querySelector('.settings-titlebar')
        ? getComputedStyle(document.querySelector('.settings-titlebar')).backgroundColor : null,
      shellAnimation: document.querySelector('.settings-shell')
        ? getComputedStyle(document.querySelector('.settings-shell')).animationName : null,
    };
  })()`);
  const startTrace = async () => {
    await cdp.evaluate(`(() => {
      window.__settingsSidebarTrace?.stop();
      const trace = { frames: [], animations: [] };
      const sample = () => {
        const el = document.querySelector('.sidebar');
        if (el) trace.frames.push({ width: el.getBoundingClientRect().width,
          animation: getComputedStyle(el).animationName });
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.querySelector('.app-shell'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      const onStart = event => {
        if (event.target.matches('.sidebar')) trace.animations.push(event.animationName);
      };
      document.addEventListener('animationstart', onStart, true);
      trace.stop = () => { observer.disconnect(); document.removeEventListener('animationstart', onStart, true); };
      window.__settingsSidebarTrace = trace;
    })()`);
  };
  const finishTrace = async () => {
    for (let i = 0; i < 24; i++) {
      await cdp.evaluate(`(() => {
        const el = document.querySelector('.sidebar');
        if (el) window.__settingsSidebarTrace.frames.push({ width: el.getBoundingClientRect().width,
          animation: getComputedStyle(el).animationName });
      })()`);
      await delay(10);
    }
    return cdp.evaluate(`(() => {
      const trace = window.__settingsSidebarTrace;
      trace.stop();
      return { frames: trace.frames, animations: trace.animations };
    })()`);
  };
  const returnToApp = async (width, label, collapsed = false) => {
    await startTrace();
    await click('[data-nav="back-to-app"]');
    await waitFor(() => cdp.evaluate("!document.querySelector('.settings-shell')"), "settings closes");
    const trace = await finishTrace();
    check(
      trace.animations.length === 0 && (collapsed
        ? trace.frames.length === 0
        : trace.frames.length > 0 && trace.frames.every(frame => Math.abs(frame.width - width) < 0.5 && frame.animation === "none")),
      `${label}: settings return restores layout without sidebar entrance`,
      JSON.stringify({ animations: trace.animations, widths: trace.frames.map(frame => Math.round(frame.width)) }),
    );
  };
  const toggle = '[data-nav="toggle-sidebar"]';

  try {
    await cdp.evaluate("window.dispatchEvent(new Event('focus'))");
    for (const platform of ["darwin", "win32", "linux"]) {
      for (const theme of ["dark", "light"]) {
        await cdp.evaluate(`Object.assign(document.documentElement.dataset, ${JSON.stringify({ platform, theme })})`);
        const home = await material('.sidebar');
        if (platform === original.platform) await capture(`home-${theme}`);
        await click('[data-nav="settings"]');
        await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-nav')"), "settings rail mounts");
        const settings = await material('.settings-nav');
        check(
          ["color", "image", "size", "repeat", "width", "height", "top"].every(key => home[key] === settings[key]) &&
            settings.animation === "none" && settings.shellAnimation === "none" && settings.opacity === "1",
          `${platform}/${theme}: home and settings share one stationary sidebar material`,
          JSON.stringify({ home, settings }),
        );
        check(
          settings.content === home.content && settings.titlebar === home.content &&
            (platform !== "darwin" || settings.ancestors.every(color => color === "rgba(0, 0, 0, 0)")),
          `${platform}/${theme}: sidebar ancestry reveals material while content and titlebar stay opaque`,
          JSON.stringify(settings),
        );
        if (platform === original.platform) {
          await delay(250);
          await capture(`settings-${theme}`);
        }
        await returnToApp(home.width, `${platform}/${theme}`);
      }
    }

    await cdp.evaluate(`document.documentElement.dataset.platform = ${JSON.stringify(original.platform)}`);
    for (const theme of ["dark", "light"]) {
      await cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      for (const kind of ["legacy", "canonical"]) {
        await cdp.evaluate(`(() => {
          const root = document.documentElement;
          root.style.setProperty('--ds-settings-rail-bg', '#243645');
          if (${JSON.stringify(kind)} === 'canonical') root.style.setProperty('--ds-bg-sidebar', '#39563d');
          root.style.setProperty('--ds-bg-sidebar-image', 'linear-gradient(180deg, #243645, #39563d)');
        })()`);
        const home = await material('.sidebar');
        await click('[data-nav="settings"]');
        await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-nav')"), "custom-theme settings mounts");
        const settings = await material('.settings-nav');
        const effective = await cdp.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ds-bg-sidebar').trim()");
        check(
          home.color === settings.color && home.image === settings.image &&
            effective === (kind === "legacy" ? "#243645" : "#39563d"),
          `${theme}/${kind}: theme colors and images affect both rails, canonical token wins`,
          JSON.stringify({ home: home.color, settings: settings.color, image: settings.image, effective }),
        );
        await returnToApp(home.width, `${theme}/${kind}`);
      }
      await cdp.evaluate(`(() => {
        for (const name of ['--ds-settings-rail-bg', '--ds-bg-sidebar', '--ds-bg-sidebar-image'])
          document.documentElement.style.removeProperty(name);
      })()`);
    }

    const width = (await material('.sidebar')).width;
    for (let i = 0; i < 3; i++) {
      await click('[data-nav="settings"]');
      await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-nav')"), "rapid settings navigation");
      await returnToApp(width, `rapid round trip ${i + 1}`);
    }

    await click(toggle);
    await waitFor(() => cdp.evaluate("!document.querySelector('.sidebar')"), "manual collapse completes");
    await settingsShortcut();
    await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-nav')"), "settings opens with sidebar collapsed");
    await returnToApp(width, "collapsed sidebar", true);
    await startTrace();
    await click('.ct-lead .ct-icon-btn');
    const expanded = await finishTrace();
    check(
      expanded.animations.includes("sidebar-in") && expanded.frames.some(frame => frame.width > 0 && frame.width < width - 1) &&
        Math.abs(expanded.frames.at(-1).width - width) < 0.5,
      "explicit reopen still plays sidebar entrance and restores full width",
      JSON.stringify({ animations: expanded.animations, widths: expanded.frames.map(frame => Math.round(frame.width)) }),
    );

    await click(toggle);
    await waitFor(() => cdp.evaluate("!document.querySelector('.sidebar')"), "collapse before interrupted entrance");
    await click('.ct-lead .ct-icon-btn');
    await settingsShortcut();
    await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-nav')"), "settings interrupts entrance");
    await returnToApp(width, "interrupted entrance");

    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await click('[data-nav="settings"]');
    await waitFor(() => cdp.evaluate("!!document.querySelector('.settings-nav')"), "reduced-motion settings");
    await returnToApp(width, "reduced motion");
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.evaluate(`(() => {
      window.__settingsSidebarTrace?.stop();
      delete window.__settingsSidebarTrace;
      const root = document.documentElement;
      root.dataset.platform = ${JSON.stringify(original.platform)};
      root.dataset.theme = ${JSON.stringify(original.theme)};
      ${original.style === null ? "root.removeAttribute('style')" : `root.setAttribute('style', ${JSON.stringify(original.style)})`};
    })()`);
  }
}
