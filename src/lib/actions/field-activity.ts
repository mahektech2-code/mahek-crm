"use server";

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  customers,
  fieldActivityCustomerDecisions,
  sheetFieldActivityRows,
  users,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";
import { salesGateRefusal } from "@/lib/sales-gate";
import { foldShopName } from "@/lib/field-activity-match";
import { accountTypeLabel } from "@/lib/account-types";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { nearShopNames } from "@/lib/services/shop-name-match-service";
import { rejudgeShopName } from "@/lib/services/field-activity-sync-service";
import { projectFieldActivityTimeline } from "@/lib/services/field-activity-projection-service";

/* ---------------------------------------------------------------------------
 * Deciding which account an old-app shop name is.
 *
 * The importer links only an exact name that one account carries; everything
 * else is a person's to decide, here, once per NAME — every row typed under
 * it moves together, and the sync never overrides it. A Sales Dashboard
 * manager holding Activity history decides, because a link puts visits on a
 * customer's timeline that every later reader takes as fact.
 * ------------------------------------------------------------------------- */

const MODULE = "sales.activity-history";

async function requireDecider() {
  const user = await requireUser();
  const [level, platformAdmin, held] = await Promise.all([
    levelInApp(user, "sales"),
    isPlatformAdmin(user),
    canOpenModule(user.id, MODULE),
  ]);
  const refusal = salesGateRefusal({
    level,
    platformAdmin,
    needManager: true,
    modulesAsked: [MODULE],
    modulesHeld: held ? [MODULE] : [],
  });
  if (refusal) throw Object.assign(new Error(refusal), { name: "NotPermittedError" });
  return user;
}

export type ShopChoice = { id: string; name: string; city: string | null; type: string };

export type ShopChoices = {
  shownName: string;
  nameKey: string;
  /** Rows the old app typed under this name — what one decision moves. */
  rows: number;
  decision: { customer: ShopChoice | null; by: string | null; at: string } | null;
  /** Accounts carrying exactly this name. */
  exact: ShopChoice[];
  /** Close names, for reading. Never linked on their own. */
  near: ShopChoice[];
};

async function describe(ids: string[]): Promise<Map<string, ShopChoice>> {
  if (!ids.length) return new Map();
  const rows = await db.execute<{ id: string; name: string; city: string | null; kind: string; third_party: boolean }>(sql`
    select id, name, city, kind::text, third_party from customers
     where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `);
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, name: r.name, city: r.city, type: accountTypeLabel({ kind: r.kind, thirdParty: r.third_party }) },
    ]),
  );
}

async function nameOfRow(rowId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: sheetFieldActivityRows.customerName })
    .from(sheetFieldActivityRows)
    .where(eq(sheetFieldActivityRows.id, rowId));
  return row?.name?.trim() || null;
}

export async function activityShopChoices(input: { rowId: string }): Promise<Result<ShopChoices>> {
  try {
    await requireDecider();
    const shownName = await nameOfRow(input.rowId);
    if (!shownName) return err("This row names no shop.", "not_found");
    const nameKey = foldShopName(shownName);

    const [counted, decided, exactRows, near] = await Promise.all([
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from sheet_field_activity_rows
         where btrim(regexp_replace(upper(coalesce(customer_name, '')), '[^A-Z0-9]+', ' ', 'g')) = ${nameKey}
      `),
      db
        .select({
          customerId: fieldActivityCustomerDecisions.customerId,
          at: fieldActivityCustomerDecisions.decidedAt,
          by: users.name,
        })
        .from(fieldActivityCustomerDecisions)
        .leftJoin(users, eq(users.id, fieldActivityCustomerDecisions.decidedById))
        .where(eq(fieldActivityCustomerDecisions.nameKey, nameKey)),
      db.execute<{ id: string }>(sql`
        select id from customers
         where btrim(regexp_replace(upper(name), '[^A-Z0-9]+', ' ', 'g')) = ${nameKey}
         order by name, city
      `),
      nearShopNames(shownName, 8),
    ]);
    const exactIds = exactRows.map((r) => r.id);
    const nearIds = near.map((n) => n.id).filter((id) => !exactIds.includes(id));
    const d = decided[0];
    const all = await describe([...exactIds, ...nearIds, ...(d?.customerId ? [d.customerId] : [])]);

    return ok({
      shownName,
      nameKey,
      rows: Number(counted[0]?.n ?? 0),
      decision: d
        ? { customer: d.customerId ? (all.get(d.customerId) ?? null) : null, by: d.by, at: d.at.toISOString() }
        : null,
      exact: exactIds.map((id) => all.get(id)!).filter(Boolean),
      near: nearIds.map((id) => all.get(id)!).filter(Boolean),
    });
  } catch (e) {
    return fromThrown(e);
  }
}

export async function searchActivityShops(input: { q: string }): Promise<Result<ShopChoice[]>> {
  try {
    await requireDecider();
    const q = input.q.trim();
    if (q.length < 2) return ok([]);
    const found = await nearShopNames(q, 10);
    const all = await describe(found.map((f) => f.id));
    return ok(found.map((f) => all.get(f.id)!).filter(Boolean));
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Decide the shop for every row under this row's name. `customerId` null is
 * "this shop is not on MahekOne".
 */
export async function decideActivityShop(input: {
  rowId: string;
  customerId: string | null;
}): Promise<Result<{ rows: number }>> {
  try {
    const user = await requireDecider();
    const shownName = await nameOfRow(input.rowId);
    if (!shownName) return err("This row names no shop.", "not_found");
    const nameKey = foldShopName(shownName);

    if (input.customerId) {
      const [c] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, input.customerId));
      if (!c) return err("That account is no longer on MahekOne.", "not_found");
    }

    const [before] = await db
      .select()
      .from(fieldActivityCustomerDecisions)
      .where(eq(fieldActivityCustomerDecisions.nameKey, nameKey));

    await db
      .insert(fieldActivityCustomerDecisions)
      .values({ nameKey, shownName, customerId: input.customerId, decidedById: user.id })
      .onConflictDoUpdate({
        target: fieldActivityCustomerDecisions.nameKey,
        set: { shownName, customerId: input.customerId, decidedById: user.id, decidedAt: new Date() },
      });

    const moved = await rejudgeShopName(nameKey);
    await projectFieldActivityTimeline();

    await db.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: user.id,
      action: "mbos.oldAppShop.decide",
      entityType: "field_activity_shop",
      entityId: nameKey,
      beforeState: (before ? { customerId: before.customerId } : null) as never,
      afterState: { customerId: input.customerId, rows: moved.rows } as never,
    });

    return ok(
      { rows: moved.rows },
      input.customerId
        ? `Linked ${moved.rows} visit${moved.rows === 1 ? "" : "s"} typed as "${shownName}".`
        : `Marked "${shownName}" as not on MahekOne (${moved.rows} visit${moved.rows === 1 ? "" : "s"}).`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** Take a decision back: the name goes back to the importer's own rule. */
export async function undoActivityShopDecision(input: { rowId: string }): Promise<Result<{ rows: number }>> {
  try {
    const user = await requireDecider();
    const shownName = await nameOfRow(input.rowId);
    if (!shownName) return err("This row names no shop.", "not_found");
    const nameKey = foldShopName(shownName);

    const removed = await db
      .delete(fieldActivityCustomerDecisions)
      .where(eq(fieldActivityCustomerDecisions.nameKey, nameKey))
      .returning({ customerId: fieldActivityCustomerDecisions.customerId });
    if (!removed.length) return ok({ rows: 0 }, "Nobody had decided this name.");

    const moved = await rejudgeShopName(nameKey);
    await projectFieldActivityTimeline();

    await db.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: user.id,
      action: "mbos.oldAppShop.undo",
      entityType: "field_activity_shop",
      entityId: nameKey,
      beforeState: { customerId: removed[0].customerId } as never,
      afterState: { rows: moved.rows } as never,
    });

    return ok({ rows: moved.rows }, "Decision taken back.");
  } catch (e) {
    return fromThrown(e);
  }
}
