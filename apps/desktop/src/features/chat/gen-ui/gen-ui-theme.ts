/**
 * Theme bridge for inline visualizations (ADR gen-ui-inline-visualization).
 *
 * The guest document has an opaque origin and cannot read the host's CSS, so
 * the host resolves its own design tokens and posts them as a small, stable
 * set of guest variables. Guest variable names are a contract with the shell
 * Electron Main serves; host token names may change freely behind this map.
 */

/**
 * Guest variable → host design token it is resolved from. The guest names are
 * the MCP Apps host-style variables the bundled visualize stylesheet derives
 * its agent-facing tokens (`--background`, `--foreground`, `--primary`, …)
 * from; see `apps/desktop/resources/gen-ui/visualize.css`.
 */
export const GEN_UI_THEME_TOKENS: Readonly<Record<string, string>> = {
  "--color-background-primary": "--ds-bg-primary",
  "--color-background-secondary": "--ds-bg-elevated-opaque",
  "--color-background-info": "--ds-accent-soft",
  "--color-text-primary": "--ds-text-primary",
  "--color-text-secondary": "--ds-text-muted",
  "--color-text-info": "--ds-accent",
  // Text on `--color-text-info` fills, as the primary button sets it.
  "--color-text-inverse": "--ds-bg-primary",
  "--color-text-warning": "--ds-warning",
  "--color-border-primary": "--ds-border-default",
  "--color-border-secondary": "--ds-border-subtle",
  "--color-ring-primary": "--ds-focus",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
};

/**
 * Resolve guest theme variables through `readToken` (normally a computed
 * style lookup). Tokens that resolve empty are omitted so the guest keeps its
 * own fallback instead of receiving a blank value.
 */
export function genUiThemeVars(readToken: (name: string) => string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [guestName, hostToken] of Object.entries(GEN_UI_THEME_TOKENS)) {
    const value = readToken(hostToken).trim();
    if (value) vars[guestName] = value;
  }
  return vars;
}

/** Guest theme variables resolved from the live document root. */
export function readDocumentGenUiTheme(): Record<string, string> {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  return genUiThemeVars((name) => style.getPropertyValue(name));
}

/**
 * The resolved light/dark scheme of the host. The visualize stylesheet uses
 * `light-dark()` fallbacks, so the guest must follow the host rather than the
 * OS preference.
 */
export function readDocumentGenUiColorScheme(): "light" | "dark" {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return "light";
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  return /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme) ? "dark" : "light";
}

/** What the host posts to a guest frame as `GEN_UI_THEME_MESSAGE`. */
export type GenUiThemePayload = { vars: Record<string, string>; colorScheme: "light" | "dark" };

export function readDocumentGenUiThemePayload(): GenUiThemePayload {
  return { vars: readDocumentGenUiTheme(), colorScheme: readDocumentGenUiColorScheme() };
}

export function sameGenUiTheme(a: GenUiThemePayload, b: GenUiThemePayload): boolean {
  if (a.colorScheme !== b.colorScheme) return false;
  const keys = Object.keys(a.vars);
  if (keys.length !== Object.keys(b.vars).length) return false;
  return keys.every((key) => a.vars[key] === b.vars[key]);
}

/**
 * One shared theme source for every frame. `observe` reports root mutations;
 * each mutation resolves the theme once and notifies subscribers only when the
 * resolved payload changed. The root `style` attribute is also rewritten for
 * layout (e.g. the composer height on every resize), which must not re-post
 * the theme to every frame.
 */
export function createGenUiThemeChannel(
  read: () => GenUiThemePayload,
  observe: (onMutation: () => void) => () => void,
) {
  const listeners = new Set<(payload: GenUiThemePayload) => void>();
  let last: GenUiThemePayload | null = null;
  let stop: (() => void) | null = null;
  const refresh = () => {
    const next = read();
    if (last && sameGenUiTheme(last, next)) return;
    last = next;
    for (const listener of [...listeners]) listener(next);
  };
  return {
    /** The theme resolved now, for a frame that just became ready. */
    current(): GenUiThemePayload {
      return read();
    },
    subscribe(listener: (payload: GenUiThemePayload) => void): () => void {
      listeners.add(listener);
      if (!stop) {
        last = read();
        stop = observe(refresh);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
          last = null;
        }
      };
    },
  };
}

/**
 * Attributes on the document root that change resolved tokens: the light/dark
 * switch, contributed plugin themes, and the inline font override.
 */
const THEME_ATTRIBUTES = ["data-theme", "data-plugin-theme", "style"];

const documentThemeChannel = createGenUiThemeChannel(readDocumentGenUiThemePayload, (onMutation) => {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => undefined;
  const observer = new MutationObserver(onMutation);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
  return () => observer.disconnect();
});

/** The host theme as guests should currently see it. */
export function currentGenUiTheme(): GenUiThemePayload {
  return documentThemeChannel.current();
}

/** Subscribe to resolved-theme changes; returns the unsubscribe function. */
export function subscribeGenUiTheme(listener: (payload: GenUiThemePayload) => void): () => void {
  return documentThemeChannel.subscribe(listener);
}
