import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { SessionThinkingLevel } from "@pi-desktop/shared";
import { ThinkingLevelSlider } from "../../apps/desktop/src/features/chat/composer/ThinkingLevelSlider";

const levels: SessionThinkingLevel[] = ["omit", "off", "low", "high", "max"];
type Pending = { level: SessionThinkingLevel; finish: (accepted: boolean) => void };

declare global { var thinkingSliderMotionProbe: () => Promise<unknown>; }
globalThis.thinkingSliderMotionProbe = async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let deferred = false;
  const pending: Pending[] = [];
  const requested: SessionThinkingLevel[] = [];
  const checks: string[] = [];
  function Fixture({ ladder = levels }: { ladder?: SessionThinkingLevel[] }) {
    const [level, setLevel] = useState<SessionThinkingLevel>("omit");
    return <div style={{ width: 286 }}><ThinkingLevelSlider levels={ladder} level={level}
      label="Reasoning level" commit={async (next) => {
        requested.push(next);
        if (deferred) return new Promise<boolean>((resolve) => pending.push({ level: next, finish: (accepted) => {
          if (accepted) setLevel(next);
          resolve(accepted);
        } }));
        setLevel(next);
        return true;
      }} /></div>;
  }
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const node = (selector: string) => {
    const result = host.querySelector<HTMLElement>(selector);
    if (!result) throw new Error(`Missing ${selector}`);
    return result;
  };
  const center = (element: HTMLElement) => { const r = element.getBoundingClientRect(); return r.left + r.width / 2; };
  const thumb = () => node(".composer-thinking-thumb");
  const value = () => node("input").getAttribute("aria-valuetext");
  const click = (level: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === level);
    if (!button) throw new Error(`Missing stop ${level}`);
    flushSync(() => button.click());
  };
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); checks.push(message); };
  const finish = async () => {
    for (const animation of host.getAnimations({ subtree: true })) animation.finish();
    await frame();
  };
  const mount = async (key: string, ladder = levels) => {
    flushSync(() => root.render(<Fixture key={key} ladder={ladder} />));
    await frame();
    // Establish the initial rendered position before requesting a transition.
    center(thumb());
  };
  try {
    await mount("motion");
    const initial = center(thumb());
    const end = center(node(".composer-thinking-dot:last-child"));
    click("max");
    await frame();
    const animation = thumb().getAnimations()[0];
    assert(Boolean(animation), "click creates a thumb transition");
    animation.pause();
    animation.currentTime = Number(animation.effect?.getTiming().duration) / 2;
    const midway = center(thumb());
    assert(midway > initial + 1 && midway < end - 1, "thumb passes through intermediate positions");
    assert(value() === "max", "selected value updates before animation completes");
    click("low");
    const redirected = center(thumb());
    assert(Math.abs(redirected - midway) < 1, "rapid click starts from the current visual position");
    await finish();
    assert(Math.abs(center(thumb()) - center(node(".composer-thinking-dot.active"))) < 0.6, "redirected thumb lands on the selected dot");
    assert(requested.join(",") === "max,low", "animation never commits intermediate levels");

    deferred = true;
    click("high");
    await finish();
    assert(value() === "high", "pending save keeps optimistic selection");
    flushSync(() => pending.shift()?.finish(false));
    await frame();
    await finish();
    assert(value() === "low", "failed save restores the confirmed level");
    click("high");
    click("max");
    flushSync(() => pending.shift()?.finish(false));
    await frame();
    assert(value() === "max", "stale failure does not overwrite a newer selection");
    flushSync(() => pending.shift()?.finish(true));
    await frame();
    await finish();
    assert(value() === "max", "latest successful save settles at its target");

    click("high");
    click("max");
    flushSync(() => pending.shift()?.finish(true));
    await frame();
    assert(value() === "max", "returning to the confirmed level survives an older successful save");
    flushSync(() => pending.shift()?.finish(true));
    await frame();
    await finish();
    assert(value() === "max", "return-to-current request settles after the earlier write");

    click("low");
    await mount("reopened");
    assert(value() === "omit" && thumb().getAnimations().length === 0, "remount opens at the confirmed position without travel");
    flushSync(() => pending.shift()?.finish(false));
    await frame();
    assert(value() === "omit", "completion after unmount cannot change the new slider");
    deferred = false;
    for (const ladder of [levels.slice(0, 3), levels, ["omit", "off", "minimal", "low", "medium", "high", "max"] as SessionThinkingLevel[], ["omit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as SessionThinkingLevel[]]) {
      await mount(`ladder-${ladder.length}`, ladder);
      for (const level of ladder) {
        click(level);
        await finish();
        const tick = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === level)!;
        assert(Math.abs(center(thumb()) - center(tick)) < 0.6, `${ladder.length} stops: ${level} thumb and label align`);
        const rail = node(".composer-thinking-rail");
        const fill = getComputedStyle(rail, "::after");
        const fillLeft = rail.getBoundingClientRect().left + Number.parseFloat(fill.left);
        const firstDot = node(".composer-thinking-dot").getBoundingClientRect();
        assert(Math.abs(fillLeft - firstDot.left) < 0.05, `${ladder.length} stops: ${level} fill covers the first dot's left edge`);
        assert(Math.abs(fillLeft + Number.parseFloat(fill.width) - center(thumb())) < 0.05, `${ladder.length} stops: ${level} fill still ends at the thumb center`);
      }
    }
    return { ok: true, checks };
  } catch (error) {
    return { ok: false, checks, error: String(error) };
  } finally {
    root.unmount();
    host.remove();
  }
};
