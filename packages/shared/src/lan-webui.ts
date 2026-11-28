/**
 * The direct-to-Desktop LAN browser profile (proposed WebUI MVP).
 * No native paths, host RPC or provider secrets cross this boundary.
 */
export const LAN_TEMPORARY_PROJECT = "__temporary__";
export interface LanProject {
  id: string;
  label: string;
  pinned: boolean;
  archived: boolean;
  revision: string;
}
export type LanSessionStatus = "idle" | "running" | "waiting";
export interface LanSession {
  id: string;
  projectId: string | null;
  title: string;
  pinned: boolean;
  archived: boolean;
  revision: string;
  /** Visible, but not writable from the browser (e.g. Plan/Goal sessions). */
  readOnly: boolean;
  status: LanSessionStatus;
  updatedAt: string;
  /**
   * Display name of the owning project, so cross-project lists can say where a
   * conversation lives. `null` for temporary conversations. Optional: absent
   * from responses of builds that predate it.
   */
  projectLabel?: string | null;
}
export interface LanPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface LanMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}
export interface LanConversation {
  session: LanSession;
  messages: LanPage<LanMessage>;
  /** Streaming assistant text of the active turn, not yet persisted. */
  liveText: string | null;
  activeTurnId: string | null;
  waiting: "approval" | "input" | null;
  queue: Array<{ id: string; text: string }>;
  modelLabel: string | null;
  /** Whether the session is eligible for model changes when idle. */
  canSelectModel?: boolean;
}
export interface LanModelRef {
  providerId: string;
  modelId: string;
}
/** An intentionally narrow projection of a configured chat model. */
export interface LanModelOption extends LanModelRef {
  label: string;
  providerLabel: string;
}
export interface LanModelCatalog {
  items: LanModelOption[];
  selected: LanModelRef | null;
  revision: string;
}
export interface LanDevice {
  id: string;
  label: string;
  lastActiveAt: number;
}
export interface LanInterface {
  address: string;
  name: string;
}
export interface LanAdminView {
  /** Saved preference; a failed bind can leave the service enabled but not running. */
  enabled: boolean;
  running: boolean;
  origin: string | null;
  /** Last successfully selected binding, even when unavailable or disabled. */
  address: string | null;
  port: number | null;
  code: { value: string; expiresAt: number } | null;
  devices: LanDevice[];
  interfaces: LanInterface[];
  error: string | null;
}
export type LanAdminAction =
  | { kind: "state" | "stop" | "issueCode" }
  | { kind: "start"; address: string; port: number }
  | { kind: "revoke"; id: string }
  /** The renderer applied organization patches up to `seq`. */
  | { kind: "ack"; seq: number };

export type LanOrganizationPatch =
  | { kind: "project"; key: string; patch: { name?: string; pinned?: boolean; archived?: boolean } }
  | { kind: "session"; key: string; patch: { pinned?: boolean; archived?: boolean; manualTitle?: boolean } };
export interface LanCatalogChangedEvent {
  seq: number;
  patches: LanOrganizationPatch[];
}
