import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { advanceLabel, txnLabel } from "@/lib/erp/engines/money";
import { txnRows, type TxnRow } from "@/lib/erp/money";
import { inr } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * PETTY CASH NEVER DELETES MONEY, it cancels it — and a cancelled transaction
 * stops counting in every balance at once. That is the part a person at the
 * Cancel button does not see: an expense cancelled puts its money back in the
 * account it left, a receipt cancelled takes it out of the one it landed in,
 * and an expense paid from a cash receipt hands that cash back as unused.
 *
 * Every refusal here is the act's own sentence, read off the same row the act
 * locks, so the modal says why before the button would.
 * ------------------------------------------------------------------------- */

/** Every Petty Cash tab sits under the one `expenses` screen grant, as the server actions check. */
const MONEY = ["expenses"];

/** What cancelling a transaction does to each account it touched: the opposite of what it did. */
function balanceLines(ts: TxnRow[]): string[] {
  const by = new Map<string, number>();
  for (const t of ts) {
    if (t.from) by.set(t.from, (by.get(t.from) ?? 0) + t.amountPaise);
    if (t.to) by.set(t.to, (by.get(t.to) ?? 0) - t.amountPaise);
  }
  return [...by.entries()].filter(([, v]) => v !== 0).map(([a, v]) => `${a} ${v > 0 ? "+" : "−"}${inr(Math.abs(v))}`);
}

/* ============================================================ a transaction */

export const moneyTxnImpact: ImpactSource = {
  async authorize(id) {
    const [t] = await db.execute<{ by: string | null; review: string }>(sql`select created_by_id as by, review from erp_money_txns where id = ${id}`);
    await erpMayDelete(MONEY, (ctx) =>
      ctx.powers.has("approveMoney") || (t && t.by === ctx.actor.id && t.review !== "approved")
        ? null
        : "Only the accountant cancels this — or whoever entered it, before it is approved.",
    );
  },

  async report(id) {
    const [t] = await txnRows(sql`t.id = ${id}`);
    if (!t) return null;
    const blockers: string[] = [];
    if (t.status !== "active") blockers.push("Already cancelled.");
    else if (t.scrapReceiptId) blockers.push("A scrap buyer's receipt is voided on Scrap buyers.");
    else if (t.kind === "advance") blockers.push("Cancel the advance itself, on Advances.");
    else if (t.kind === "advance_return" || t.kind === "advance_topup") blockers.push("A settlement is undone by reopening the advance.");
    else if (t.matchedPaise > 0) blockers.push("It is matched to a bank line. Undo the match first.");
    else if (t.usedPaise > 0) blockers.push("Cash from it has been paid onward. Cancel those first.");
    else if (t.advanceId) {
      const [a] = await db.execute<{ status: string }>(sql`select status from erp_advances where id = ${t.advanceId}`);
      if (a?.status === "settled") blockers.push("The advance is settled. Reopen it first.");
    }

    const balances = balanceLines([t]);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `account ${many(balances.length, "balance")} in Petty Cash ${balances.length === 1 ? "changes" : "change"}`,
        effect: "changed",
        count: balances.length,
        examples: balances,
        note: "The transaction is kept, marked cancelled with your reason, and stops counting in every balance, statement and report.",
      },
    ];
    if (t.sourceTxnId && t.sourceLabel) {
      items.push({
        app: "ERP",
        label: `cash ${t.sourceLabel} gets ${inr(t.amountPaise)} back as not yet used`,
        effect: "changed",
        count: 1,
      });
    }
    if (t.advanceId && t.advanceLabel) {
      items.push({
        app: "ERP",
        label: `advance ${t.advanceLabel} — this bill stops counting against what ${t.advanceEmployee ?? "the employee"} spent`,
        effect: "changed",
        count: 1,
      });
    }
    if (t.review === "to_review" || t.review === "sent_back") {
      items.push({ app: "ERP", label: "entry leaves Needs approval", effect: "changed", count: 1 });
    }

    return {
      title: `${t.label} · ${t.kind} · ${inr(t.amountPaise)}`,
      verb: "Cancel",
      confirmWord: t.label,
      items: present(items),
      blockers,
    };
  },
};

/* ================================================================ an advance */

async function advanceHead(id: string) {
  const [a] = await db.execute<{ no: number; on: string; employee: string; status: string; by: string | null }>(sql`
    select advance_no as no, issued_on::text as on, employee_name as employee, status, created_by_id as by from erp_advances where id = ${id}`);
  return a ?? null;
}

export const advanceCancelImpact: ImpactSource = {
  async authorize(id) {
    const a = await advanceHead(id);
    await erpMayDelete(MONEY, (ctx) =>
      ctx.powers.has("approveMoney") || (a && a.by === ctx.actor.id) ? null : "Only the accountant, or whoever gave it, cancels an advance.",
    );
  },

  async report(id) {
    const a = await advanceHead(id);
    if (!a) return null;
    const label = advanceLabel(Number(a.no), a.on);
    const [mine, [m]] = await Promise.all([
      txnRows(sql`t.advance_id = ${id} and t.status = 'active'`),
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from erp_bank_matches m join erp_money_txns t on t.id = m.txn_id where t.advance_id = ${id} and m.voided_at is null`),
    ]);
    const blockers: string[] = [];
    if (a.status !== "open") blockers.push(`This advance is ${a.status}.`);
    else if (mine.some((t) => t.kind === "expense")) blockers.push("Bills have been put against it. Cancel them, or settle the advance.");
    else if (Number(m?.n) > 0) blockers.push("It is matched to a bank line. Undo the match first.");

    const balances = balanceLines(mine);
    return {
      title: `${label} · ${a.employee}`,
      verb: "Cancel advance",
      confirmWord: label,
      items: present([
        {
          app: "ERP",
          label: `${many(mine.length, "transaction")} on it cancelled`,
          effect: "changed",
          count: mine.length,
          examples: mine.slice(0, 5).map((t) => `${t.label} · ${inr(t.amountPaise)}`),
          note: balances.length ? `The money goes back: ${balances.join(", ")}.` : undefined,
        },
        {
          app: "ERP",
          label: `advance stops showing as money with ${a.employee}`,
          effect: "changed",
          count: a.status === "open" ? 1 : 0,
          note: "It stays on Advances, cancelled.",
        },
      ]),
      blockers,
    };
  },
};

export const advanceReopenImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(MONEY, (ctx) => (ctx.powers.has("approveMoney") ? null : "Only the accountant reopens an advance."));
  },

  async report(id) {
    const a = await advanceHead(id);
    if (!a) return null;
    const label = advanceLabel(Number(a.no), a.on);
    const settlements = await txnRows(sql`t.advance_id = ${id} and t.kind in ('advance_return', 'advance_topup') and t.status = 'active'`);
    const blockers: string[] = [];
    if (a.status !== "settled") blockers.push("Only a settled advance is reopened.");
    else if (settlements.some((t) => t.matchedPaise > 0)) blockers.push("The settlement is matched to a bank line. Undo the match first.");

    const balances = balanceLines(settlements);
    return {
      title: `${label} · ${a.employee}`,
      verb: "Reopen",
      confirmWord: label,
      items: present([
        {
          app: "ERP",
          label: `settlement ${many(settlements.length, "transaction")} cancelled`,
          effect: "changed",
          count: settlements.length,
          examples: settlements.slice(0, 5).map((t) => `${t.label} · ${t.kind === "advance_return" ? "returned" : "topped up"} ${inr(t.amountPaise)}`),
          note: balances.length ? `Balances move back: ${balances.join(", ")}.` : undefined,
        },
        {
          app: "ERP",
          label: `advance open again — bills can be put against it and it is settled afresh`,
          effect: "changed",
          count: a.status === "settled" ? 1 : 0,
        },
      ]),
      blockers,
    };
  },
};

/* ======================================================= a bank line's match */

export const bankMatchImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(MONEY, (ctx) => (ctx.powers.has("approveMoney") ? null : "Only the accountant matches bank lines."));
  },

  async report(id) {
    const [line] = await db.execute<{ date: string; description: string; account: string; amount: string }>(sql`
      select l.line_date::text as date, l.description, a.name as account, (l.debit_paise + l.credit_paise) as amount
        from erp_bank_lines l join erp_money_accounts a on a.id = l.account_id where l.id = ${id}`);
    if (!line) return null;
    const rows = await db.execute<{ txnNo: number | null; txnDate: string | null; other: string | null; amount: string }>(sql`
      select t.txn_no as "txnNo", t.txn_date::text as "txnDate",
             case when m.receipt_id is not null then 'Receipt ' || coalesce(r.receipt_no, 'R-' || upper(substr(r.id, 5, 4))) || ' · ' || coalesce(c.name, '')
                  when m.payout_id is not null then 'Payout to ' || p.payee_name end as other,
             m.amount_paise as amount
        from erp_bank_matches m
        left join erp_money_txns t on t.id = m.txn_id
        left join payment_receipts r on r.id = m.receipt_id
        left join customers c on c.id = r.customer_id
        left join vendor_payouts p on p.id = m.payout_id
       where m.line_id = ${id} and m.voided_at is null
       order by m.at`);
    const matches = rows.map((m) => ({
      kind: m.txnNo != null ? "txn" : "accounts",
      label: m.txnNo != null ? txnLabel(Number(m.txnNo), m.txnDate ?? "") : (m.other ?? "Accounts match"),
      amount: m.amount,
    }));
    const txns = matches.filter((m) => m.kind === "txn");
    const accounts = matches.filter((m) => m.kind !== "txn");
    const blockers = matches.length ? [] : ["Nothing is matched to this line."];
    const ex = (ms: typeof matches) => ms.slice(0, 5).map((m) => `${m.label} · ${inr(Number(m.amount))}`);

    return {
      title: `${line.account} · ${line.date} · ${inr(Number(line.amount))} · ${line.description}`,
      verb: "Undo match",
      confirmWord: "UNDO",
      items: present([
        {
          app: "ERP",
          label: `Petty Cash ${many(txns.length, "transaction")} no longer explained by the bank`,
          effect: "unlinked",
          count: txns.length,
          examples: ex(txns),
          note: "They come back on the unmatched lists, and can be cancelled or corrected again.",
        },
        {
          app: "Accounts",
          label: `${many(accounts.length, "match", "matches")} made in Accounts undone`,
          effect: "unlinked",
          count: accounts.length,
          examples: ex(accounts),
          note: "The match goes, but the receipt stays confirmed (or the payout paid) — Accounts' own Undo on Bank statement management is what reverses those.",
        },
        {
          app: "ERP",
          label: "bank line open again on the statement",
          effect: "changed",
          count: matches.length ? 1 : 0,
        },
      ]),
      blockers,
    };
  },
};
