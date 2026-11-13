import type { WebContents } from "electron";

/** Keep renderer-controlled navigation inside the authorized app shell. */
export function registerAppShellNavigationGuard(
  contents: Pick<WebContents, "on" | "getURL">,
  options: { developmentUrl?: string; onBlocked: (url: string) => void },
): void {
  contents.on("will-navigate", (event, url) => {
    if (options.developmentUrl && url.startsWith(options.developmentUrl)) return;
    // window.location.reload() emits will-navigate in a packaged file shell.
    // Allow only the exact document already authorized by Main, not other files.
    if (url.startsWith("file:") && url === contents.getURL()) return;
    event.preventDefault();
    options.onBlocked(url);
  });
}
