/**
 * Where the GitHub connector keeps its credential (ADR github-connector).
 *
 * One JSON record under one fixed host-core secret reference, following the
 * `StoredMcpOAuthToken` precedent: the token, and beside it the account it
 * belongs to, so Settings can show who is connected without a network call.
 *
 * This is the only code that parses that value. Anything it cannot read back
 * as a whole, well-formed record is "not connected" — a damaged record never
 * yields a token — while a host failure is reported as a failure, because
 * "the secret store did not answer" must not look like "signed out".
 */
import {
  ErrorCodes,
  GITHUB_CONNECTOR_SECRET_REF,
  isGitHubTokenShape,
} from "@pi-desktop/shared";

export type StoredGitHubCredential = {
  version: 1;
  token: string;
  kind: "oauth" | "pat";
  login: string;
  name?: string;
  avatarUrl?: string;
  scopes: string[];
  savedAt: string;
};

export type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type GitHubConnectorStore = {
  /** The stored credential, or null when none is stored or it is unreadable. */
  read(): Promise<StoredGitHubCredential | null>;
  write(credential: StoredGitHubCredential): Promise<void>;
  clear(): Promise<void>;
};

const STORED_VERSION = 1;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rebuild a record field by field. Returns null for anything that is not a
 * complete version-1 credential; unknown fields are dropped.
 */
function parseStoredCredential(raw: string): StoredGitHubCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== STORED_VERSION) return null;
  if (typeof record.token !== "string" || !isGitHubTokenShape(record.token)) return null;
  if (record.kind !== "oauth" && record.kind !== "pat") return null;
  if (typeof record.login !== "string" || record.login.length === 0) return null;
  if (
    !Array.isArray(record.scopes) ||
    !record.scopes.every((scope): scope is string => typeof scope === "string")
  ) {
    return null;
  }
  if (typeof record.savedAt !== "string") return null;
  const credential: StoredGitHubCredential = {
    version: STORED_VERSION,
    token: record.token,
    kind: record.kind,
    login: record.login,
    scopes: [...record.scopes],
    savedAt: record.savedAt,
  };
  const name = optionalString(record.name);
  if (name !== undefined) credential.name = name;
  const avatarUrl = optionalString(record.avatarUrl);
  if (avatarUrl !== undefined) credential.avatarUrl = avatarUrl;
  return credential;
}

export function createGitHubConnectorStore(call: HostCall): GitHubConnectorStore {
  return {
    async read() {
      const result = await call<{ value: string | null }>("secrets.getForRuntime", {
        secretRef: GITHUB_CONNECTOR_SECRET_REF,
      });
      const raw = result?.value;
      if (typeof raw !== "string" || raw.length === 0) return null;
      return parseStoredCredential(raw);
    },
    async write(credential) {
      const value = JSON.stringify(credential);
      // Refuse what `read` would refuse: a record that cannot come back is a
      // sign-in that silently did not happen.
      if (!parseStoredCredential(value)) {
        throw Object.assign(new Error("The GitHub credential is not valid and was not saved."), {
          errorCode: ErrorCodes.GITHUB_INVALID_TOKEN,
        });
      }
      await call("secrets.set", { secretRef: GITHUB_CONNECTOR_SECRET_REF, value });
    },
    async clear() {
      await call("secrets.delete", { secretRef: GITHUB_CONNECTOR_SECRET_REF });
    },
  };
}
