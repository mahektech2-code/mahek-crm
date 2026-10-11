import "server-only";
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
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
 * He may have several — a day in any of them is a day at home. They are set on
 * the Sales Dashboard's Salesmen screen, beside where he works, and on the
 * Admin Console's "Who is on which" — both write through `writeHometowns`, so
 * the two cannot disagree about what a hometown is.
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

/** The city nodes among `placeIds`, each with the state it sits in. */
async function cityNodes(
  placeIds: readonly string[],
): Promise<{ id: string; name: string; state: string | null }[]> {
  if (placeIds.length === 0) return [];
  return db.execute<{ id: string; name: string; state: string | null }>(sql`
    select c.id, c.name, s.name as state
      from places c
      left join places d on d.id = c.parent_id and d.kind = 'district'
      left join places s on s.id = coalesce(d.parent_id, c.parent_id) and s.kind = 'state'
     where c.id in (${sql.join(
       placeIds.map((id) => sql`${id}`),
       sql`, `,
     )})
       and c.kind = 'city'
  `);
}

/** "Nagpur, Maharashtra" — the way a hometown is said on a screen and in a toast. */
const said = (h: { city: string; state: string | null }) =>
  h.state ? `${h.city}, ${h.state}` : h.city;

/** The towns a salesman lives in, as they stand. */
export async function hometownsOf(userId: string) {
  return db
    .select({
      city: expenseHometowns.city,
      state: expenseHometowns.state,
      placeId: expenseHometowns.placeId,
      setAt: expenseHometowns.setAt,
      setById: expenseHometowns.setById,
    })
    .from(expenseHometowns)
    .where(eq(expenseHometowns.userId, userId))
    .orderBy(asc(expenseHometowns.setAt), asc(expenseHometowns.city));
}

/**
 * Set one salesman's hometowns — the WHOLE set, so a town left out of
 * `placeIds` is a town taken off, and an empty list clears them. He may have
 * several: a day in any of them is a day at home. The CALLER decides who may —
 * this only knows what a hometown is. Today's and yesterday's allowances are
 * re-worked so the effect is on the next screen anybody opens.
 */
export async function writeHometowns(
  actorId: string,
  userId: string,
  placeIds: readonly string[],
  /**
   * Towns typed before the picker existed that are to STAY — named, because a
   * typed town has no place to be picked as, and saving the picker must not
   * quietly drop one nobody has re-picked yet.
   */
  keepTyped: readonly string[] = [],
): Promise<Result> {
  const wanted = [...new Set(placeIds.filter(Boolean))];
  const nodes = await cityNodes(wanted);
  if (nodes.length !== wanted.length) return err("Pick each town from the list.", "validation");
  /* The rule compares town NAMES, so two towns of one name are one hometown. */
  const byName = new Map<string, (typeof nodes)[number]>();
  for (const id of wanted) {
    const n = nodes.find((x) => x.id === id)!;
    if (!byName.has(n.name)) byName.set(n.name, n);
  }
  const before = await hometownsOf(userId);
  /* A typed town stays only where it was already his and is still wanted —
     this is never a way to type a new one in. */
  const typed = before
    .filter((b) => !b.placeId && keepTyped.includes(b.city) && !byName.has(b.city))
    .map((b) => ({ id: null as string | null, name: b.city, state: b.state }));
  const next = [...byName.values(), ...typed];

  const key = (h: { city: string; placeId: string | null }) => `${h.placeId ?? ""}|${h.city}`;
  const was = new Set(before.map(key));
  const now = new Set(next.map((n) => key({ city: n.name, placeId: n.id })));
  if (was.size === now.size && [...now].every((k) => was.has(k))) return okVoid("Nothing changed.");

  await db.transaction(async (tx) => {
    await tx.delete(expenseHometowns).where(eq(expenseHometowns.userId, userId));
    if (next.length > 0) {
      /* A town he already had keeps who set it and when. */
      const kept = new Map(before.map((b) => [key(b), b] as const));
      await tx.insert(expenseHometowns).values(
        next.map((n) => {
          const old = kept.get(key({ city: n.name, placeId: n.id }));
          return {
            userId,
            city: n.name,
            state: n.state,
            placeId: n.id,
            setById: old ? old.setById : actorId,
            setAt: old ? old.setAt : new Date(),
          };
        }),
      );
    }
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId,
      action: "expense_policy.hometown",
      entityType: "expense_policy",
      entityId: userId,
      beforeState: { towns: before.map((b) => ({ city: b.city, state: b.state })) } as never,
      afterState: {
        towns: next.map((n) => ({ city: n.name, state: n.state, placeId: n.id })),
      } as never,
    });
  });
  await repriceRecentExpenseDays([userId]);

  if (next.length === 0) return okVoid("Hometowns cleared.");
  const list = next.map((n) => said({ city: n.name, state: n.state }));
  return okVoid(
    list.length === 1 ? `Hometown set to ${list[0]}.` : `Hometowns set to ${list.join("; ")}.`,
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
