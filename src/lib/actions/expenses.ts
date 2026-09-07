"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, mbosApprovals, mbosExpenseExceptions } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { can, requireCapability } from "@/lib/access-control";
import { reopenDay, submitDay } from "@/lib/services/expense-submit-service";
import { today } from "@/lib/recompute";
import { err as fail, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Deciding what the field spent.
 *
 * The rules that decide the AMOUNTS live in the policy and the engine; nothing
 * in this file works out a rupee. What it does is record decisions — somebody
 * answering an exception, somebody approving a day, somebody reopening one —
 * and every one of them is capability-checked here rather than by hiding a
 * button, because a server action is a URL.
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
 * `submitDay` replaces only the UNRESOLVED ones, so an answer given survives
 * the day being priced again.
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

/* --------------------------------------------------------- deciding a day */

const decideSchema = z.object({
  dayId: z.string(),
  decision: z.enum(["approved", "partially_approved", "rejected"]),
  approvedAmountPaise: z.number().int().min(0).nullish(),
  note: z.string().trim().max(2000).nullish(),
});

/**
 * Approve, part-approve or refuse a submitted day.
 *
 * `mbos_approvals` is the one approval table in MBOS and this writes into it
 * unchanged — the day's state is DERIVED from the highest step, never written
 * onto the day beside it. Two copies of one decision is how a screen ends up
 * showing a refusal beside a payment.
 *
 * A refusal takes a reason and a part-approval takes a figure, both refused
 * here rather than merely required by the form. `partially_approved` without a
 * number is a shrug wearing a status.
 */
export async function decideExpenseDay(input: unknown): Promise<Result> {
  /* The hat that allowed it, not the person's widest one. `audit_log.actor_role`
     exists to tell the accounts clerk doing their job from an administrator
     reaching past a rule, and it can only do that if the NARROWEST granting
     role is what gets written. */
  const granting = await requireCapability("order.approve");
  const user = await requireUser();

  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return fail("That decision cannot be saved.", "validation");
  const p = parsed.data;

  if (p.decision === "rejected" && !p.note?.trim()) {
    return fail("A refusal has to say why — the salesman has to be told something.", "validation", [
      { field: "note", message: "Say why." },
    ]);
  }
  if (p.decision === "partially_approved" && (p.approvedAmountPaise ?? null) === null) {
    return fail(
      "Allowing part of a claim needs the figure allowed. Without it the decision is a shrug wearing a status.",
      "validation",
      [{ field: "approvedAmountPaise", message: "How much is allowed?" }],
    );
  }

  const steps = await db
    .select()
    .from(mbosApprovals)
    .where(
      and(
        eq(mbosApprovals.subjectType, "mbos_expense_days"),
        eq(mbosApprovals.subjectId, p.dayId),
      ),
    )
    .orderBy(sql`${mbosApprovals.stepIndex} asc`);

  const pending = steps.find((s) => s.state === "pending");
  if (!pending) {
    return fail("There is nothing waiting on this day.", "not_found");
  }

  await db
    .update(mbosApprovals)
    .set({
      state: p.decision,
      decidedAt: new Date(),
      approverUserId: user.id,
      decisionNote: p.note ?? null,
      approvedAmountPaise: p.approvedAmountPaise ?? null,
    })
    .where(eq(mbosApprovals.id, pending.id));

  await audit(user.id, `expense.day_${p.decision}`, p.dayId, pending, p, granting.authorisedBy);
  refresh();

  const remaining = steps.filter((s) => s.id !== pending.id && s.state === "pending").length;
  return okVoid(
    remaining
      ? `Saved. This day still needs ${remaining} more decision — it was escalated as well as sent to you.`
      : p.decision === "rejected"
        ? "Refused. The salesman is told, with your reason."
        : "Saved.",
  );
}

/* ---------------------------------------------------- submitting, reopening */

const submitSchema = z.object({
  userId: z.string(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(2000).nullish(),
});

/**
 * Submit a day from the office.
 *
 * Ordinarily the salesman does this on the handset. This exists for the day he
 * cannot — a broken phone, a resignation mid-month — and it is deliberately
 * NOT open to everybody: submitting prices a day and can auto-approve it, so
 * somebody submitting their own would be approving their own.
 */
export async function submitExpenseDay(input: unknown): Promise<Result<{ dayId: string }>> {
  await requireCapability("order.approve");
  const user = await requireUser();

  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) return fail("That day cannot be submitted.", "validation");
  const p = parsed.data;

  if (p.userId === user.id) {
    return fail(
      "You cannot submit your own day from here — a submission can approve itself, and that would be approving your own claim.",
      "not_permitted",
    );
  }

  const outcome = await submitDay(p.userId, p.day, { note: p.note ?? null });
  if (!outcome.ok) return fail(outcome.reason, "conflict");

  await audit(user.id, "expense.day_submitted_by_office", outcome.dayId, null, outcome);
  refresh();
  return ok({ dayId: outcome.dayId }, outcome.routeReason);
}

const reopenSchema = z.object({
  dayId: z.string(),
  reason: z.string().trim().min(3).max(2000),
});

/**
 * Requirement 50 — reopen a submitted day.
 *
 * Takes a reason, always. What was submitted is not erased: a correction
 * supersedes a line rather than editing one, so the original claim stays
 * readable beside what replaced it. Erasing it would destroy the only record
 * of what was originally asked for, which is the thing an audit is FOR.
 */
export async function reopenExpenseDay(input: unknown): Promise<Result> {
  await requireCapability("order.approve");
  const user = await requireUser();

  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) {
    return fail("A reopening has to say why.", "validation", [
      { field: "reason", message: "Say why this day is being reopened." },
    ]);
  }

  const outcome = await reopenDay(parsed.data.dayId, user.id, parsed.data.reason, await today());
  if (!outcome.ok) return fail(outcome.reason, "rule_violation");

  await audit(user.id, "expense.day_reopened", parsed.data.dayId, null, parsed.data);
  refresh();
  return okVoid(outcome.reason);
}

/** Whether this viewer may decide claims. Read by the screens to draw controls. */
export async function canDecideExpenses(): Promise<boolean> {
  const user = await requireUser();
  return can(user.role, "order.approve");
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
