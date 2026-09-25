/**
 * Mounts once per app window and keeps its plugin renderer modules in step
 * with the plugin list and the open project (`rendererLoadSpecs`): a plugin
 * loads when it becomes eligible, reloads when the main process hands out a
 * new generation, and unloads — taking its registrations and style sheets
 * along — when it stops being eligible or the host goes away.
 */
import { useEffect } from "react";
import { useAppStore } from "../../stores/app-store";
import { installRendererImportMap } from "./import-map";
import { rendererLoadSpecs, rendererModules } from "./loader";
import "../renderer-slots/slot-shell.css";

export function PluginRendererHost(): null {
  const plugins = useAppStore((state) => state.plugins);
  const projectPath = useAppStore((state) => state.workspace?.path ?? null);

  useEffect(() => {
    // Plugin modules import bare `react`: the map must exist before the first.
    installRendererImportMap();
    rendererModules.sync(rendererLoadSpecs(plugins, projectPath));
  }, [plugins, projectPath]);

  useEffect(() => () => rendererModules.sync([]), []);

  return null;
}
