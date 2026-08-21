import { NextResponse } from "next/server";
import { authenticate, buildPull } from "@/lib/services/mbos-service";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { getConfig } from "@/lib/config/store";
import { SYNC_ENTITY_TYPES, type SyncItem, type SyncResult } from "@/lib/mbos/types";

/* ---------------------------------------------------------------------------
 * One round trip, both directions — PROTOCOL.md §4.
 *
 * A salesman who gets thirty seconds of signal between two shops should spend
 * it on both, not on a push that leaves the book stale. So the push and the
 * pull share a request, and the pull runs AFTER the ingest: what was just
 * accepted has already moved the outstanding figure, and a delta computed
 * before it would hand the handset a number one round trip out of date.
 *
 * The handler parses and shapes. Idempotency, dependency verification,
 * re-validation, numbering, the timeline and the recomputes are all in
 * `lib/actions/mbos.ts`, because none of them are HTTP.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

/** A batch of fifty items with their transactions is not a ten-second job. */
export const maxDuration = 300;

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, code: "validation", error: "The sync request was not readable JSON." },
      { status: 400 },
    );
  }

  /* The token is bound to a handset and the body names one. They have to
   * agree, or a stolen token could file another salesman's device's work. */
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (deviceId && deviceId !== auth.principal.deviceId) {
    return NextResponse.json(
      {
        ok: false,
        code: "device_mismatch",
        error: "This request names a different handset to the one it is signed in as.",
      },
      { status: 403 },
    );
  }

  const config = await getConfig();
  const raw = Array.isArray(body.items) ? body.items : [];
  if (raw.length > config["mbos.sync.maxItemsPerRequest"]) {
    return NextResponse.json(
      {
        ok: false,
        code: "validation",
        error: `That is ${raw.length} items and this endpoint takes ${config["mbos.sync.maxItemsPerRequest"]} at a time. Send them in batches.`,
      },
      { status: 413 },
    );
  }

  const items: SyncItem[] = [];
  /* A malformed item is refused BY ITSELF, never by taking the batch with it.
   *
   * This used to answer 400 for the whole request, which meant one item the
   * server had no handler for — a leave request, for months — stopped every
   * visit, order and payment queued behind it from ever landing, on a handset
   * with nothing on screen saying why. A refusal the client can attribute to
   * one row leaves the rest of the outbox moving, and `rejected` is a state it
   * already knows how to show and retain. */
  const refusals: SyncResult[] = [];
  for (const entry of raw) {
    const item = entry as Partial<SyncItem>;

    /* An item with no queue id cannot be answered at all — the queue id is the
     * client's handle on the attempt, and a result carrying none matches
     * nothing. That one still refuses the request, because the alternative is
     * dropping work silently. */
    if (typeof item?.queueId !== "string") {
      return NextResponse.json(
        {
          ok: false,
          code: "validation",
          error:
            "One of the queue items has no queue id, so there is no way to answer it. Nothing in the batch was written.",
        },
        { status: 400 },
      );
    }

    /* An item with no idempotency key cannot be made safe to retry, and a
     * retry is most requests. It is refused at the door rather than written
     * once and then written again by the next pass. */
    const refuse = (wrong: string) => {
      refusals.push({
        queueId: item.queueId as string,
        status: "rejected",
        code: "validation",
        message: `The office could not file this: ${wrong}. Everything else in this batch was sent.`,
        blocks: [],
      });
    };

    if (typeof item.entityId !== "string") {
      refuse("it names no record");
      continue;
    }
    if (typeof item.idempotencyKey !== "string") {
      refuse("it carries no idempotency key, so it cannot be retried safely");
      continue;
    }
    if (!SYNC_ENTITY_TYPES.includes(item.entityType as never)) {
      refuse(`this MahekOne does not handle "${String(item.entityType)}" records`);
      continue;
    }

    items.push({
      queueId: item.queueId,
      entityType: item.entityType!,
      entityId: item.entityId,
      op: item.op === "update" ? "update" : "create",
      idempotencyKey: item.idempotencyKey,
      clientCreatedAt:
        typeof item.clientCreatedAt === "number" ? item.clientCreatedAt : Date.now(),
      dependsOn: Array.isArray(item.dependsOn)
        ? item.dependsOn.filter((d): d is string => typeof d === "string")
        : [],
      payload:
        item.payload && typeof item.payload === "object"
          ? (item.payload as Record<string, unknown>)
          : {},
      /* A sibling of the payload, never a field inside it — the idempotency
         key is a hash of the payload, and the same order enqueued twice from
         two spots on a street has to stay one order. Shape-checked in the
         action; taken as given here, which is what every other field does. */
      location:
        item.location && typeof item.location === "object"
          ? (item.location as SyncItem["location"])
          : undefined,
    });
  }

  const results = [...refusals, ...(await ingestSyncBatch(auth.principal, items))];
  const pull = await buildPull(
    auth.principal,
    typeof body.cursor === "string" ? body.cursor : null,
  );

  return NextResponse.json({ results, pull });
}
