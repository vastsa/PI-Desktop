import { expect, it } from "vitest";
import type { PluginHostApi, PluginShellLayout } from "./index.js";

it("types shell layout listeners and preserves generic host events", () => {
  const observed: string[] = [];
  const events = {
    on: (event: string) => { observed.push(event); },
    off: (event: string) => { observed.push(event); },
  } as PluginHostApi["events"];
  const listener = (layout: PluginShellLayout) => { void layout.sidebar.width; };
  events.on("shell:layout", listener);
  events.off("shell:layout", listener);
  events.on("existing:event", (...args: unknown[]) => { void args; });
  expect(observed).toEqual(["shell:layout", "shell:layout", "existing:event"]);
});
