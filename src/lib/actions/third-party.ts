"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customerDistributors, customers } from "@/db/schema";
import {
  requireCapability,
  scopedToUsers,
  scopedUserIds,
} from "@/lib/access-control";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Converting a lead into a third-party customer, and keeping the arrangement.
 *
 * A THIRD-PARTY CUSTOMER is a shop we deliver to and do not bill. Somebody
 * else — a distributor, who IS an account we bill — buys the goods and sells
 * them on. The shop is real, its address is where the drums go, and it is
 * nobody's prospect: ringing it for a first order asks for something it is in
 * no position to give.
 *
 * THREE RULES, AND THEY ARE WHY THIS FILE EXISTS RATHER THAN A BOOLEAN.
 *
 * 1. Only a LEAD is converted. A direct customer is an account we invoice, and
 *    saying it does not bill with us is a contradiction — the option is not
 *    offered on one and this action refuses it, because a menu is not a rule.
 *    Lifting the mark stays available from either direction, since a shop that
 *    starts buying from us directly is an ordinary and welcome thing.
 *
 * 2. A conversion NAMES AT LEAST ONE DISTRIBUTOR. The mark without one is an
 *    assertion with nothing behind it: it takes a shop off the calling list
 *    and leaves nobody to ask about it. Written in the same transaction as the
 *    mark, so a half-converted account is not a state that exists.
 *
 * 3. A distributor is an UNMARKED DIRECT CUSTOMER. Somebody has to be holding
 *    the invoice at the end of the chain, and a shop we deliver to is not
 *    holding one. Checked here as well as filtered in the picker.
 *
 * `customer.classify` throughout — a manager's, because it changes who their
 * team rings tomorrow. Not accounts': no money moves, no book changes hands.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function refresh() {
  try {
    for (const path of ["/crm/customers", "/accounts/customers"]) {
      revalidatePath(path);
    }
    revalidatePath("/crm/customers/[id]", "page");
    revalidatePath("/accounts/record/[id]", "page");
    revalidatePath("/crm/call-log");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

const distributorInput = z.object({
  distributorId: z.string().min(1),
  /** Who serves the shop usually. At most one, checked below and in the index. */
  isPrimary: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

export type DistributorInput = z.infer<typeof distributorInput>;

const convertSchema = z.object({
  customerIds: z.array(z.string().min(1)).min(1),
  distributors: z.array(distributorInput).min(1),
});

/**
 * Everything both write paths have to establish before touching a row: that
 * these accounts are in the caller's book, and that these distributors are
 * accounts we bill.
 */
async function checkReachable(
  scope: Awaited<ReturnType<typeof requireCapability>>["scope"],
  customerIds: string[],
): Promise<string | null> {
  const clause = scopedToUsers(scopedUserIds(scope));
  if (!clause) return null;
  const reachable = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(inArray(customers.id, customerIds), clause));
  return reachable.length === customerIds.length
    ? null
    : "Some of those customers are not in your book.";
}

/**
 * Are these accounts we bill? Returns the message to refuse with, or null.
 *
 * One query for the whole list, and it names the FIRST offender rather than
 * saying "one of these is wrong" — a message somebody cannot act on is a
 * message that gets clicked through.
 */
async function checkDistributors(
  distributorIds: string[],
  shopIds: string[],
): Promise<string | null> {
  const unique = [...new Set(distributorIds)];
  if (unique.length !== distributorIds.length) {
    return "The same distributor is named twice. One arrangement per distributor.";
  }
  const clash = unique.find((d) => shopIds.includes(d));
  if (clash) return "An account cannot be its own distributor.";

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      kind: customers.kind,
      thirdParty: customers.thirdParty,
      status: customers.status,
    })
    .from(customers)
    .where(inArray(customers.id, unique));

  if (rows.length !== unique.length) return "That distributor no longer exists.";
  for (const r of rows) {
    if (r.kind !== "customer") {
      return `${r.name} has never ordered from us, so it cannot bill anybody. A distributor is an account we invoice.`;
    }
    if (r.thirdParty) {
      return `${r.name} is itself a third-party customer — we deliver to it and somebody else bills it, so it cannot be a distributor.`;
    }
    if (r.status === "deactivated") {
      return `${r.name} is deactivated, so it cannot be named as who bills a shop from today.`;
    }
  }
  return null;
}

/** At most one primary, said in words before the unique index says it in SQL. */
function checkOnePrimary(rows: DistributorInput[]): string | null {
  return rows.filter((d) => d.isPrimary).length > 1
    ? "Only one distributor can be the usual one."
    : null;
}

/**
 * Turn leads into third-party customers, naming who bills them.
 *
 * The mark and the links are ONE transaction. A marked account with no
 * distributor is the state rule 2 exists to prevent, and a failure half way
 * through a loop is exactly how it would come about.
 *
 * The distributors apply to every account in the list. That is the ordinary
 * case for a batch — a row of shops on one route is served by one distributor
 * — and it is why the dialog asks once rather than per shop.
 */
export async function convertToThirdParty(
  input: z.infer<typeof convertSchema>,
): Promise<Result<{ converted: number; links: number }>> {
  try {
    const parsed = convertSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        "Name at least one distributor before converting.",
        "validation",
      );
    }
    const { customerIds, distributors } = parsed.data;
    const ctx = await requireCapability("customer.classify");

    const primaryProblem = checkOnePrimary(distributors);
    if (primaryProblem) return err(primaryProblem, "validation");

    const unreachable = await checkReachable(ctx.scope, customerIds);
    if (unreachable) return err(unreachable, "not_permitted");

    const targets = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        thirdParty: customers.thirdParty,
      })
      .from(customers)
      .where(inArray(customers.id, customerIds));

    if (targets.length !== customerIds.length) {
      return err("One of those customers no longer exists.", "not_found");
    }
    /*
     * Rule 1, and the refusal names the account. A direct customer is one we
     * invoice; marking it as a shop somebody else invoices is two facts that
     * cannot both be true, and the honest way out of it is the other
     * direction — bill them or do not.
     */
    const direct = targets.find((t) => t.kind === "customer" && !t.thirdParty);
    if (direct) {
      return err(
        `${direct.name} is a direct customer — we bill them ourselves. Only a lead can become a third-party customer.`,
        "rule_violation",
      );
    }

    const distributorProblem = await checkDistributors(
      distributors.map((d) => d.distributorId),
      customerIds,
    );
    if (distributorProblem) return err(distributorProblem, "rule_violation");

    const now = new Date();
    let links = 0;
    const converted = targets.filter((t) => !t.thirdParty).map((t) => t.id);

    await db.transaction(async (tx) => {
      if (converted.length) {
        await tx
          .update(customers)
          .set({ thirdParty: true, updatedAt: now, updatedById: ctx.user.id })
          .where(inArray(customers.id, converted));
      }

      for (const customerId of customerIds) {
        for (const d of distributors) {
          /*
           * A pair already named is left as it is rather than duplicated. The
           * ordinary way this happens is a second pass over a batch where two
           * of the shops were already done, and refusing the whole request
           * over it would make the batch unusable.
           */
          const inserted = await tx
            .insert(customerDistributors)
            .values({
              id: id("cd"),
              customerId,
              distributorCustomerId: d.distributorId,
              isPrimary: d.isPrimary ?? false,
              note: d.note ?? null,
              createdById: ctx.user.id,
              updatedById: ctx.user.id,
            })
            .onConflictDoNothing({
              target: [
                customerDistributors.customerId,
                customerDistributors.distributorCustomerId,
              ],
            })
            .returning({ id: customerDistributors.id });
          links += inserted.length;
        }
      }

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.convertThirdParty",
        entityType: "customer",
        entityId: customerIds.length === 1 ? customerIds[0] : "bulk",
        afterState: {
          customerIds,
          distributorIds: distributors.map((d) => d.distributorId),
        },
      });
    });

    refresh();
    return ok(
      { converted: converted.length, links },
      converted.length
        ? `${converted.length} converted to third-party customer${converted.length === 1 ? "" : "s"}. They keep their history and stop being chased for a first order.`
        : "Already third-party customers - the distributors were added to them.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Lift the mark.
 *
 * Offered on any marked account, unlike converting — a shop that starts buying
 * from us directly is a good day, and needing a distributor named to undo
 * something is a trap. The LINKS ARE KEPT: who used to bill this shop is a
 * fact about it, the panel goes on showing them as former arrangements, and
 * deleting them would destroy the only record of how it was served.
 */
export async function revertThirdParty(
  customerIds: string[],
): Promise<Result<{ changed: number }>> {
  try {
    if (!customerIds.length) return err("Select at least one customer.", "validation");
    const ctx = await requireCapability("customer.classify");

    const unreachable = await checkReachable(ctx.scope, customerIds);
    if (unreachable) return err(unreachable, "not_permitted");

    const changed = await db
      .update(customers)
      .set({ thirdParty: false, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(
        and(inArray(customers.id, customerIds), eq(customers.thirdParty, true)),
      )
      .returning({ id: customers.id });

    if (changed.length) {
      await db.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.revertThirdParty",
        entityType: "customer",
        entityId: changed.length === 1 ? changed[0].id : "bulk",
        afterState: { thirdParty: false, customerIds: changed.map((c) => c.id) },
      });
    }

    refresh();
    return ok(
      { changed: changed.length },
      changed.length === 0
        ? "Nothing to change - none of those were third-party customers."
        : `${changed.length} no longer third-party. They return to the calling list, and who used to bill them is kept on the record.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Record a delivery address the ORDER SHEET already knows about.
 *
 * The one-tap version of what the convert dialog does at length, offered on
 * the row that reports the evidence: goods have gone to this shop on this
 * account's bills N times and nobody has written down the arrangement. The
 * button that does something about it belongs on the row that says so — the
 * alternative is reading the name, opening another screen, searching for it,
 * and picking the distributor you were just looking at.
 *
 * WHAT IT DOES DEPENDS ON WHAT THE SHOP IS, and that decision is made here
 * rather than on the screen, because it is the same rule the dialog obeys:
 *
 *   a lead              → converted, with this account as its distributor
 *   already third party → the arrangement is added to the ones it has
 *   a direct customer   → the arrangement is recorded and the account is NOT
 *                         converted. We invoice it ourselves, so calling it a
 *                         shop somebody else bills would be false — but the
 *                         sheet plainly shows goods reaching it on this
 *                         account's bill, and that is worth recording.
 */
export async function recordDeliveryAddress(input: {
  distributorId: string;
  shopId: string;
}): Promise<Result<{ converted: boolean }>> {
  try {
    const { distributorId, shopId } = input;
    if (!distributorId || !shopId) return err("Nothing to record.", "validation");

    const [shop] = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        thirdParty: customers.thirdParty,
      })
      .from(customers)
      .where(eq(customers.id, shopId));
    if (!shop) return err("That shop no longer exists.", "not_found");

    if (shop.kind === "lead" && !shop.thirdParty) {
      const converted = await convertToThirdParty({
        customerIds: [shopId],
        distributors: [{ distributorId }],
      });
      return converted.ok
        ? ok({ converted: true }, `${shop.name} recorded as a third-party customer.`)
        : converted;
    }

    const added = await addDistributor({ customerId: shopId, distributorId });
    return added.ok
      ? ok({ converted: false }, `${shop.name} recorded as a delivery address.`)
      : added;
  } catch (e) {
    return fromThrown(e);
  }
}

const addSchema = z.object({
  customerId: z.string().min(1),
  distributorId: z.string().min(1),
  isPrimary: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

/** Name another distributor for a shop. */
export async function addDistributor(
  input: z.infer<typeof addSchema>,
): Promise<Result<{ id: string }>> {
  try {
    const parsed = addSchema.safeParse(input);
    if (!parsed.success) return err("Pick a distributor.", "validation");
    const { customerId, distributorId, isPrimary, note } = parsed.data;
    const ctx = await requireCapability("customer.classify");

    const unreachable = await checkReachable(ctx.scope, [customerId]);
    if (unreachable) return err(unreachable, "not_permitted");

    const problem = await checkDistributors([distributorId], [customerId]);
    if (problem) return err(problem, "rule_violation");

    const existing = await db
      .select({ id: customerDistributors.id })
      .from(customerDistributors)
      .where(
        and(
          eq(customerDistributors.customerId, customerId),
          eq(customerDistributors.distributorCustomerId, distributorId),
        ),
      );
    if (existing.length) {
      return err("That distributor is already named for this shop.", "duplicate");
    }

    const linkId = id("cd");
    await db.transaction(async (tx) => {
      // One primary. Handing the badge over is what somebody means by ticking
      // it on a second row, so the first is cleared rather than the save being
      // refused — the unique index would refuse it, which is a 500 to a person
      // who did something reasonable.
      if (isPrimary) await clearPrimary(tx, customerId, ctx.user.id);
      await tx.insert(customerDistributors).values({
        id: linkId,
        customerId,
        distributorCustomerId: distributorId,
        isPrimary: isPrimary ?? false,
        note: note ?? null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.addDistributor",
        entityType: "customer",
        entityId: customerId,
        afterState: { distributorId, isPrimary: isPrimary ?? false },
      });
    });

    refresh();
    return ok({ id: linkId }, "Distributor added.");
  } catch (e) {
    return fromThrown(e);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function clearPrimary(tx: Tx, customerId: string, actorId: string) {
  await tx
    .update(customerDistributors)
    .set({ isPrimary: false, updatedAt: new Date(), updatedById: actorId })
    .where(
      and(
        eq(customerDistributors.customerId, customerId),
        eq(customerDistributors.isPrimary, true),
      ),
    );
}

const editSchema = z.object({
  linkId: z.string().min(1),
  /** Swapping WHICH distributor, where somebody named the wrong one. */
  distributorId: z.string().min(1).optional(),
  isPrimary: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/**
 * Change an arrangement: who it is with, whether they are the usual one, and
 * the note beside it.
 *
 * Swapping the distributor rather than deleting and re-adding keeps the row —
 * and with it who first recorded the arrangement and when. Naming the wrong
 * shop's distributor is an ordinary slip and correcting it should not read as
 * the arrangement having ended.
 */
export async function updateDistributor(
  input: z.infer<typeof editSchema>,
): Promise<Result> {
  try {
    const parsed = editSchema.safeParse(input);
    if (!parsed.success) return err("Nothing to change.", "validation");
    const { linkId, distributorId, isPrimary, note } = parsed.data;
    const ctx = await requireCapability("customer.classify");

    const [link] = await db
      .select({
        id: customerDistributors.id,
        customerId: customerDistributors.customerId,
        distributorId: customerDistributors.distributorCustomerId,
      })
      .from(customerDistributors)
      .where(eq(customerDistributors.id, linkId));
    if (!link) return err("That arrangement no longer exists.", "not_found");

    const unreachable = await checkReachable(ctx.scope, [link.customerId]);
    if (unreachable) return err(unreachable, "not_permitted");

    if (distributorId && distributorId !== link.distributorId) {
      const problem = await checkDistributors([distributorId], [link.customerId]);
      if (problem) return err(problem, "rule_violation");
      const clash = await db
        .select({ id: customerDistributors.id })
        .from(customerDistributors)
        .where(
          and(
            eq(customerDistributors.customerId, link.customerId),
            eq(customerDistributors.distributorCustomerId, distributorId),
            ne(customerDistributors.id, linkId),
          ),
        );
      if (clash.length) {
        return err(
          "That distributor is already named for this shop. Delete one of the two instead.",
          "duplicate",
        );
      }
    }

    await db.transaction(async (tx) => {
      if (isPrimary === true) await clearPrimary(tx, link.customerId, ctx.user.id);
      await tx
        .update(customerDistributors)
        .set({
          ...(distributorId ? { distributorCustomerId: distributorId } : {}),
          ...(isPrimary === undefined ? {} : { isPrimary }),
          // `null` clears the note; omitting the key leaves it alone. Two
          // different intentions that a single optional string cannot tell
          // apart, which is the same distinction `salesAmId` draws next door.
          ...(note === undefined ? {} : { note }),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(customerDistributors.id, linkId));
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.updateDistributor",
        entityType: "customer",
        entityId: link.customerId,
        beforeState: { distributorId: link.distributorId },
        afterState: { distributorId: distributorId ?? link.distributorId, isPrimary, note },
      });
    });

    refresh();
    return okVoid("Arrangement updated.");
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Remove an arrangement.
 *
 * THE LAST ONE IS REFUSED while the account is still marked, because a
 * third-party customer with nobody billing it is the state the conversion
 * rules exist to prevent — reached by deletion instead of by creation, which
 * makes it no better. The refusal says the way out: the shop either has
 * another distributor, or it is not a third-party customer any more.
 */
export async function removeDistributor(linkId: string): Promise<Result> {
  try {
    if (!linkId) return err("Nothing to remove.", "validation");
    const ctx = await requireCapability("customer.classify");

    const [link] = await db
      .select({
        id: customerDistributors.id,
        customerId: customerDistributors.customerId,
        distributorId: customerDistributors.distributorCustomerId,
        thirdParty: customers.thirdParty,
        remaining: sql<number>`(
          select count(*)::int from customer_distributors d
           where d.customer_id = customer_distributors.customer_id
             and d.id <> ${linkId}
        )`,
      })
      .from(customerDistributors)
      .innerJoin(customers, eq(customers.id, customerDistributors.customerId))
      .where(eq(customerDistributors.id, linkId));
    if (!link) return err("That arrangement no longer exists.", "not_found");

    const unreachable = await checkReachable(ctx.scope, [link.customerId]);
    if (unreachable) return err(unreachable, "not_permitted");

    if (link.thirdParty && Number(link.remaining) === 0) {
      return err(
        "A third-party customer has to have somebody billing it. Name another distributor first, or stop treating this account as a third-party customer.",
        "rule_violation",
      );
    }

    await db.transaction(async (tx) => {
      await tx.delete(customerDistributors).where(eq(customerDistributors.id, linkId));
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.removeDistributor",
        entityType: "customer",
        entityId: link.customerId,
        beforeState: { distributorId: link.distributorId },
      });
    });

    refresh();
    return okVoid("Distributor removed.");
  } catch (e) {
    return fromThrown(e);
  }
}
