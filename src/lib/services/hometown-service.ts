import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, expenseHometowns } from "@/db/schema";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { err, okVoid, type Result } from "@/lib/result";
import { refreshDayMoney } from "./expense-submit-service";

/* ---------------------------------------------------------------------------
 * WHERE A SALESMAN LIVES — one record, two doors.
 *
 * The expense policy pays meals only on a day spent away from home, and the
 * office decides which days those are from the towns of the shops he checked
 * in at (`lib/expense-hometown.ts`). Those towns are read through
 * `placeNameSql` — the REVIEWED tree's name where a shop has one — so a
 * hometown is picked from that same tree and never typed: a typed "Nagpur " or
 * "nagpur city" is a town no shop is in, and every day of his would read as a
 * day away.
 *
 * It is set on the Sales Dashboard's Salesmen screen, beside where he works,
 * and on the Admin Console's "Who is on which" — both write through
 * `writeHometown`, so the two cannot disagree about what a hometown is.
 * ------------------------------------------------------------------------- */

export type HometownCity = {
  id: string;
  name: string;
  /** The district above it, printed as a hint — two towns can share a name. */
  district: string | null;
  /** Shops placed in it, so the town somebody means is near the top. */
  shops: number;
};

export type HometownState = {
  id: string;
  name: string;
  cities: HometownCity[];
  shops: number;
};

/** The reviewed tree, state › city, biggest first. */
export async function hometownTree(): Promise<HometownState[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    district: string | null;
    stateId: string | null;
    state: string | null;
    shops: number;
  }>(sql`
    select c.id, c.name, d.name as district,
           s.id as "stateId", s.name as state,
           coalesce(n.shops, 0)::int as shops
      from places c
      left join places d on d.id = c.parent_id and d.kind = 'district'
      left join places s on s.id = coalesce(d.parent_id, c.parent_id) and s.kind = 'state'
      left join (
        select resolved_city_id as id, count(*) as shops
          from customers
         where resolved_city_id is not null
         group by 1
      ) n on n.id = c.id
     where c.kind = 'city'
  `);

  const states = new Map<string, HometownState>();
  for (const r of rows) {
    if (!r.stateId || !r.state) continue;
    let node = states.get(r.stateId);
    if (!node) {
      node = { id: r.stateId, name: r.state, cities: [], shops: 0 };
      states.set(r.stateId, node);
    }
    node.cities.push({
      id: r.id,
      name: r.name,
      district: r.district,
      shops: r.shops,
    });
    node.shops += r.shops;
  }
  const list = [...states.values()];
  for (const s of list) {
    s.cities.sort((a, b) => b.shops - a.shops || a.name.localeCompare(b.name));
  }
  return list.sort((a, b) => b.shops - a.shops || a.name.localeCompare(b.name));
}

/** A city node, with the state it sits in — or null where the id is not a city. */
async function cityNode(
  placeId: string,
): Promise<{ id: string; name: string; state: string | null } | null> {
  const [row] = await db.execute<{
    id: string;
    name: string;
    state: string | null;
  }>(sql`
    select c.id, c.name, s.name as state
      from places c
      left join places d on d.id = c.parent_id and d.kind = 'district'
      left join places s on s.id = coalesce(d.parent_id, c.parent_id) and s.kind = 'state'
     where c.id = ${placeId} and c.kind = 'city'
  `);
  return row ?? null;
}

/**
 * Set or clear one salesman's hometown. The CALLER decides who may — this
 * only knows what a hometown is. Today's and yesterday's allowances are
 * re-worked so the effect is on the next screen anybody opens.
 */
export async function writeHometown(
  actorId: string,
  userId: string,
  placeId: string | null,
): Promise<Result> {
  const node = placeId ? await cityNode(placeId) : null;
  if (placeId && !node) return err("Pick a town from the list.", "validation");

  const [before] = await db
    .select({
      city: expenseHometowns.city,
      state: expenseHometowns.state,
      placeId: expenseHometowns.placeId,
    })
    .from(expenseHometowns)
    .where(eq(expenseHometowns.userId, userId))
    .limit(1);
  const unchanged = node
    ? before?.placeId === node.id && before.city === node.name
    : !before;
  if (unchanged) return okVoid("Nothing changed.");

  if (node) {
    const values = {
      city: node.name,
      state: node.state,
      placeId: node.id,
      setById: actorId,
      setAt: new Date(),
    };
    await db
      .insert(expenseHometowns)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: expenseHometowns.userId, set: values });
  } else {
    await db
      .delete(expenseHometowns)
      .where(eq(expenseHometowns.userId, userId));
  }

  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId,
    action: "expense_policy.hometown",
    entityType: "expense_policy",
    entityId: userId,
    beforeState: (before
      ? { city: before.city, state: before.state }
      : { city: null }) as never,
    afterState: (node
      ? { city: node.name, state: node.state, placeId: node.id }
      : { city: null }) as never,
  });
  await repriceRecentExpenseDays([userId]);

  return okVoid(
    node
      ? `Hometown set to ${node.name}${node.state ? `, ${node.state}` : ""}.`
      : "Hometown cleared.",
  );
}

/**
 * Re-work today's and yesterday's allowances for the people a change moves,
 * so a new figure is on the next screen anybody opens rather than tomorrow
 * morning. The nightly pass covers everything older. Best effort: whatever
 * changed is saved whether or not this finishes.
 */
export async function repriceRecentExpenseDays(userIds: readonly string[]) {
  if (userIds.length === 0) return;
  const day = await today();
  const from = addDays(day, -1);
  const rows = await db.execute<{ userId: string; day: string }>(sql`
    select user_id as "userId", day::text as day
      from mbos_expense_days
     where user_id in (${sql.join(
       userIds.map((u) => sql`${u}`),
       sql`, `,
     )})
       and day >= ${from}::date
  `);
  for (const r of rows) {
    try {
      await refreshDayMoney(r.userId, r.day);
    } catch {
      /* One day that cannot be re-worked must not cost the others. */
    }
  }
}
