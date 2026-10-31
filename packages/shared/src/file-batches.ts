/** Internal runtime/Host protocol. These bindings never grant file permission. */
export const FILE_BATCH_VERSION = 1;
export interface FileBatchCapability {
  version: number;
  supported: boolean;
}
export interface FileBatchRegistration {
  sessionId: string;
  delegationId?: string;
  batchId: string;
  ordinal: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
}
export interface FileBatchTicket { ticket: string }
