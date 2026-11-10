import type { Mode } from "@pi-desktop/shared";
import {
  IconListChecks,
  IconShield,
  IconSparkles,
  IconTarget,
  IconWorkflow,
} from "../../../components/icons";

/** Builtins keep their glyphs; a user mode shows whether it runs in stages. */
export function ModeIcon({ mode, staged }: { mode: Mode; staged?: boolean }) {
  if (mode === "plan") return <IconListChecks size={14} />;
  if (mode === "goal") return <IconTarget size={14} />;
  if (mode === "agent" || staged === undefined) return <IconShield size={14} />;
  return staged ? <IconWorkflow size={14} /> : <IconSparkles size={14} />;
}
