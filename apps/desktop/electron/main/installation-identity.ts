import { randomUUID } from "node:crypto";

/** Local-only: never include this ref in portable configuration or account data. */
const INSTALLATION_ID_REF = "secret:installation:oauth-device-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

/** Owned by the main-process OAuth service, not by a provider/account. */
export function createInstallationIdentity(
  call: HostCall,
  newId: () => string = randomUUID,
): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= Promise.resolve().then(async () => {
      try {
        const { value } = await call<{ value?: string | null }>(
          "secrets.getForRuntime",
          { secretRef: INSTALLATION_ID_REF },
        );
        if (value != null) {
          if (!UUID.test(value)) throw new Error("invalid installation identity");
          return value;
        }
        const id = newId();
        if (!UUID.test(id)) throw new Error("invalid generated installation identity");
        // Never expose an identity to a flow until persistence has succeeded.
        await call("secrets.set", { secretRef: INSTALLATION_ID_REF, value: id });
        return id;
      } catch {
        // Host/backend errors may contain values. Keep failure observable but
        // do not pass their text to OAuth's renderer events or ordinary logs.
        pending = undefined;
        throw new Error("Could not load or persist the OAuth installation identity");
      }
    });
    return pending;
  };
}
