import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import {
  approvedAmountSql,
  decisionNoteSql,
  expenseStateSql,
  isAllowanceSql,
} from "@/lib/expense-money-sql";
import { managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * Every expense and allowance, ONE ROW EACH, as the person deciding sees them.
 *
 * The unit used to be the DAY: a salesman closed his day on the phone, the
 * day was priced and locked, and the day was approved or cut. Almost nobody
 * closed a day, so almost nothing reached this screen, and what he had logged
 * sat on the server drawn nowhere a manager looks. Each expense is now its own
 * decision from the moment he logs it, and each allowance is listed beside
 * them, already his.
 *
 * What a line IS and what it is WORTH come from `lib/expense-money-sql.ts`,
 * the same reading the handset's own list and the salary screen make.
 * ------------------------------------------------------------------------- */

export type ExpenseFile = { id: string; filename: string; contentType: string; gone: boolean };

export type ExpenseState = "allowance" | "pending" | "approved" | "partially_approved" | "rejected";

export type ExpenseLineRow = {
  id: string;
  userId: string;
  userName: string;
  day: string;
  kind: string;
  claimedPaise: number;
  /** What the policy allows on it, where the day has been priced. */
  eligiblePaise: number | null;
  /** How far over the policy he went. Shown, never refused. */
  excessPaise: number;
  remarks: string | null;
  vendorName: string | null;
  billNumber: string | null;
  allowance: boolean;
  state: ExpenseState;
  approvedAmountPaise: number | null;
  decisionNote: string | null;
  decidedByName: string | null;
  /** Flags on this line or its day nobody has answered — Flagged expenses. */
  openFlags: number;
  raisedAt: string | null;
  files: ExpenseFile[];
};

export async function expenseLines(opts: { from: string; to: string }): Promise<ExpenseLineRow[]> {
  const scope = await managerScope();
  const rows = await db.execute<{
    id: string;
    userId: string;
    userName: string;
    day: string;
    kind: string;
    claimedPaise: number | string;
    eligiblePaise: number | string | null;
    excessPaise: number | string | null;
    remarks: string | null;
    vendorName: string | null;
    billNumber: string | null;
    allowance: boolean;
    state: ExpenseState;
    approvedAmountPaise: number | string | null;
    decisionNote: string | null;
    decidedByName: string | null;
    openFlags: number;
    raisedAt: string | null;
    billPhotoId: string | null;
  }>(sql`
    select e.id, e.user_id as "userId", u.name as "userName",
           e.expense_date::text as day,
           coalesce(e.kind, e.category::text) as kind,
           e.amount_paise as "claimedPaise",
           e.eligible_paise as "eligiblePaise",
           e.excess_paise as "excessPaise",
           e.remarks, e.vendor_name as "vendorName", e.bill_number as "billNumber",
           e.bill_photo_id as "billPhotoId",
           ${isAllowanceSql("e")} as allowance,
           ${expenseStateSql("e")} as state,
           ${approvedAmountSql("e")} as "approvedAmountPaise",
           ${decisionNoteSql("e")} as "decisionNote",
           (select du.name from mbos_approvals ap
              join users du on du.id = ap.approver_user_id
             where ap.subject_type = 'expense' and ap.subject_id = e.id
             order by ap.step_index desc, ap.requested_at desc limit 1) as "decidedByName",
           (select count(*)::int from mbos_expense_exceptions x
             where x.resolved_at is null
               and (x.expense_id = e.id
                    or (x.expense_id is null and x.travel_leg_id is null
                        and x.expense_day_id = e.expense_day_id))) as "openFlags",
           to_char(coalesce(e.client_created_at, e.server_created_at)
                   at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD"T"HH24:MI') as "raisedAt"
      from mbos_expenses e
      join users u on u.id = e.user_id
     where e.superseded_by_id is null
       and e.expense_date between ${opts.from}::date and ${opts.to}::date
       ${onlyMine(scope, "e.user_id")}
     order by e.expense_date desc, coalesce(e.client_created_at, e.server_created_at) desc
  `);
  if (!rows.length) return [];

  /* Every file behind a logged expense — a bill is often two photographs and a
     payment screenshot. One query for the whole list, not one per row. A file
     is found by EITHER link: filed under the expense, or named as its bill.
     The second is how an older build recorded it, and how a bill reads in the
     moment before the upload that files it has landed — showing "no bill" to
     the person deciding, over a bill that is plainly there, is the failure. */
  const logged = rows.filter((r) => !r.allowance);
  const ids = logged.map((r) => r.id);
  const bills = logged.map((r) => r.billPhotoId).filter((b): b is string => !!b);
  const files = ids.length
    ? await db.execute<{
        parentId: string | null;
        id: string;
        filename: string;
        contentType: string;
        status: string;
      }>(sql`
        select a.parent_id as "parentId", a.id, a.filename, a.content_type as "contentType",
               a.status::text as status
          from attachments a
         where (a.parent_type = 'mbos_expense'
                and a.parent_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}))
            ${bills.length ? sql`or a.id in (${sql.join(bills.map((b) => sql`${b}`), sql`, `)})` : sql``}
         order by a.created_at, a.id
      `)
    : [];

  const num = (v: number | string | null) => (v == null ? null : Number(v));
  return rows.map(({ billPhotoId, ...r }) => ({
    ...r,
    claimedPaise: Number(r.claimedPaise),
    eligiblePaise: num(r.eligiblePaise),
    excessPaise: Number(r.excessPaise ?? 0),
    approvedAmountPaise: num(r.approvedAmountPaise),
    files: files
      .filter((f) => f.parentId === r.id || (f.id === billPhotoId && f.parentId == null))
      .map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        gone: f.status === "removed",
      })),
  }));
}
