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
  /*
   * The shop the goods were to go to is not on MahekOne any more.
   *
   * Its own code rather than `validation`, because it is not a malformed
   * payload — the handset sent something that was true when the salesman
   * stood in the shop and has since stopped being true, which is the same
   * shape as `outstanding_stale` and wants the same "sync and take it again"
   * answer rather than "this app has a bug".
   */
  "delivery_party_unknown",
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
  "leave",
  "approval",
  /**
   * The salesman's answer to a proposed day: agreed, or refused with a reason
   * and what he wants instead. A plan is agreed rather than issued, and this
   * is the half of that conversation the handset speaks.
   */
  "plan_day",
  /**
   * The shops he picked for a day he has agreed. The other half of the same
   * conversation: the office says which city, and the man who walks it says
   * which doors — he knows which of them are worth the walk on a Tuesday.
   */
  "plan_stops",
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
  /**
   * Where the salesman was when he did this.
   *
   * A SIBLING of the payload rather than a field inside it, deliberately: the
   * idempotency key is a hash of the payload, and the same order enqueued
   * twice from two spots on a street must stay one order rather than becoming
   * two. Where somebody was standing is a fact about the act, not part of the
   * record's content.
   */
  location?: ActivityLocation;
};

/**
 * One reading, with everything needed to judge it.
 *
 * Coordinates may be absent — indoors in a concrete godown there is no fix,
 * and a save is never blocked for one — in which case `reason` says why. That
 * is a different fact from no location at all, which is what an omitted field
 * means, and both reach the screens as different sentences.
 */
export type ActivityLocation = {
  lat?: number | null;
  lng?: number | null;
  /** Part of the reading. A 500 m fix is recorded as a 500 m fix. */
  accuracyM?: number | null;
  /** When the FIX was taken, epoch ms by the handset's clock. */
  capturedAt?: number | null;
  /** Its age at the moment of the act. Age is as much part of the reading. */
  ageSeconds?: number | null;
  /** `fresh` — taken for this act. `trail` — one the day's tracking had. */
  source?: "fresh" | "trail" | null;
  /** Only where there are no coordinates. */
  reason?: "denied" | "unavailable" | "off" | null;
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
  /**
   * `{ mediaId, transcript, visitId }` per voice note that has been written
   * out. It is what releases the audio on the handset: the recording is kept
   * until its transcript is confirmed STORED rather than merely uploaded,
   * because it is the only copy of what the customer said.
   */
  transcripts: unknown[];
  /**
   * Today's route and anything planned after it, in the handset's own column
   * names — a pull row IS a local row. Sent on every pass rather than only at
   * sign-in, because a plan made in the office this afternoon has to reach the
   * salesman without him signing out.
   */
  journeyStops: unknown[];
  /**
   * What a customer on a given price tag pays, per can.
   *
   * Replaced WHOLESALE on the handset rather than merged, because a rate that
   * was withdrawn has to disappear and a per-row upsert leaves it behind — an
   * order priced from a rate nobody sells at any more.
   */
  priceList: unknown[];
  /** Live promotions. Eligibility and benefit are data, so no rule ships. */
  schemes: unknown[];
  /** The library — a price sheet, a policy, a customer's own agreement. */
  documents: unknown[];
  /** Training, and which of it is compulsory. */
  courses: unknown[];
  /**
   * What went away, as `{ entity, ids }` per table.
   *
   * The channel that has no other way of existing: a deleted row has no
   * `updated_at` for a delta to notice, so without a tombstone the handset
   * keeps a withdrawn document, a removed stop and a reassigned customer for
   * ever. Reference data only — nothing the salesman authored is deleted by a
   * sync.
   */
  deletions: { entity: string; ids: string[] }[];
  /**
   * The days themselves, and how far each has got in being agreed. A stop only
   * exists once a day is planned, so without this the handset cannot show the
   * days it is being ASKED about — which is most of a month.
   */
  planDays: unknown[];
  /**
   * What leave he has left, per kind.
   *
   * The handset builds its list of leave kinds from these, so sending none
   * meant the only thing it could offer was Loss of pay — somebody with twelve
   * days of casual leave shown no way to ask for any of it.
   */
  leaveBalances: unknown[];
  /**
   * Requests this salesman made and what the office decided about them. The
   * handset has applied this channel since it was written and the server never
   * sent one, so every approval a salesman asked for read Pending for ever —
   * there was nothing to send until the Sales Dashboard existed to decide them.
   */
  approvals: unknown[];
  /**
   * His own month, scored: the six figures, what was asked for each, and the
   * product mix behind the third of them.
   *
   * Sent from the CACHE rather than derived per pull. Deriving it would mean a
   * pass over the whole company's order book on every sync from every handset,
   * several times an hour, to answer a question about one person. The row
   * carries `computedAt` and the screen prints it, so the handset says how old
   * the figure is rather than implying it is live — which is the same rule the
   * credit limit and the outstanding balance already follow.
   */
  performance: unknown[];
};

export type SyncResponse = {
  results: SyncResult[];
  pull: PullDelta;
};
