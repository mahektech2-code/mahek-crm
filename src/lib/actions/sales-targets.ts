"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  notifications,
  salesTargetCategories,
  salesTargetRevisions,
  salesTargets,
  users,
} from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { money } from "@/lib/format";
import { revisionsFor } from "@/lib/services/sales-target-service";
import { err, fieldErr, fromThrown, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Setting somebody's target, publishing it, and changing it afterwards.
 *
 * `target.set` guards all of it. It was MANAGER-ONLY from the day this
 * shipped — a target is what somebody is appraised against, and the module
 * was built on the assumption that whoever runs the team's calling book is
 * who sets it. It is now held by ACCOUNTS as well, because that assumption
 * was not Mahek's own practice: the accounts desk is who actually assigns and
 * manages targets here, the same way `order.approve` and `payment.confirm`
 * already were. See `lib/access-control.ts` for the capability matrix and why
 * it is an addition rather than a move — a manager coaching a shortfall still
 * needs to act on it directly.
 *
 * It is deliberately NOT `customer.reassign` — that moves which accounts feed
 * a target and is accounts' and admin's on its own reasoning, so no one
 * person can both choose the number and choose the book that fills it.
 *
 * A SALESMAN CANNOT REACH ANY OF THIS. Not because the screen does not draw
 * the buttons — a server action is a URL — but because the capability is
 * checked here, in the action, on every one of them.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** `YYYY-MM`. The same key `monthKey()` produces and `sales_targets` stores. */
const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A period is a month, as YYYY-MM.");

/**
 * A target figure: a whole non-negative number, or null for NOT ASKED.
 *
 * Null and zero are different answers and the difference is load-bearing. Null
 * drops the component out of the score and shares its weight among the rest;
 * zero is a target nobody can fail, and dividing by it is what `achievementBp`
 * refuses to do.
 */
const figure = z.number().int().min(0).nullable();

/**
 * A percentage target, in basis points — the same convention the mix bands
 * already use. Collection is measured against what was ALREADY overdue at
 * the start of the month, not a rupee figure typed in: the target is what
 * share of that pre-existing debt should be collected.
 */
const percent = z.number().int().min(0).max(10_000).nullable();

const bandSchema = z
  .object({
    categoryId: z.string().min(1),
    minimumBp: z.number().int().min(0).max(10_000),
    targetBp: z.number().int().min(0).max(10_000),
    stretchBp: z.number().int().min(0).max(10_000),
  })
  .refine((b) => b.minimumBp <= b.targetBp && b.targetBp <= b.stretchBp, {
    message: "A band must not fall as the share rises: minimum ≤ target ≤ stretch.",
  });

const saveSchema = z.object({
  userId: z.string().min(1),
  period: periodSchema,
  revenueTargetPaise: figure,
  volumeTargetMl: figure,
  newCustomerTarget: figure,
  collectionTargetBp: percent,
  activityTarget: figure,
  notes: z.string().max(2000).nullable().optional(),
  bands: z.array(bandSchema).max(20),
  /** Required once the target is published. Ignored on a draft. */
  reason: z.string().max(120).optional(),
  reasonNote: z.string().max(500).optional(),
});

export type SaveTargetInput = z.infer<typeof saveSchema>;

/* ------------------------------------------------------------ the writing */

type Existing = typeof salesTargets.$inferSelect;

/**
 * Create or update one person's target for one month.
 *
 * The whole target in one write — the five figures AND the mix bands. They are
 * one decision ("what is this person's month"), and splitting them into two
 * saves would let a screen publish a revenue target whose mix never landed.
 */
export async function saveSalesTarget(
  input: SaveTargetInput,
): Promise<Result<{ targetId: string }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fieldErr(String(issue.path[0] ?? "form"), issue.message);
  }
  const data = parsed.data;

  try {
    const ctx = await requireCapability("target.set");
    const config = await getConfig();

    // Mix shares are shares of one total. Letting them sum past 100% would
    // make a target nobody can meet look reasonable on the screen that set it.
    const shareTotal = data.bands.reduce((s, b) => s + b.targetBp, 0);
    if (data.bands.length && shareTotal > 10_000) {
      return fieldErr(
        "bands",
        `The mix targets add up to ${(shareTotal / 100).toFixed(1)}%. They are shares of one month's sales and cannot total more than 100%.`,
      );
    }

    const [existing] = await db
      .select()
      .from(salesTargets)
      .where(
        and(eq(salesTargets.userId, data.userId), eq(salesTargets.period, data.period)),
      );

    /*
     * A PUBLISHED target may only be changed with a reason.
     *
     * This is the one rule that separates revising from editing. A draft is
     * somebody working out a number and nobody has been told anything; a
     * published target is a commitment somebody is being measured against, and
     * changing it silently is how a month ends with a figure nobody recognises
     * and no way to find out when it moved.
     */
    if (existing?.status === "published") {
      if (!data.reason) {
        return fieldErr(
          "reason",
          "This target has been published. Changing it needs a reason, which goes on the record beside what changed.",
        );
      }
      const reasons = config["performance.revisionReasons"];
      if (!reasons.includes(data.reason)) {
        return fieldErr("reason", "Pick one of the listed reasons.");
      }
    }

    const targetId = existing?.id ?? id("stg");
    const changes = existing ? diffOf(existing, data) : [];

    await db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(salesTargets)
          .set({
            revenueTargetPaise: data.revenueTargetPaise,
            volumeTargetMl: data.volumeTargetMl,
            newCustomerTarget: data.newCustomerTarget,
            collectionTargetBp: data.collectionTargetBp,
            activityTarget: data.activityTarget,
            notes: data.notes ?? null,
            // A real save is a decision, even one that reproduces last
            // month's figures verbatim — so a target carried forward stops
            // being one the moment a manager has actually looked at it.
            carriedForward: false,
            updatedAt: new Date(),
            updatedById: ctx.user.id,
          })
          .where(eq(salesTargets.id, targetId));
      } else {
        await tx.insert(salesTargets).values({
          id: targetId,
          userId: data.userId,
          period: data.period,
          revenueTargetPaise: data.revenueTargetPaise,
          volumeTargetMl: data.volumeTargetMl,
          newCustomerTarget: data.newCustomerTarget,
          collectionTargetBp: data.collectionTargetBp,
          activityTarget: data.activityTarget,
          notes: data.notes ?? null,
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
      }

      // The bands are replaced wholesale rather than upserted: a category
      // taken off a target has to disappear, and a per-row upsert leaves last
      // month's band behind — a share still being scored that nobody set.
      await tx
        .delete(salesTargetCategories)
        .where(eq(salesTargetCategories.targetId, targetId));
      for (const band of data.bands) {
        await tx.insert(salesTargetCategories).values({
          id: id("stc"),
          targetId,
          categoryId: band.categoryId,
          minimumBp: band.minimumBp,
          targetBp: band.targetBp,
          stretchBp: band.stretchBp,
        });
      }

      // One revision row per figure that moved, not one per save. "The revenue
      // target changed" is the question people ask; "the target was edited" is
      // not an answer to it.
      if (existing?.status === "published" && data.reason) {
        for (const change of changes) {
          await tx.insert(salesTargetRevisions).values({
            id: id("str"),
            targetId,
            field: change.field,
            oldValue: change.from,
            newValue: change.to,
            reason: data.reason,
            reasonNote: data.reasonNote ?? null,
            changedById: ctx.user.id,
            // On the row, so the history stays readable after the person
            // leaves and their account goes.
            changedByName: ctx.user.name,
          });
        }
      }

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        action: existing ? "target.revise" : "target.create",
        entityType: "sales_target",
        entityId: targetId,
        beforeState: (existing ?? null) as never,
        afterState: { ...data, targetId } as never,
      });
    });

    // A published target that MOVED is news the person has to be given. They
    // are being measured against it, and a number that changes without a word
    // is the thing this whole revision trail exists to prevent.
    if (existing?.status === "published" && changes.length) {
      await notify(
        data.userId,
        "Your target for this month has changed",
        `${changes.map((c) => c.label).join(", ")}. Reason: ${data.reason}.`,
      );
    }

    revalidatePath("/sales/targets");
    revalidatePath("/sales/performance");
    return { ok: true, data: { targetId } };
  } catch (e) {
    return fromThrown(e);
  }
}

type Change = { field: string; label: string; from: string; to: string };

/**
 * What moved, in words rather than in paise.
 *
 * "₹13,00,000 → ₹14,50,000" reads back in a year and `130000000` does not,
 * which is the whole reason the revision table stores text.
 */
function diffOf(existing: Existing, next: SaveTargetInput): Change[] {
  const rupees = (v: number | null) => (v === null ? "not set" : money(v));
  const litres = (v: number | null) =>
    v === null ? "not set" : `${Math.round(v / 1000).toLocaleString("en-IN")} L`;
  const count = (v: number | null) => (v === null ? "not set" : String(v));
  const percentOf = (v: number | null) => (v === null ? "not set" : `${(v / 100).toFixed(0)}%`);

  const fields: [string, string, string, string][] = [
    [
      "revenue",
      "Revenue",
      rupees(existing.revenueTargetPaise),
      rupees(next.revenueTargetPaise),
    ],
    ["volume", "Volume", litres(existing.volumeTargetMl), litres(next.volumeTargetMl)],
    [
      "newCustomers",
      "New customers",
      count(existing.newCustomerTarget),
      count(next.newCustomerTarget),
    ],
    [
      "collection",
      "Collection",
      percentOf(existing.collectionTargetBp),
      percentOf(next.collectionTargetBp),
    ],
    ["activity", "Activity", count(existing.activityTarget), count(next.activityTarget)],
  ];

  return fields
    .filter(([, , from, to]) => from !== to)
    .map(([field, label, from, to]) => ({
      field,
      label: `${label} ${from} → ${to}`,
      from,
      to,
    }));
}

/* --------------------------------------------------------------- publish */

/**
 * Show it to the person it belongs to.
 *
 * Publishing is its own act rather than a checkbox on the save, because it is
 * the moment a number stops being a manager's working-out and becomes
 * something somebody is measured against. Everything downstream keys on it —
 * the handset, the CRM screen and `readingsForPeriod` all read published
 * targets only.
 */
export async function publishSalesTarget(
  targetId: string,
): Promise<Result<undefined>> {
  try {
    const ctx = await requireCapability("target.set");

    const [target] = await db
      .select()
      .from(salesTargets)
      .where(eq(salesTargets.id, targetId));
    if (!target) return err("That target no longer exists.", "not_found");
    if (target.status === "published") {
      // Not an error: two clicks on a slow connection is the ordinary way this
      // happens, and refusing the second would look like the first had failed.
      return okVoid("Already published.");
    }

    /*
     * A target with nothing in it is not a target.
     *
     * Publishing one would put a score of nothing out of nothing on somebody's
     * handset, under a heading saying what they are measured on. Refused here
     * rather than drawn and ignored.
     */
    const asked = [
      target.revenueTargetPaise,
      target.volumeTargetMl,
      target.newCustomerTarget,
      target.collectionTargetBp,
      target.activityTarget,
    ].filter((v) => v !== null);
    if (!asked.length) {
      return err(
        "Nothing has been asked for on this target. Set at least one of the five figures before publishing it.",
        "rule_violation",
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .update(salesTargets)
        .set({
          status: "published",
          publishedAt: new Date(),
          publishedById: ctx.user.id,
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(salesTargets.id, targetId));

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        action: "target.publish",
        entityType: "sales_target",
        entityId: targetId,
        afterState: { period: target.period, userId: target.userId } as never,
      });
    });

    await notify(
      target.userId,
      `Your target for ${target.period} is set`,
      "Open Performance to see what you are working towards this month.",
    );

    revalidatePath("/sales/targets");
    revalidatePath("/sales/performance");
    revalidatePath("/crm/performance");
    return okVoid("Published. They can see it now.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- revisions */

export type TargetRevisionEntry = {
  field: string;
  from: string | null;
  to: string | null;
  reason: string;
  reasonNote: string | null;
  changedByName: string | null;
  changedAt: Date;
};

/**
 * What changed on a published target, newest first.
 *
 * `revisionsFor` has held this since the module shipped and nothing ever read
 * it back — the count of changes was shown, never the changes themselves. A
 * count says a target moved four times; it does not say whether that was a
 * price revision applied evenly across the team or one person quietly asked
 * for more every month, and that is exactly the question somebody deciding
 * whether to revise it again is asking.
 */
export async function targetRevisionHistory(
  targetId: string,
): Promise<Result<TargetRevisionEntry[]>> {
  try {
    await requireCapability("target.set");
    const rows = await revisionsFor(targetId);
    return ok(
      rows.map((r) => ({
        field: r.field,
        from: r.old_value,
        to: r.new_value,
        reason: r.reason,
        reasonNote: r.reason_note,
        changedByName: r.changed_by_name,
        changedAt: r.changed_at,
      })),
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ----------------------------------------------------------------- notify */

async function notify(userId: string, title: string, body: string) {
  const [person] = await db.select().from(users).where(eq(users.id, userId));
  if (!person) return;
  await db.insert(notifications).values({
    id: id("ntf"),
    userId,
    title,
    body,
    kind: "info",
    // Somewhere to go and read it. A bell saying a number changed with nothing
    // behind it is worse than no bell.
    href: "/crm/performance",
  });
}
