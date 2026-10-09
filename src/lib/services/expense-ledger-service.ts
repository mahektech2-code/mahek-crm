import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import {
  approvedAmountSql,
  expenseStateSql,
  isAllowanceSql,
} from "@/lib/expense-money-sql";
import { scopeCovers } from "@/lib/sales-gate";
import {
  ledgerTotals,
  type LedgerLine,
  type LedgerLineState,
  type LedgerPayout,
  type LedgerTotals,
} from "@/lib/engines/expense-ledger";
import { expenseLines, type ExpenseLineRow } from "./expense-claims-service";
import { managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * THE EXPENSE LEDGER, read.
 *
 * Two questions, two functions. The team view asks "who is owed what" and
 * reads every line and payout of everybody in scope, lean, because a balance
 * is all-time — a payout in October settles a September fare. The person view
 * asks "explain his money" and reads one salesman's whole history in full:
 * each line with its bills, the decision and its remark, and everything the
 * policy said about it.
 *
 * Every figure is the engine's (`lib/engines/expense-ledger.ts`), over what a
 * line is WORTH as `lib/expense-money-sql.ts` defines it — the same reading
 * the claims list, the salary screen and the handset make.
 * ------------------------------------------------------------------------- */

export type Period = { from: string; to: string } | null;

export type PayoutRow = LedgerPayout & {
  userId: string;
  mode: string | null;
  reference: string | null;
  note: string | null;
  recordedByName: string | null;
  recordedAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
};

export type LedgerTeamRow = {
  userId: string;
  userName: string;
  /** The period's own figures — what was spent and decided in it. */
  period: LedgerTotals;
  /** All-time: what he is owed now, and any advance. */
  balance: LedgerTotals;
  lastPaidOn: string | null;
};

const inPeriod = (day: string, p: Period) =>
  !p || (day >= p.from && day <= p.to);

async function leanLines() {
  const scope = await managerScope();
  return db.execute<{
    id: string;
    userId: string;
    userName: string;
    day: string;
    loggedAt: string | null;
    allowance: boolean;
    state: LedgerLineState;
    claimedPaise: number | string;
    eligiblePaise: number | string | null;
    approvedAmountPaise: number | string | null;
  }>(sql`
    select e.id, e.user_id as "userId", u.name as "userName",
           e.expense_date::text as day,
           to_char(coalesce(e.client_created_at, e.server_created_at) at time zone ${APP_TIMEZONE},
                   'YYYY-MM-DD"T"HH24:MI:SS') as "loggedAt",
           ${isAllowanceSql("e")} as allowance,
           ${expenseStateSql("e")} as state,
           e.amount_paise as "claimedPaise",
           e.eligible_paise as "eligiblePaise",
           ${approvedAmountSql("e")} as "approvedAmountPaise"
      from mbos_expenses e
      join users u on u.id = e.user_id
     where e.superseded_by_id is null
       ${onlyMine(scope, "e.user_id")}
  `);
}

function toLedgerLine(r: {
  id: string;
  day: string;
  loggedAt: string | null;
  allowance: boolean;
  state: LedgerLineState;
  claimedPaise: number | string;
  eligiblePaise: number | string | null;
  approvedAmountPaise: number | string | null;
}): LedgerLine {
  return {
    id: r.id,
    day: r.day,
    loggedAt: r.loggedAt,
    allowance: r.allowance,
    state: r.state,
    claimedPaise: Number(r.claimedPaise),
    eligiblePaise: r.eligiblePaise == null ? null : Number(r.eligiblePaise),
    approvedAmountPaise:
      r.approvedAmountPaise == null ? null : Number(r.approvedAmountPaise),
  };
}

async function payoutRows(userId?: string): Promise<PayoutRow[]> {
  const scope = await managerScope();
  const rows = await db.execute<{
    id: string;
    userId: string;
    paidOn: string;
    amountPaise: number | string;
    mode: string | null;
    reference: string | null;
    note: string | null;
    recordedByName: string | null;
    recordedAt: string;
    voidedByName: string | null;
    voidedAt: string | null;
    voidReason: string | null;
  }>(sql`
    select p.id, p.user_id as "userId", p.paid_on::text as "paidOn", p.amount_paise as "amountPaise",
           p.mode, p.reference, p.note,
           rb.name as "recordedByName",
           to_char(p.recorded_at at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD"T"HH24:MI') as "recordedAt",
           vb.name as "voidedByName",
           to_char(p.voided_at at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD"T"HH24:MI') as "voidedAt",
           p.void_reason as "voidReason"
      from mbos_expense_payouts p
      left join users rb on rb.id = p.recorded_by_id
      left join users vb on vb.id = p.voided_by_id
     where true
       ${userId ? sql`and p.user_id = ${userId}` : sql``}
       ${onlyMine(scope, "p.user_id")}
     order by p.paid_on desc, p.recorded_at desc
  `);
  return rows.map((r) => ({
    ...r,
    amountPaise: Number(r.amountPaise),
    voided: r.voidedAt !== null,
  }));
}

/** Everybody in scope with a line or a payout: the period's figures and the balance. */
export async function expenseLedgerTeam(
  period: Period,
): Promise<LedgerTeamRow[]> {
  const [lines, payouts] = await Promise.all([leanLines(), payoutRows()]);
  const names = new Map<string, string>();
  const byUser = new Map<
    string,
    { lines: LedgerLine[]; payouts: LedgerPayout[] }
  >();
  const slot = (id: string) => {
    let s = byUser.get(id);
    if (!s) byUser.set(id, (s = { lines: [], payouts: [] }));
    return s;
  };
  for (const r of lines) {
    names.set(r.userId, r.userName);
    slot(r.userId).lines.push(toLedgerLine(r));
  }
  for (const p of payouts) slot(p.userId).payouts.push(p);

  const missing = [...byUser.keys()].filter((id) => !names.has(id));
  if (missing.length) {
    const rows = await db.execute<{ id: string; name: string }>(
      sql`select id, name from users where id in (${sql.join(
        missing.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    for (const r of rows) names.set(r.id, r.name);
  }

  return [...byUser.entries()]
    .map(([userId, s]) => {
      const counted = s.payouts
        .filter((p) => !p.voided)
        .map((p) => p.paidOn)
        .sort();
      return {
        userId,
        userName: names.get(userId) ?? "Unknown",
        period: ledgerTotals(
          s.lines.filter((l) => inPeriod(l.day, period)),
          s.payouts.filter((p) => inPeriod(p.paidOn, period)),
        ),
        balance: ledgerTotals(s.lines, s.payouts),
        lastPaidOn: counted.at(-1) ?? null,
      };
    })
    .filter(
      (r) =>
        r.balance.duePaise > 0 ||
        r.balance.advancePaise > 0 ||
        r.balance.pendingCount > 0 ||
        r.period.claimedCount + r.period.allowanceCount > 0 ||
        r.period.paidPaise > 0,
    );
}

export type PolicyNote = {
  message: string;
  severity: string;
  resolution: string | null;
  resolutionNote: string | null;
};

export type LedgerPerson = {
  userId: string;
  userName: string;
  lines: ExpenseLineRow[];
  /** Everything the policy said about a line, keyed by the line. */
  notes: Record<string, PolicyNote[]>;
  payouts: PayoutRow[];
};

/** One salesman's whole history, or null where he is not in the reader's scope. */
export async function expenseLedgerFor(
  userId: string,
): Promise<LedgerPerson | null> {
  const scope = await managerScope();
  if (!scopeCovers(scope, userId)) return null;
  const [user] = await db.execute<{ id: string; name: string }>(
    sql`select id, name from users where id = ${userId}`,
  );
  if (!user) return null;

  const [lines, payouts, notes] = await Promise.all([
    expenseLines({ userId }),
    payoutRows(userId),
    db.execute<PolicyNote & { expenseId: string }>(sql`
      select x.expense_id as "expenseId", x.message, x.severity, x.resolution,
             x.resolution_note as "resolutionNote"
        from mbos_expense_exceptions x
       where x.user_id = ${userId} and x.expense_id is not null
       order by x.raised_at
    `),
  ]);

  const byLine: Record<string, PolicyNote[]> = {};
  for (const { expenseId, ...n } of notes) (byLine[expenseId] ??= []).push(n);
  return { userId, userName: user.name, lines, notes: byLine, payouts };
}

/** The engine's view of a full row. */
export function ledgerLineOf(r: ExpenseLineRow): LedgerLine {
  return {
    id: r.id,
    day: r.day,
    loggedAt: r.raisedAt,
    allowance: r.allowance,
    state: r.state,
    claimedPaise: r.claimedPaise,
    eligiblePaise: r.eligiblePaise,
    approvedAmountPaise: r.approvedAmountPaise,
  };
}
