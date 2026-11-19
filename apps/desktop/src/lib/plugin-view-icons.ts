import type { ComponentType } from "react";
import type { IconProps } from "../components/icons";
import {
  IconBell,
  IconBookOpen,
  IconBot,
  IconBranch,
  IconBrowser,
  IconChat,
  IconClock,
  IconDiff,
  IconFileText,
  IconFolder,
  IconImage,
  IconKey,
  IconLink,
  IconListChecks,
  IconPalette,
  IconPlug,
  IconPullRequest,
  IconSearch,
  IconServer,
  IconShield,
  IconSparkles,
  IconTarget,
  IconTerminal,
  IconWorkflow,
  IconWrench,
} from "../components/icons";

/**
 * Icon tokens a plugin may name for a contributed work panel view (ADR 0104).
 *
 * The manifest carries a token, never markup: the icon is drawn inside host
 * chrome next to first-party controls, so plugin SVG there would be an
 * injection surface and would let a plugin dress up as the host. The keys are
 * the SDK's `PLUGIN_VIEW_ICONS`; the `plugin-work-panel-views` test compares
 * the two lists so they cannot drift apart.
 */
const PLUGIN_VIEW_ICON_MAP: Record<string, ComponentType<IconProps>> = {
  bell: IconBell,
  book: IconBookOpen,
  bot: IconBot,
  branch: IconBranch,
  browser: IconBrowser,
  chat: IconChat,
  clock: IconClock,
  diff: IconDiff,
  files: IconFileText,
  folder: IconFolder,
  image: IconImage,
  key: IconKey,
  link: IconLink,
  "list-checks": IconListChecks,
  palette: IconPalette,
  plug: IconPlug,
  "pull-request": IconPullRequest,
  search: IconSearch,
  server: IconServer,
  shield: IconShield,
  sparkles: IconSparkles,
  target: IconTarget,
  terminal: IconTerminal,
  workflow: IconWorkflow,
  wrench: IconWrench,
};

/**
 * The component for a token, or `null` when the plugin named something this
 * build does not know. A null is not an error: the caller draws a lettered tile
 * instead, so a plugin written against a newer host still lists correctly.
 */
export function pluginViewIcon(
  token: string | undefined,
): ComponentType<IconProps> | null {
  if (!token || !Object.hasOwn(PLUGIN_VIEW_ICON_MAP, token)) return null;
  return PLUGIN_VIEW_ICON_MAP[token];
}

/** First character of a view title, for the fallback tile. */
export function pluginViewInitial(title: string): string {
  return [...title.trim()][0]?.toUpperCase() ?? "?";
}
