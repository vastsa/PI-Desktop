import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

/** Renderer placeholder for the host-owned isolated Settings extension view. */
export function PluginSettingsDestination({ pluginId, destinationId, label }: {
  pluginId: string;
  destinationId: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void api.pluginSettingsViewOpen(pluginId, destinationId).then(
      () => { if (live) setFailed(false); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [pluginId, destinationId]);
  useEffect(() => {
    if (failed) return;
    void api.pluginSettingsViewSetVisible(pluginId, destinationId, true);
    return () => { void api.pluginSettingsViewSetVisible(pluginId, destinationId, false); };
  }, [pluginId, destinationId, failed]);
  useEffect(() => {
    const node = ref.current;
    if (!node || failed) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        void api.pluginSettingsViewSetBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(node);
    window.addEventListener("resize", report);
    report();
    return () => { observer.disconnect(); window.removeEventListener("resize", report); cancelAnimationFrame(frame); };
  }, [pluginId, destinationId, failed]);
  if (failed) return <div className="settings-recovery" role="status">Unable to load {label}.</div>;
  return <div ref={ref} className="plugin-settings-destination" aria-label={label} />;
}
