/**
 * Who may use the panel bridge, and what happens to a call that arrives while
 * its page is going away.
 *
 * A panel surface (detached window, floating widget, docked work-panel view) is
 * registered before its page loads and torn down after the page is gone, but the
 * page can still call the bridge in between: a timer that fired as the host
 * started closing it, or an unload handler. Identity therefore belongs to the
 * page — the web contents — and not to the host's record of which surfaces are
 * currently open, which is already being emptied by the time those calls arrive.
 */

export type PanelInvocation =
  | { readonly kind: "bridge"; readonly pluginId: string }
  | { readonly kind: "gone" }
  | { readonly kind: "foreign" };

const GONE: PanelInvocation = { kind: "gone" };

/**
 * What a panel bridge call from an already resolved sender has to do.
 *
 * `senderGone` means the page that sent the call no longer exists. Its answer
 * can never be read, and the work it asks for would run against a plugin runtime
 * or host that the same teardown is stopping, so the call is settled instead of
 * failing: a rejection here is logged in the main process with no way to tell it
 * apart from a panel reaching outside its own plugin.
 */
export function resolvePanelInvocation(
  pluginId: string | null,
  senderGone: boolean,
): PanelInvocation {
  if (senderGone) return GONE;
  return pluginId ? { kind: "bridge", pluginId } : { kind: "foreign" };
}

/**
 * Identity of the pages allowed to use the panel bridge, keyed by web contents
 * id. Registration happens before the page can load, and release when that page
 * is gone — never when its surface is merely asked to close.
 */
export class PanelSenders {
  private pluginIds = new Map<number, string>();

  register(senderId: number, pluginId: string): void {
    this.pluginIds.set(senderId, pluginId);
  }

  release(senderId: number): void {
    this.pluginIds.delete(senderId);
  }

  pluginFor(senderId: number): string | null {
    return this.pluginIds.get(senderId) ?? null;
  }
}

/**
 * How long a page is given to disappear before a shutdown moves on without it.
 * A page that refuses to close (`beforeunload`) must not hold up the quit.
 */
export const PLUGIN_PAGE_CLOSE_SETTLE_MS = 1_000;

type ClosablePage = {
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
};

/**
 * Resolve once a page is destroyed, or once it has had `budgetMs` to go. Used by
 * shutdown to keep the plugin runtime and the host alive until the pages that
 * call them are gone.
 */
export function pageGoneWithin(
  page: ClosablePage,
  budgetMs: number = PLUGIN_PAGE_CLOSE_SETTLE_MS,
): Promise<void> {
  if (page.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, budgetMs);
    function finish(): void {
      clearTimeout(timer);
      page.removeListener("destroyed", finish);
      resolve();
    }
    page.once("destroyed", finish);
  });
}
