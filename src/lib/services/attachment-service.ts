import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  complaints,
  calls,
  customers,
  followUpAttempts,
  paymentReceipts,
} from "@/db/schema";
import { resolveScope, assertCustomerInScope } from "../access-control";
import { canSeeFeedback, feedbackBehindMessage } from "./feedback-access";
import { getConfig } from "../config/store";
import { fileStorage } from "../storage";
import { sniffContentType } from "../file-types";
import { err, ok, okVoid, type Result } from "../result";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * §4 — the attachment subsystem.
 *
 * Three features attach files and all three come through here, because the
 * rules are the same wherever a file lands: what it may be, how big, how many,
 * who may see it, and what "delete" means. Three implementations would be
 * three places for those to drift.
 *
 * Two rules shape the whole design:
 *
 *  - The upload starts when the file is CHOSEN, not when the form saves, so
 *    the parent record usually does not exist yet. An attachment is created
 *    unparented and bound later. That is what makes orphans possible, and why
 *    a scheduled sweep is part of the subsystem rather than an afterthought.
 *
 *  - A save is NEVER blocked by an attachment. Attachments are optional
 *    everywhere in this request; a failed upload leaves the record intact and
 *    says so, rather than losing the call the telecaller just logged.
 * ------------------------------------------------------------------------- */

export type ParentType =
  | "interaction"
  | "complaint"
  | "follow_up_attempt"
  | "payment_receipt"
  | "feedback"
  | "feedback_message";

export type AttachmentView = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByName: string | null;
  isImage: boolean;
};

/** How many each context allows, from configuration rather than a constant. */
export async function limitFor(parentType: ParentType): Promise<number> {
  const config = await getConfig();
  switch (parentType) {
    case "complaint":
      return config["attachments.maxPerComplaint"];
    case "follow_up_attempt":
    case "payment_receipt":
      // Proof of one payment is the same handful of images as proof of one
      // collections call, and for the same reason: it is photographed, not
      // filed.
      return config["attachments.maxPerFollowUp"];
    case "feedback":
    case "feedback_message":
      return config["attachments.maxPerFeedback"];
    default:
      // An interaction carries whatever the complaint it produced carries.
      return config["attachments.maxPerComplaint"];
  }
}

/**
 * Stores one file and returns its identifier, unparented. Validation happens
 * against the bytes: the declared type and the extension both come from the
 * browser and neither is evidence of anything.
 */
export async function createAttachment(input: {
  filename: string;
  bytes: Uint8Array;
  /** What the browser claimed. Recorded nowhere; used only to explain a refusal. */
  declaredType?: string;
}): Promise<Result<{ id: string }>> {
  const ctx = await resolveScope();
  const config = await getConfig();

  const maxBytes = config["attachments.maxSizeMb"] * 1024 * 1024;
  if (input.bytes.byteLength > maxBytes) {
    const mb = (input.bytes.byteLength / (1024 * 1024)).toFixed(1);
    return err(
      `${input.filename} is ${mb} MB. The limit is ${config["attachments.maxSizeMb"]} MB.`,
      "validation",
      [{ field: "file", message: "Too large." }],
    );
  }

  const actual = sniffContentType(input.bytes);
  const accepted = config["attachments.acceptedTypes"];
  if (!actual || !accepted.includes(actual)) {
    // Named precisely, because "invalid file" tells somebody nothing about
    // what to do next — and a renamed file is the interesting case.
    return err(
      actual
        ? `${input.filename} is a ${actual} file, which is not accepted here.`
        : `${input.filename} is not a JPG, PNG or PDF, whatever it is named.`,
      "validation",
      [{ field: "file", message: "Type not accepted." }],
    );
  }

  const attachmentId = id("att");
  try {
    const stored = await fileStorage.upload({
      key: `attachments/${attachmentId}`,
      body: input.bytes,
      contentType: actual,
    });

    await db.insert(attachments).values({
      id: attachmentId,
      filename: input.filename,
      storedRef: stored.ref,
      contentType: actual,
      sizeBytes: stored.sizeBytes,
      // Images are their own thumbnail: these are phone photographs under a
      // few megabytes, and a resize pipeline for that is machinery earning
      // nothing. PDFs show a file icon, per §4.2.
      thumbnailRef: actual.startsWith("image/") ? stored.ref : null,
      status: "available",
      uploadedById: ctx.user.id,
    });

    return ok({ id: attachmentId }, `${input.filename} attached`);
  } catch (e) {
    // The row records the failure so the screen can say which file did not
    // make it, rather than the file simply not appearing.
    await db
      .insert(attachments)
      .values({
        id: attachmentId,
        filename: input.filename,
        storedRef: "",
        contentType: actual,
        sizeBytes: input.bytes.byteLength,
        status: "failed",
        uploadedById: ctx.user.id,
      })
      .catch(() => {});
    return err(
      `${input.filename} could not be stored. ${e instanceof Error ? e.message : ""}`.trim(),
      "conflict",
    );
  }
}

/**
 * Binds uploaded files to the record the form just wrote. Over the limit, the
 * extras are left unparented for the sweep rather than rejected — the parent
 * is already saved, and failing here would mean reporting an error about a
 * thing that succeeded.
 */
export async function bindAttachments(
  attachmentIds: string[],
  parentType: ParentType,
  parentId: string,
): Promise<Result<{ bound: number; skipped: number }>> {
  if (!attachmentIds.length) return ok({ bound: 0, skipped: 0 });

  const limit = await limitFor(parentType);
  const existing = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(
      and(
        eq(attachments.parentType, parentType),
        eq(attachments.parentId, parentId),
        eq(attachments.status, "available"),
      ),
    );

  const room = Math.max(0, limit - Number(existing[0]?.n ?? 0));
  const toBind = attachmentIds.slice(0, room);
  const skipped = attachmentIds.length - toBind.length;

  if (toBind.length) {
    await db
      .update(attachments)
      .set({ parentType, parentId, updatedAt: new Date() })
      .where(
        and(inArray(attachments.id, toBind), isNull(attachments.parentId)),
      );
  }

  return ok({ bound: toBind.length, skipped });
}

/** Everything visible on one record, newest last so it reads as a sequence. */
export async function listAttachments(
  parentType: ParentType,
  parentId: string,
): Promise<AttachmentView[]> {
  const rows = await db.execute<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    uploaded_at: Date;
    uploaded_by: string | null;
  }>(sql`
    select a.id, a.filename, a.content_type, a.size_bytes, a.uploaded_at,
           u.name as uploaded_by
      from attachments a
      left join users u on u.id = a.uploaded_by_id
     where a.parent_type = ${parentType}
       and a.parent_id = ${parentId}
       and a.status = 'available'
     order by a.uploaded_at asc
  `);

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    uploadedAt: new Date(r.uploaded_at).toISOString(),
    uploadedByName: r.uploaded_by,
    isImage: r.content_type.startsWith("image/"),
  }));
}

/**
 * Detaches and marks removed. NEVER hard-deletes: §3.1 rule 2 says nothing
 * representing a customer interaction is destroyed, and a payment proof
 * outlives whoever tidied it off a screen. The bytes go only when the
 * retention policy says so.
 */
export async function removeAttachment(attachmentId: string): Promise<Result> {
  const ctx = await resolveScope();
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  if (!row) return err("That attachment no longer exists.", "not_found");

  await db
    .update(attachments)
    .set({
      status: "removed",
      parentType: null,
      parentId: null,
      removedAt: new Date(),
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    } as never)
    .where(eq(attachments.id, attachmentId));

  return okVoid(`${row.filename} removed`);
}

/**
 * Whether this user may read this attachment's bytes. Anyone who can see the
 * parent record can see what is attached to it, so the question is answered by
 * the parent's own scope rather than by a rule of its own.
 */
export async function canRead(attachmentId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  if (!row || row.status !== "available") return false;

  // Unbound and still the uploader's own: their form has not saved yet.
  if (!row.parentType || !row.parentId) {
    const ctx = await resolveScope();
    return row.uploadedById === ctx.user.id;
  }

  // Feedback is the one parent with no customer behind it, so it cannot be
  // answered by a customer's scope. The two sides of the thread may see the
  // screenshot and nobody else — the same rule that decides who may read the
  // words it was attached to, asked in one place.
  if (row.parentType === "feedback" || row.parentType === "feedback_message") {
    const ctx = await resolveScope();
    const feedbackId =
      row.parentType === "feedback"
        ? row.parentId
        : await feedbackBehindMessage(row.parentId);
    if (!feedbackId) return false;
    return canSeeFeedback(ctx.user, feedbackId);
  }

  const customerId = await customerBehind(row.parentType, row.parentId);
  if (!customerId) return false;

  // Drizzle, not raw SQL, and no cast. This was a hand-written query handing
  // snake_case columns to a function that reads camelCase ones, with `as never`
  // silencing the compiler: `kind` was absent and `ownerId` was undefined, so
  // assignedUserId() answered null and EVERY read was refused. It failed shut,
  // which is the safe direction and the reason nobody noticed — no screen had
  // ever displayed an attachment to notice with.
  const [customer] = await db
    .select({
      kind: customers.kind,
      ownerId: customers.ownerId,
      salesAmId: customers.salesAmId,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return false;

  try {
    await assertCustomerInScope(customer);
    return true;
  } catch {
    return false;
  }
}

async function customerBehind(
  parentType: string,
  parentId: string,
): Promise<string | null> {
  const table =
    parentType === "complaint"
      ? complaints
      : parentType === "follow_up_attempt"
        ? followUpAttempts
        : parentType === "payment_receipt"
          ? paymentReceipts
          : calls;
  const [row] = await db
    .select({ customerId: table.customerId })
    .from(table)
    .where(eq(table.id, parentId));
  return row?.customerId ?? null;
}

/**
 * An abandoned form leaves files belonging to nothing. Swept after the
 * configured window — long enough that a telecaller interrupted mid-call still
 * finds their file when they come back to it.
 */
export async function sweepOrphans(): Promise<{ swept: number }> {
  const config = await getConfig();
  const cutoff = new Date(
    Date.now() - config["attachments.orphanCleanupHours"] * 60 * 60 * 1000,
  );

  const orphans = await db
    .select()
    .from(attachments)
    .where(and(isNull(attachments.parentId), lt(attachments.uploadedAt, cutoff)));

  for (const row of orphans) {
    // The bytes go here: nothing ever pointed at them, so there is no
    // interaction record being destroyed.
    if (row.storedRef) await fileStorage.remove(row.storedRef).catch(() => {});
    await db
      .update(attachments)
      .set({ status: "removed", removedAt: new Date(), updatedAt: new Date() })
      .where(eq(attachments.id, row.id));
  }

  return { swept: orphans.length };
}
