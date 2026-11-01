import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { addDays, APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import type { FactoryCtx } from "./server";
import { HISTORY_DAYS, historyKind, type HistoryDay } from "./types";

/* ---------------------------------------------------------------------------
 * MY HISTORY: what this person did on one day, read off the audit trail.
 *
 * Every door in the factory app already writes a sentence to `audit_log` as
 * it acts — "Filling started from L-204", "B-118 loaded on Lorry 2" — so the
 * history is those sentences, not a second record kept beside them. A second
 * record would be one more write on every path, and the path somebody forgot
 * would be the line missing from their day.
 *
 * Only the person's OWN lines, whoever they are. A supervisor reading the
 * floor has the Today and Review screens; this answers "what did I do".
 * Work still queued on the phone is not here — it has not happened as far as
 * the ERP knows — and the screen says so beside the Sync count.
 * ------------------------------------------------------------------------- */

const CAP = 300;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function historyFor(fc: FactoryCtx, asked: string | null | undefined): Promise<HistoryDay> {
  const today: string = calendarDate(new Date());
  const day = asked && DAY_RE.test(asked) ? asked : today;
  if (day > today) return { ok: false, error: "That day has not happened yet." };
  if (day < addDays(today, -HISTORY_DAYS)) return { ok: false, error: `History goes back ${HISTORY_DAYS} days.` };
  const rows = (await db.execute(sql`
    select at, action, after_state->>'detail' as detail
      from audit_log
     where actor_id = ${fc.user.id}
       and actor_app = 'factory'
       and at >= (${day}::date)::timestamp at time zone ${APP_TIMEZONE}
       and at < ((${day}::date) + 1)::timestamp at time zone ${APP_TIMEZONE}
     order by at desc, id desc
     limit ${CAP + 1}`)) as unknown as { at: string | Date; action: string; detail: string | null }[];
  const items = rows.slice(0, CAP).map((r) => ({
    at: new Date(r.at).toISOString(),
    kind: historyKind(r.action),
    text: r.detail?.trim() || r.action.replace(/^factory\./, ""),
  }));
  return { ok: true, day, today, items, more: rows.length > CAP };
}
