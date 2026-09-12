/**
 * The host surface the agent runtime depends on.
 *
 * The sidecar reaches Electron main through `ParentHostProxy`; tests hand the
 * runtime a stub. The runtime only ever calls the three members below, so
 * this module declares that contract instead of a client implementation:
 * the former stdio `HostClient` class that spawned host-core directly had no
 * caller left once host access moved behind main (see `sidecar.ts`).
 */
export type HostCloseHandler = (error: Error) => void;

export type HostNotificationHandler = (method: string, params: unknown) => void;

export interface RuntimeHost {
  /** JSON-RPC call to the host; rejects with the host's error on failure. */
  call<T = unknown>(
    method: string,
    params?: unknown,
    timeoutOverrideMs?: number,
  ): Promise<T>;
  /** Fires once when the host connection is lost; returns an unsubscribe. */
  onClose?(handler: HostCloseHandler): () => void;
  /** Host-originated notifications (tool output streams); returns an unsubscribe. */
  onNotification?(handler: HostNotificationHandler): () => void;
}
