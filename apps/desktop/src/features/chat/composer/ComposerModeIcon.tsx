import type { Mode } from "@pi-desktop/shared";
import { IconListChecks, IconShield, IconTarget } from "../../../components/icons";

export function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "plan") return <IconListChecks size={14} />;
  if (mode === "goal") return <IconTarget size={14} />;
  return <IconShield size={14} />;
}
