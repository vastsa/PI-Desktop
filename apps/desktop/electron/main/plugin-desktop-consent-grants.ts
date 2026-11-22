/**
 * Remembered consent for plugin-originated dangerous desktop operations.
 *
 * Only operations whose answer cannot approve anything on the user's behalf
 * may be remembered. `agent/askTool/resolve` answers a question the Agent
 * asked; the Agent still goes through the host's tool permission gate for
 * whatever it does next. Tool permissions, plan checkpoints, and trusted
 * extension prompts (which extensions use as safety gates) are approvals, so
 * remembering them would let the plugin, or a model behind it, approve every
 * later request without the user. They, and every destructive operation,
 * keep Deny / Allow once (issue #2504).
 */

/** `session` allows this plugin the same operation until the app quits. */
export type PluginDesktopConsentAnswer = "once" | "session" | "deny";

const REMEMBERABLE_OPERATIONS: ReadonlySet<string> = new Set(["agent/askTool/resolve"]);

export function canRememberDesktopConsent(operation: string): boolean {
  return REMEMBERABLE_OPERATIONS.has(operation);
}

/**
 * Anything that is not an explicit allow is a refusal. A `session` answer for
 * an operation that cannot be remembered is also a refusal, so a consent
 * service that offers the wrong button never widens a grant. `true` from a
 * boolean consent service means once.
 */
export function normalizeDesktopConsentAnswer(
  raw: unknown,
  operation: string,
): PluginDesktopConsentAnswer {
  if (raw === true || raw === "once") return "once";
  if (raw === "session" && canRememberDesktopConsent(operation)) return "session";
  return "deny";
}

/** In-memory grants, keyed by plugin id; never persisted. */
export class PluginDesktopConsentGrants {
  private readonly grants = new Map<string, Set<string>>();

  has(pluginId: string, operation: string): boolean {
    return canRememberDesktopConsent(operation) && this.grants.get(pluginId)?.has(operation) === true;
  }

  grant(pluginId: string, operation: string): void {
    if (!canRememberDesktopConsent(operation)) return;
    const operations = this.grants.get(pluginId) ?? new Set<string>();
    operations.add(operation);
    this.grants.set(pluginId, operations);
  }

  revoke(pluginId: string): void {
    this.grants.delete(pluginId);
  }
}
