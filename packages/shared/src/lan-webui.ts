/**
 * The direct-to-Desktop LAN browser profile (proposed WebUI MVP).
 * No native paths, host RPC or provider secrets cross this boundary.
 */
export interface LanGrants {
  /** Host project group ids the device may see. */
  projectIds: string[];
  /** Temporary (projectless) conversations. */
  temporary: boolean;
  /** Create sessions, send, queue, stop. */
  chat: boolean;
  /** Rename, pin, archive and restore. */
  organize: boolean;
}
export interface LanAccess extends LanGrants {
  deviceId: string;
}
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
}
export interface LanDevice {
  id: string;
  label: string;
  lastActiveAt: number;
  grants: LanGrants;
}
export interface LanPairing {
  id: string;
  label: string;
  createdAt: number;
}
export interface LanInterface {
  address: string;
  name: string;
}
export interface LanAdminView {
  running: boolean;
  origin: string | null;
  address: string | null;
  port: number | null;
  code: { value: string; expiresAt: number } | null;
  pending: LanPairing[];
  devices: LanDevice[];
  interfaces: LanInterface[];
  projects: Array<{ id: string; label: string }>;
  error: string | null;
}
export type LanAdminAction =
  | { kind: "state" | "stop" | "issueCode" }
  | { kind: "start"; address: string; port: number }
  | { kind: "confirm"; id: string; grants: LanGrants }
  /** Change what an already paired device may see and do. */
  | { kind: "update"; id: string; grants: LanGrants }
  | { kind: "deny" | "revoke"; id: string }
  /** The renderer applied organization patches up to `seq`. */
  | { kind: "ack"; seq: number };

export type LanOrganizationPatch =
  | { kind: "project"; key: string; patch: { name?: string; pinned?: boolean; archived?: boolean } }
  | { kind: "session"; key: string; patch: { pinned?: boolean; archived?: boolean; manualTitle?: boolean } };
export interface LanCatalogChangedEvent {
  seq: number;
  patches: LanOrganizationPatch[];
}
