import { useEffect, useState, type AnimationEvent } from "react";

type SidebarTransition = {
  collapsed: boolean;
  presented: boolean;
  phase: "idle" | "entering" | "exiting";
};

export function nextSidebarTransition(
  previous: SidebarTransition,
  collapsed: boolean,
  presented: boolean,
): SidebarTransition {
  if (previous.collapsed === collapsed && previous.presented === presented) return previous;
  const phase = presented && previous.presented && previous.collapsed !== collapsed
    ? collapsed ? "exiting" : "entering"
    : "idle";
  return { collapsed, presented, phase };
}

export function useSidebarTransition(collapsed: boolean, presented: boolean) {
  const [transition, setTransition] = useState<SidebarTransition>({ collapsed, presented, phase: "idle" });
  const current = nextSidebarTransition(transition, collapsed, presented);
  if (current !== transition) setTransition(current);

  useEffect(() => {
    if (current.phase === "idle") return;
    const timer = window.setTimeout(() => {
      setTransition((state) => state === current ? { ...state, phase: "idle" } : state);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [current]);

  const handleSidebarAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const expected = current.phase === "entering" ? "sidebar-in" : "sidebar-out";
    if (current.phase === "idle" || !event.animationName.startsWith(expected)) return;
    setTransition((state) => state === current ? { ...state, phase: "idle" } : state);
  };

  return {
    sidebarEntering: current.phase === "entering",
    sidebarExiting: current.phase === "exiting",
    handleSidebarAnimationEnd,
  };
}
