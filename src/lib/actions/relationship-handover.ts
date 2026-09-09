"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers, users } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { customerFilterClause } from "@/lib/queries";
import { err, okVoid, fromThrown, type Result } from "@/lib/result";
import {
  HANDOVER_REFUSALS,
  handOverRelationship,
  handoverRefusal,
} from "@/lib/services/handover-service";
import { notifyUsers } from "../notify";

/* ---------------------------------------------------------------------------
 * §Q — handing the relationship over.
 *
 * Its own action rather than a fourth branch of `updateAccountManagers`, for
 * the reason the sales manager seat is its own: those two write
 * `customer.reassign`, the narrowest capability in the app, because they move
 * who is CREDITED for an account. This moves nobody's numbers, so it is a
 * manager's — and one function behind one capability doing two jobs with two
 * answers about who may do them ends with the generous answer winning.
 *
 * See `services/handover-service.ts` for what a handover IS. This file is only
 * the door: who may open it, what they must say, and who gets told afterwards.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const schema = z.object({
  /*
   * A LIST, because of where the work arrives from. The entry point is the
   * pending list — converted accounts with nobody running them — and a manager
   * clearing it hands eight accounts to one person in one decision. One
   * dialog per account would make the honest thing the slow thing.
   */
  customerIds: z.array(z.string().min(1)).min(1).max(500),
  toUserId: z.string().min(1),
  reasonCode: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

export type HandOverInput = z.input<typeof schema>;

export async function handOverRelationships(raw: HandOverInput): Promise<Result> {
  try {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [
        { field: issue.path.join("."), message: issue.message },
      ]);
    }
    const input = parsed.data;

    const ctx = await requireCapability("customer.handOver");
    const config = await getConfig();

    /* The reason list is a manager's to edit, so it is checked against the
       stored list rather than an enum — an unknown code is refused instead of
       stored, or the history grows values nothing can label. */
    const reasons = config["people.amChangeReasons"] as string[];
    if (!reasons.includes(input.reasonCode)) {
      return err("That is not a reason we record for a handover.", "validation", [
        { field: "reasonCode", message: "Pick a reason from the list." },
      ]);
    }
    if (/^other$/i.test(input.reasonCode) && !input.note?.trim()) {
      return err("A note is required when the reason is Other.", "validation", [
        { field: "note", message: "Say what happened." },
      ]);
    }

    /* --- who it goes to -------------------------------------------------- */

    /*
     * An ACTIVE account, checked here and not only in the picker. A picker is
     * not a permission, and handing an account to somebody who has left is a
     * relationship with nobody behind it — which is the state this whole
     * marker exists to make visible.
     */
    const [to] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, input.toUserId), eq(users.active, true)))
      .limit(1);
    if (!to) {
      return err("That person no longer has an active MahekOne account.", "validation", [
        { field: "toUserId", message: "Pick somebody else." },
      ]);
    }

    /* --- which accounts -------------------------------------------------- */

    /*
     * Scoped as well as named. The ids come from a page the reader was shown,
     * so this changes nothing in practice — and it means a hand-built request
     * cannot reach past what its author can see.
     */
    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        relationshipOwnerId: customers.relationshipOwnerId,
        handedOverAt: customers.handedOverAt,
      })
      .from(customers)
      .where(
        and(
          await customerFilterClause({}),
          inArray(customers.id, input.customerIds),
        ),
      );

    if (!rows.length) return err("Those customers no longer exist.", "not_found");

    /*
     * REFUSED ONES ARE NAMED, never silently dropped.
     *
     * A lead among the selection is the ordinary case — somebody ticks a row
     * from a mixed list — and the difference between "8 handed over" and "8
     * handed over, 2 were leads" is the difference between a manager who knows
     * where those two went and one who finds out in March.
     */
    const refused: string[] = [];
    const moving = rows.filter((r) => {
      const why = handoverRefusal(r, to.id);
      if (why) {
        refused.push(`${r.name} — ${HANDOVER_REFUSALS[why]}`);
        return false;
      }
      return true;
    });

    if (!moving.length) {
      return err(
        refused.length === 1
          ? refused[0]
          : `Nothing to hand over. ${refused.join(" · ")}`,
        "validation",
      );
    }

    /* --- the previous holders, by name, before anything moves ------------ */

    const priorIds = [
      ...new Set(moving.map((r) => r.relationshipOwnerId).filter((v): v is string => !!v)),
    ];
    const priorNames = new Map<string, string>();
    if (priorIds.length) {
      for (const u of await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, priorIds))) {
        priorNames.set(u.id, u.name);
      }
    }

    const now = new Date();
    const lost = new Map<string, number>();

    await db.transaction(async (tx) => {
      for (const r of moving) {
        await handOverRelationship(tx, {
          target: r,
          toUserId: to.id,
          toName: to.name,
          fromName: r.relationshipOwnerId
            ? (priorNames.get(r.relationshipOwnerId) ?? null)
            : null,
          reasonCode: input.reasonCode,
          note: input.note?.trim() || null,
          actorId: ctx.user.id,
          at: now,
        });
        if (r.relationshipOwnerId) {
          lost.set(r.relationshipOwnerId, (lost.get(r.relationshipOwnerId) ?? 0) + 1);
        }
      }

      /*
       * ONE audit row for the act, not one per account — `customer_am_changes`
       * already holds the per-account record and holds it better. What the
       * audit is for here is that somebody did this, as this hat, this many
       * accounts wide.
       */
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.role ?? null,
        action: "customer.handOver",
        entityType: "customer",
        entityId: moving.length === 1 ? moving[0].id : null,
        afterState: {
          count: moving.length,
          toUserId: to.id,
          reasonCode: input.reasonCode,
        } as never,
      });
    });

    /* --- both sides are told --------------------------------------------- */

    const plural = (n: number) => `${n} account${n === 1 ? "" : "s"}`;
    const why = `${input.reasonCode}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`;

    await notifyUsers([
      {
        userId: to.id,
        title: `You now run ${plural(moving.length)}`,
        body:
          moving.length === 1
            ? `${ctx.user.name} handed you ${moving[0].name} — ${why}`
            : `${ctx.user.name} handed you ${plural(moving.length)} — ${why}`,
        href: "/crm/customers",
      },
      /*
       * And whoever held it before. A book that shrinks silently reads as a
       * bug in the queue — the same reasoning as the reassignment
       * notifications, one seat along. Nobody is told about an account that
       * had no previous holder, because there is no loss to report.
       */
      ...[...lost.entries()].map(([userId, count]) => ({
        userId,
        title: `${plural(count)} moved to somebody else`,
        body: `${ctx.user.name} handed ${plural(count)} you were running to ${to.name} — ${why}`,
        href: "/crm/customers",
      })),
    ]);

    /*
     * Wrapped, like every other action here. Without it a throw lands in the
     * outer catch and the caller is told the handover FAILED — after it has
     * committed, been notified and written its history. The cache is the last
     * thing that matters at this point and the only one that can be missing.
     */
    try {
      revalidatePath("/crm/customers");
      revalidatePath("/accounts/customers");
      revalidatePath("/crm/customers/[id]", "page");
    } catch {
      /* no request context — nothing cached, nothing to invalidate */
    }

    const done = `${plural(moving.length)} handed to ${to.name}.`;
    return okVoid(
      refused.length ? `${done} Not moved: ${refused.join(" · ")}` : done,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
