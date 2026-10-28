import { desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { calls, mbosVisits, users } from "@/db/schema";
import { CALL_MARK, OUTCOME_LABEL, isCallOutcome } from "@/lib/engines/lead-calling-desk";
import {
  GENERAL_CALL,
  GENERAL_CALL_OUTCOMES,
  WEB_VISIT_UNVERIFIED,
  mergeActivity,
  visitOutcomeLabel,
  type ActivityRow,
} from "@/lib/lead-activity";

/* ---------------------------------------------------------------------------
 * ONE HISTORY OF CALLS AND VISITS FOR A LEAD, oldest facts untouched.
 *
 * Both are READ, never re-written: a call is a `calls` row and a visit is an
 * `mbos_visits` row, each in the table that owns it, so a history that merges
 * them is a view and not a third store to keep in step. The scope check is the
 * caller's (the action asks `assertCustomerInScope` before it gets here) — this
 * is the query.
 *
 * Capped, because a lead with a long life is exactly the one somebody opens
 * before ringing, and an unbounded read is the record that was serialising
 * three thousand rows into a page elsewhere in this product. The newest
 * `LIMIT` of each kind are read, then merged, so the merged page is the true
 * newest `LIMIT` of the two.
 * ------------------------------------------------------------------------- */

export const ACTIVITY_LIMIT = 100;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : new Date(0).toISOString());

export async function leadActivityHistory(customerId: string): Promise<ActivityRow[]> {
  const [callRows, visitRows] = await Promise.all([
    db
      .select({
        id: calls.id,
        byId: calls.userId,
        byName: users.name,
        startedAt: calls.startedAt,
        notes: calls.notes,
        outcome: calls.outcome,
        detail: calls.outcomeDetail,
        direction: calls.direction,
      })
      .from(calls)
      .leftJoin(users, eq(users.id, calls.userId))
      .where(eq(calls.customerId, customerId))
      .orderBy(desc(calls.startedAt))
      .limit(ACTIVITY_LIMIT),
    db
      .select({
        id: mbosVisits.id,
        byId: mbosVisits.salesmanId,
        byName: users.name,
        checkInAt: mbosVisits.checkInAt,
        createdAt: mbosVisits.serverCreatedAt,
        outcome: mbosVisits.outcome,
        notes: mbosVisits.notes,
        nextFollowUpDate: mbosVisits.nextFollowUpDate,
        deviceId: mbosVisits.deviceId,
        createdById: mbosVisits.createdById,
        verified: mbosVisits.verified,
        unverifiedReason: mbosVisits.unverifiedReason,
      })
      .from(mbosVisits)
      .leftJoin(users, eq(users.id, mbosVisits.salesmanId))
      .where(eq(mbosVisits.customerId, customerId))
      .orderBy(desc(mbosVisits.serverCreatedAt))
      .limit(ACTIVITY_LIMIT),
  ]);

  /* A visit recorded for somebody else says who entered it. */
  const enteredIds = Array.from(
    new Set(visitRows.filter((v) => v.deviceId === null && v.createdById && v.createdById !== v.byId).map((v) => v.createdById as string)),
  );
  const enteredBy = new Map<string, string>(
    enteredIds.length
      ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, enteredIds))).map((u) => [u.id, u.name] as [string, string])
      : [],
  );

  const rows: ActivityRow[] = [];

  for (const c of callRows) {
    const d = (c.detail ?? {}) as Record<string, string>;
    const qual = d[CALL_MARK];
    const general = d.activity === GENERAL_CALL;
    const qualOutcome = d.qualOutcome;
    const outcome = qual
      ? isCallOutcome(qualOutcome)
        ? OUTCOME_LABEL[qualOutcome]
        : (qualOutcome ?? null)
      : general
        ? (GENERAL_CALL_OUTCOMES.find((o) => o.code === d.generalOutcome)?.label ?? null)
        : (c.outcome ? c.outcome.replaceAll("_", " ") : null);
    rows.push({
      key: `call:${c.id}`,
      type: "call",
      kind: qual ? "qualification_call" : general ? "general_call" : "call",
      at: iso(c.startedAt),
      byId: c.byId,
      byName: c.byName ?? null,
      title: qual
        ? `Qualification call ${qual} of 3`
        : c.direction === "inbound"
          ? "Call received"
          : "Call",
      outcome,
      notes: c.notes ?? null,
      followUpDate: d.nextDate ?? null,
      followUpText: d.nextAction ?? null,
      source: qual ? "desk" : "web",
      note: null,
    });
  }

  for (const v of visitRows) {
    const handset = v.deviceId !== null;
    rows.push({
      key: `visit:${v.id}`,
      type: "visit",
      kind: "visit",
      at: iso(v.checkInAt ?? v.createdAt),
      byId: v.byId,
      byName: v.byName ?? null,
      title: "Visit",
      outcome: visitOutcomeLabel(v.outcome),
      notes: v.notes ?? null,
      followUpDate: v.nextFollowUpDate ?? null,
      followUpText: null,
      source: handset ? "handset" : "web",
      /* A hand-entered visit says so; a handset visit that failed its location
         check carries the reason it already stored. */
      note: handset
        ? v.verified
          ? null
          : (v.unverifiedReason ?? null)
        : v.createdById && v.createdById !== v.byId && enteredBy.get(v.createdById)
          ? `Entered by ${enteredBy.get(v.createdById)} — ${WEB_VISIT_UNVERIFIED}`
          : WEB_VISIT_UNVERIFIED,
    });
  }

  return mergeActivity(rows).slice(0, ACTIVITY_LIMIT);
}
