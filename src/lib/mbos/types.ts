/* ---------------------------------------------------------------------------
 * The wire shapes of PROTOCOL.md §4 and §6.
 *
 * Pure types and pure vocabulary, in their own file with no `server-only` on
 * it, because both ends of the contract have to be able to read them: the
 * route that parses a request, the service that answers it, and — when the
 * handset is written against a generated client — the app itself.
 *
 * Nothing here validates. Validation is Zod in the action, at the point the
 * payload is about to become a row.
 * ------------------------------------------------------------------------- */

/** PROTOCOL §6. Every refusal names one of these, and nothing invents another. */
export const REJECTION_CODES = [
  "credit_blocked",
  "credit_exceeded",
  "product_inactive",
  "price_changed",
  "bill_settled",
  "outstanding_stale",
  "duplicate",
  "validation",
  "not_permitted",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

/**
 * What the outbox may carry. The server refuses anything else by name rather
 * than guessing — an entity type nobody implemented must not be accepted and
 * silently dropped, because the handset would mark it `synced` and the record
 * would exist nowhere.
 */
export const SYNC_ENTITY_TYPES = [
  "visit",
  "order",
  "payment",
  "complaint",
  "sample",
  "lead",
  "task",
  "expense",
  "attendance",
  "customer",
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export type SyncOp = "create" | "update";

export type SyncItem = {
  queueId: string;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  /** `<entityId>:<op>:<payloadHash>`. Mandatory — see PROTOCOL §4. */
  idempotencyKey: string;
  clientCreatedAt: number;
  dependsOn?: string[];
  payload: Record<string, unknown>;
};

export type SyncRequest = {
  deviceId: string;
  cursor?: string | null;
  items?: SyncItem[];
};

export type SyncResult =
  | {
      queueId: string;
      status: "accepted";
      serverId: string;
      /** The number from the configured series, where the entity gets one. */
      serverNumber?: string;
      serverReceivedAt: number;
    }
  | {
      queueId: string;
      status: "rejected";
      code: RejectionCode;
      message: string;
      /** Client ids in this batch that depended on the refused record. */
      blocks: string[];
    }
  | {
      queueId: string;
      status: "retry";
      code: RejectionCode | "dependency_missing";
      message: string;
    }
  | {
      queueId: string;
      status: "conflict";
      serverVersion: Record<string, unknown>;
      resolution: "server_wins" | "client_wins";
    };

export type PullDelta = {
  cursor: string;
  customers: unknown[];
  products: unknown[];
  timeline: unknown[];
  config: Record<string, unknown>;
  notifications: unknown[];
};

export type SyncResponse = {
  results: SyncResult[];
  pull: PullDelta;
};
