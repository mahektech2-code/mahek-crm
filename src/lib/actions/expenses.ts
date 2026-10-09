"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, mbosExpenseExceptions } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCapability } from "@/lib/access-control";
import { err as fail, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Deciding what the field spent.
 *
 * The rules that decide the AMOUNTS live in the policy and the engine; nothing
 * in this file works out a rupee. What it records here is somebody answering a
 * flag on a day, capability-checked rather than hidden behind a button, because
 * a server action is a URL. Each expense is approved on its own, through
 * `decideExpense` in `lib/actions/sales.ts`.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function audit(
  userId: string,
  action: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  actorRole?: string | null,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: userId,
    actorRole: (actorRole ?? null) as never,
    action,
    entityType: "mbos_expense",
    entityId,
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

function refresh() {
  try {
    revalidatePath("/sales/exceptions");
    revalidatePath("/sales/expenses");
    revalidatePath("/sales/travel");
  } catch {
    /* No request scope — nothing cached to drop. */
  }
}

/* ------------------------------------------------------------- exceptions */

const resolveSchema = z.object({
  exceptionId: z.string(),
  resolution: z.enum(["accepted", "rejected", "corrected"]),
  note: z.string().trim().min(3).max(2000),
});

/**
 * Answer one exception.
 *
 * **A reason is required on every answer, not only on a refusal.** The
 * question this record exists to answer is asked months later — "why was that
 * 240 km day allowed" — and "somebody clicked allow" is not an answer. It is
 * checked here as well as in the dialog, because the dialog is not a check.
 *
 * A resolved exception is never deleted and never re-raised by a recompute:
 * `refreshDayMoney` replaces only the UNRESOLVED ones, so an answer given
 * survives the day being priced again.
 */
export async function resolveException(input: unknown): Promise<Result> {
  await requireCapability("order.approve");
  const user = await requireUser();

  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) {
    return fail("That cannot be saved.", "validation", [
      { field: "note", message: "Say why in a sentence — this is what somebody reads later." },
    ]);
  }
  const p = parsed.data;

  const [before] = await db
    .select()
    .from(mbosExpenseExceptions)
    .where(eq(mbosExpenseExceptions.id, p.exceptionId))
    .limit(1);
  if (!before) return fail("There is no such exception.", "not_found");
  if (before.resolvedAt) {
    return fail(
      "Somebody has already answered this one. Reload the list to see what they said.",
      "conflict",
    );
  }

  await db
    .update(mbosExpenseExceptions)
    .set({
      resolvedAt: new Date(),
      resolvedById: user.id,
      resolution: p.resolution,
      resolutionNote: p.note,
    })
    .where(eq(mbosExpenseExceptions.id, p.exceptionId));

  await audit(user.id, `expense.exception_${p.resolution}`, p.exceptionId, before, p);
  refresh();
  return okVoid(
    p.resolution === "accepted"
      ? "Allowed, with your reason against it."
      : p.resolution === "rejected"
        ? "Refused. The salesman is told."
        : "Marked corrected.",
  );
}

/* ------------------------------------------------- the attachment store */

export type StorageCheck = {
  backend: "postgres" | "s3";
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  advice: string | null;
};

/**
 * Prove the attachment store works, from the console.
 *
 * **Because a terminal is not a fallback.** This deployment has no shell for
 * the people who run it, which is the same reasoning that put the sheet import
 * and the dictation keys on a screen: a check that can only be run over SSH is
 * a check that never gets run, and the failure it would have caught is silent
 * for days — uploads throw inside a request nobody is watching, the salesman
 * sees "could not be stored", and the cause is a region string.
 *
 * It writes a ten-byte object, reads it back, compares the bytes and deletes
 * it. That is the whole round trip an attachment makes. Every step reports on
 * its own, because "it failed" and "it wrote but could not read back" want
 * completely different things done about them.
 *
 * Admin only: it names the backend and, on a failure, the provider's own error.
 */
export async function checkAttachmentStorage(): Promise<Result<StorageCheck>> {
  await requireCapability("expense.policy.publish");

  const { fileStorage } = await import("@/lib/storage");
  const backend = fileStorage.kind;
  const steps: StorageCheck["steps"] = [];
  const key = `attachments/_console-check-${randomUUID().slice(0, 8)}`;
  /* A real JPEG header, so a store that sniffs types is exercised the way a
     bill photograph exercises it. */
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  let ref: string | null = null;
  const fail_ = (step: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    steps.push({ step, ok: false, detail: message });
    return message;
  };

  try {
    const stored = await fileStorage.upload({ key, body: bytes, contentType: "image/jpeg" });
    ref = stored.ref;
    steps.push({ step: "Write a file", ok: true, detail: `${stored.sizeBytes} bytes stored` });
  } catch (e) {
    const message = fail_("Write a file", e);
    return ok({ backend, ok: false, steps, advice: adviseOn(message) });
  }

  try {
    const back = Buffer.from(await fileStorage.read(ref));
    if (!back.equals(bytes)) {
      steps.push({
        step: "Read it back",
        ok: false,
        detail: `Sent ${bytes.length} bytes and got ${back.length} back. A store that returns something other than what it was given is worse than one that refuses — do not put photographs in it.`,
      });
      return ok({ backend, ok: false, steps, advice: null });
    }
    steps.push({ step: "Read it back", ok: true, detail: "Byte for byte, unchanged" });
  } catch (e) {
    const message = fail_("Read it back", e);
    return ok({ backend, ok: false, steps, advice: adviseOn(message) });
  }

  try {
    await fileStorage.remove(ref);
    steps.push({ step: "Delete it", ok: true, detail: "Removed" });
  } catch (e) {
    const message = fail_("Delete it", e);
    return ok({
      backend,
      ok: false,
      steps,
      advice: `Files can be written and read but not removed, so nothing is broken for a salesman today — the retention sweep is what will stop working. ${adviseOn(message) ?? ""}`.trim(),
    });
  }

  return ok({ backend, ok: true, steps, advice: null });
}

/**
 * What a store's refusal usually means.
 *
 * A 403 says nothing about which of three things is wrong, and somebody
 * reading it in a console has no way to find out — so the three are named.
 */
function adviseOn(message: string): string | null {
  if (/403|SignatureDoesNotMatch|Forbidden|InvalidAccessKeyId/i.test(message)) {
    return [
      "A refusal here is almost always one of three things, and the store does not say which:",
      "• The token. If it was made for the backups bucket it cannot reach this one — it needs Object Read & Write on the attachments bucket specifically.",
      "• The region. R2 signs with the literal word “auto” and nothing else.",
      "• The endpoint. It carries the account id; the bucket is named separately.",
    ].join("\n");
  }
  if (/404|NoSuchBucket|not found/i.test(message)) {
    return "The bucket was not found. Usually its name is in the endpoint as well as in the bucket setting — it belongs in one of them only.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)) {
    return "The endpoint could not be reached at all. Check the address, and that the droplet has outbound network access.";
  }
  return null;
}
