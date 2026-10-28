import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bankStatementUploads, vendorPayoutInvoices, vendorPayouts } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireCapability, resolveScope } from "@/lib/access-control";
import type { Capability } from "@/lib/capability-matrix";
import { longDate, money } from "@/lib/format";
import { BANK_MODULES } from "@/lib/services/bank-statement-service";
import type { ImpactBody, ImpactSource } from "../registry";
import type { ImpactItem } from "../types";
import { many, present, word } from "./crm-common";
import { impactPairOf } from "./crm-keys";

/* ---------------------------------------------------------------------------
 * MONEY TAKEN BACK, said before it happens.
 *
 * Reversing a payment is the act in this file that reaches furthest: the
 * bills it settled are owed again, the customer's outstanding rises, and the
 * collections worklist and follow-up stage are worked out afresh from the
 * bills — while the receipt itself stays on the statement, struck through,
 * because a payment that counted and then failed is a fact about the account.
 * The bank-statement and vendor-payout sources beside it are smaller: what a
 * discarded upload loses, what an undone match leaves standing, what a
 * cancelled or reopened payable takes off the payment calendar.
 *
 * Each asks the screen's own module and the capability the service asks, so
 * the modal names no customer or amount the person could not otherwise open.
 * ------------------------------------------------------------------------- */

const refuse = (message: string) => Object.assign(new Error(message), { name: "NotPermittedError" });

/** The words each desk refuses in — the services' own, so the modal and the act say one thing. */
const DESK_WORDS = {
  bank: {
    closed: "Bank statement management is not on your account.",
    "payment.confirm": "Matching a bank line confirms or records money — that is the Accounts manager's.",
    "payment.record": "You cannot work bank statements.",
  },
  payouts: {
    closed: "Cash flow is not on your account.",
    "payment.confirm": "Marking a payout paid, undoing it and cancelling one are the Accounts manager's.",
    "payment.record": "You cannot change vendor payouts.",
  },
} as const;

/**
 * The screen first, then the capability — the order every Accounts desk asks
 * in. Answers the refusal in the service's own words, or null. Exported so an
 * action can ask it BEFORE `confirmImpact`, the way the act's own check comes
 * before anything else.
 */
export async function accountsDeskRefusal(
  desk: keyof typeof DESK_WORDS,
  modules: readonly string[],
  capability: "payment.confirm" | "payment.record",
): Promise<string | null> {
  const ctx = await resolveScope();
  let open = false;
  for (const m of modules) if (await canOpenModule(ctx.user.id, m)) open = true;
  if (!open) return DESK_WORDS[desk].closed;
  try {
    await requireCapability(capability as Capability);
  } catch {
    return DESK_WORDS[desk][capability];
  }
  return null;
}

async function deskWith(desk: keyof typeof DESK_WORDS, modules: readonly string[], capability: "payment.confirm" | "payment.record") {
  const refusal = await accountsDeskRefusal(desk, modules, capability);
  if (refusal) throw refuse(refusal);
}

/** The screens each desk opens on. */
export const BANK_HOME = [BANK_MODULES.home, BANK_MODULES.reconcile, BANK_MODULES.uploads];
export const BANK_RECONCILE = [BANK_MODULES.reconcile];
export const CASH_FLOW = ["accounts.cash-flow"];

/* ============================================== a confirmed payment reversed */

type ReceiptFacts = { customer: string; amount: number; status: string; receivedAt: string; mode: string };

/** The same refusals, in the same words, as `reverseReceipt`. */
function receiptBlockers(status: string): string[] {
  if (status === "reversed") return ["That payment has already been reversed."];
  if (status === "rejected") return ["That payment was already rejected — it never counted."];
  if (status !== "confirmed") return ["Only a confirmed payment can be reversed. Reject it instead — it has not counted yet."];
  return [];
}

/**
 * What giving a receipt's money back does. `applyToLedger` REBUILDS each
 * bill's paid figure from the confirmed receipts left, so the bills this one
 * settled are owed again by exactly what it put on them, and outstanding is
 * summed afresh from the stated bills.
 */
async function reversal(receiptId: string): Promise<{ facts: ReceiptFacts; items: ImpactItem[] } | null> {
  const [r] = await db.execute<{ customerId: string; customer: string; amount: string; status: string; receivedAt: string; mode: string; outstanding: string }>(sql`
    select r.customer_id as "customerId", c.name as customer, r.amount, r.status::text as status,
           r.received_at::text as "receivedAt", r.mode, c.outstanding
      from payment_receipts r join customers c on c.id = r.customer_id
     where r.id = ${receiptId}`);
  if (!r) return null;
  const [lines, matched] = await Promise.all([
    db.execute<{ billNo: string | null; onBill: string }>(sql`
      select b.bill_no as "billNo", sum(p.amount) as "onBill"
        from payments p left join bills b on b.id = p.bill_id
       where p.receipt_id = ${receiptId}
       group by b.id, b.bill_no, b.bill_date
       order by b.bill_date nulls last`),
    db.execute<{ line: string }>(sql`
      select a.name || ' · ' || l.line_date::text as line
        from erp_bank_matches m
        join erp_bank_lines l on l.id = m.line_id
        join erp_money_accounts a on a.id = l.account_id
       where m.receipt_id = ${receiptId} and m.voided_at is null`),
  ]);
  const onBills = lines.filter((l) => l.billNo !== null);
  const onAccount = lines.filter((l) => l.billNo === null).reduce((s, l) => s + Number(l.onBill), 0);
  const back = onBills.reduce((s, l) => s + Number(l.onBill), 0);
  const owed = Number(r.outstanding);
  const facts = { customer: r.customer, amount: Number(r.amount), status: r.status, receivedAt: r.receivedAt, mode: r.mode };
  if (r.status !== "confirmed") return { facts, items: [] };

  return {
    facts,
    items: present([
      {
        app: "Accounts",
        label: `${many(onBills.length, "bill")} this payment settled`,
        effect: "changed",
        count: onBills.length,
        examples: onBills.slice(0, 5).map((l) => `${l.billNo} · ${money(Number(l.onBill))} owed again`),
        note: "Each is owed again by what this payment put on it.",
      },
      {
        app: "Accounts",
        label: "money held on account",
        effect: "changed",
        count: onAccount > 0 ? 1 : 0,
        note: `${money(onAccount)} of credit on account goes.`,
      },
      {
        app: "Accounts",
        label: `${r.customer}'s outstanding`,
        effect: "changed",
        count: back > 0 ? 1 : 0,
        note: `About ${money(owed)} → ${money(owed + back)}. The aging, the slow-payer flag, the collections worklist and the follow-up stage are worked out again from the bills, so the customer may come back on the telecallers' list.`,
      },
      {
        app: "Accounts",
        label: matched.length === 1 ? "bank line matched to it" : "bank lines matched to it",
        effect: "kept",
        count: matched.length,
        examples: matched.slice(0, 5).map((m) => m.line),
        note: "The match stays — undo it on Reconcile if the line was wrong too.",
      },
      {
        app: "Accounts",
        label: "receipt on the customer's statement",
        effect: "kept",
        count: 1,
        note: "It keeps its row, marked Reversed with your reason.",
      },
    ]),
  };
}

export const receiptReverseImpact: ImpactSource = {
  /* `payment.confirm` — the ledger desk sees every book, so there is no customer scope to narrow by. */
  authorize: async () => {
    await requireCapability("payment.confirm");
  },

  async report(id): Promise<ImpactBody | null> {
    const found = await reversal(id);
    if (!found) return null;
    const { facts } = found;
    return {
      title: `${money(facts.amount)} from ${facts.customer}, ${longDate(facts.receivedAt)}`,
      verb: "Reverse",
      confirmWord: "REVERSE",
      items: found.items,
      blockers: receiptBlockers(facts.status),
    };
  },
};

/* ======================================== a returned cheque, from the bank */

/** The line's own refusals, in `openLine`'s words. */
async function lineBlockers(lineId: string): Promise<{ label: string; blockers: string[] } | null> {
  const [l] = await db.execute<{ status: string; matched: string; account: string; date: string; description: string }>(sql`
    select l.status, a.name as account, l.line_date::text as date, l.description,
           coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.line_id = l.id and m.voided_at is null), 0) as matched
      from erp_bank_lines l join erp_money_accounts a on a.id = l.account_id
     where l.id = ${lineId}`);
  if (!l) return null;
  const blockers =
    l.status === "ignored"
      ? ["This line is set aside. Bring it back first."]
      : Number(l.matched) > 0
        ? ["This line is already matched."]
        : [];
  return { label: `${l.account} · ${longDate(l.date)} · ${l.description}`, blockers };
}

/** The id is `impactPair(lineId, receiptId)`. */
export const bankReturnImpact: ImpactSource = {
  authorize: async () => {
    await deskWith("bank", BANK_RECONCILE, "payment.confirm");
  },

  async report(key): Promise<ImpactBody | null> {
    const [lineId, receiptId] = impactPairOf(key);
    const [line, found] = await Promise.all([lineBlockers(lineId), reversal(receiptId)]);
    if (!line || !found) return null;
    const { facts } = found;
    return {
      title: `${money(facts.amount)} from ${facts.customer}, returned`,
      verb: "Reverse",
      confirmWord: "REVERSE",
      items: present([
        ...found.items,
        {
          app: "Accounts",
          label: "bank line showing the return",
          effect: "changed",
          count: 1,
          examples: [line.label],
          note: "Set aside as a returned cheque, explained by this reversal.",
        },
      ]),
      blockers: [...line.blockers, ...receiptBlockers(facts.status)],
    };
  },
};

/* ================================================ a match on a line undone */

export const bankUnmatchImpact: ImpactSource = {
  authorize: async () => {
    await deskWith("bank", BANK_RECONCILE, "payment.confirm");
  },

  async report(lineId): Promise<ImpactBody | null> {
    const [line] = await db.execute<{ account: string; date: string; description: string }>(sql`
      select a.name as account, l.line_date::text as date, l.description
        from erp_bank_lines l join erp_money_accounts a on a.id = l.account_id where l.id = ${lineId}`);
    if (!line) return null;
    const matches = await db.execute<{ receipt: string | null; payout: string | null; txn: number | null; amount: string }>(sql`
      select case when m.receipt_id is not null then c.name || ' · receipt' end as receipt,
             case when m.payout_id is not null then 'Payout to ' || p.payee_name end as payout,
             t.txn_no as txn, m.amount_paise as amount
        from erp_bank_matches m
        left join payment_receipts r on r.id = m.receipt_id
        left join customers c on c.id = r.customer_id
        left join vendor_payouts p on p.id = m.payout_id
        left join erp_money_txns t on t.id = m.txn_id
       where m.line_id = ${lineId} and m.voided_at is null
       order by m.at`);
    const said = (m: (typeof matches)[number]) => `${m.receipt ?? m.payout ?? (m.txn != null ? `Petty Cash entry ${m.txn}` : "A match")} · ${money(Number(m.amount))}`;
    const receipts = matches.filter((m) => m.receipt).length;
    const payouts = matches.filter((m) => m.payout).length;
    const txns = matches.length - receipts - payouts;
    return {
      title: `${line.account} · ${longDate(line.date)}`,
      verb: "Undo match",
      confirmWord: "UNDO",
      items: present([
        {
          app: "Accounts",
          label: matches.length === 1 ? "match on this line" : "matches on this line",
          effect: "unlinked",
          count: matches.length,
          examples: matches.slice(0, 5).map(said),
          note: "The line goes back to To do.",
        },
        { app: "Accounts", label: `${many(receipts, "receipt")} it confirmed`, effect: "kept", count: receipts, note: "Still confirmed money — reverse it on the customer's account if it was wrong." },
        { app: "Accounts", label: `${many(payouts, "payout")} it marked paid`, effect: "kept", count: payouts, note: "Still marked paid — reopen it on Cash flow if it was wrong." },
        { app: "ERP", label: `Petty Cash ${many(txns, "entry", "entries")}`, effect: "kept", count: txns, note: "They stay — cancel one in Petty Cash if it was wrong." },
      ]),
      blockers: matches.length ? [] : ["Nothing is matched to this line."],
    };
  },
};

/* =========================================== an upload discarded before import */

export const bankUploadDiscardImpact: ImpactSource = {
  authorize: async () => {
    await deskWith("bank", BANK_HOME, "payment.record");
  },

  async report(id): Promise<ImpactBody | null> {
    const [u] = await db
      .select({ fileName: bankStatementUploads.fileName, status: bankStatementUploads.status, fileRef: bankStatementUploads.fileRef, read: bankStatementUploads.linesRead })
      .from(bankStatementUploads)
      .where(eq(bankStatementUploads.id, id));
    if (!u) return null;
    return {
      title: u.fileName,
      verb: "Discard",
      confirmWord: "DISCARD",
      items: present([
        { app: "Accounts", label: "statement PDF", effect: "deleted", count: u.fileRef ? 1 : 0, note: "Deleted from storage now rather than at the end of its days." },
        {
          app: "Accounts",
          label: `${many(u.read, "line")} read from it`,
          effect: "deleted",
          count: u.status === "imported" ? 0 : Number(u.read),
          note: "Never imported, so they never reach Reconcile. Upload the PDF again to read them afresh.",
        },
      ]),
      blockers: u.status === "imported" ? ["An imported upload stays. Set its lines aside on Reconcile instead."] : [],
    };
  },
};

/* ===================================================== vendor payouts */

async function payout(id: string) {
  const [p] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, id));
  return p ?? null;
}

async function invoicesOf(payoutId: string) {
  return db.execute<{ kind: string; no: string | null; file: boolean }>(sql`
    select kind, invoice_no as no, attachment_id is not null as file
      from vendor_payout_invoices where payout_id = ${payoutId} order by created_at`);
}

export const payoutCancelImpact: ImpactSource = {
  authorize: async () => {
    await deskWith("payouts", CASH_FLOW, "payment.confirm");
  },

  async report(id): Promise<ImpactBody | null> {
    const p = await payout(id);
    if (!p) return null;
    const blockers =
      p.source !== "manual"
        ? ["A purchase payout follows the purchase register — correct or delete the purchase in the ERP instead."]
        : p.status === "paid" || p.status === "cancelled"
          ? ["Only a payout still to pay can be cancelled."]
          : [];
    const invoices = await invoicesOf(id);
    return {
      title: `${money(Number(p.amountPaise))} to ${p.payeeName}`,
      verb: "Cancel payable",
      confirmWord: word(p.payeeName, "cancel"),
      items: present([
        {
          app: "Accounts",
          label: "payable on the payment calendar",
          effect: "changed",
          count: blockers.length ? 0 : 1,
          note: `It leaves ${longDate(String(p.payOn))} and stops counting as owed. It stays listed as Cancelled, with your reason.`,
        },
        {
          app: "Accounts",
          label: `${many(invoices.length, "invoice")} attached`,
          effect: "kept",
          count: invoices.length,
          examples: invoices.slice(0, 5).map((i) => (i.no ? `${i.kind} ${i.no}` : i.kind)),
        },
      ]),
      blockers,
    };
  },
};

export const payoutReopenImpact: ImpactSource = {
  authorize: async () => {
    await deskWith("payouts", CASH_FLOW, "payment.confirm");
  },

  async report(id): Promise<ImpactBody | null> {
    const p = await payout(id);
    if (!p) return null;
    const matched = await db.execute<{ line: string }>(sql`
      select a.name || ' · ' || l.line_date::text as line
        from erp_bank_matches m
        join erp_bank_lines l on l.id = m.line_id
        join erp_money_accounts a on a.id = l.account_id
       where m.payout_id = ${id} and m.voided_at is null`);
    const paid = p.status === "paid";
    const how = [p.paidOn ? longDate(String(p.paidOn)) : null, p.paidAmountPaise != null ? money(Number(p.paidAmountPaise)) : null, p.paymentMode, p.paymentReference]
      .filter(Boolean)
      .join(" · ");
    return {
      title: `${money(Number(p.amountPaise))} to ${p.payeeName}`,
      verb: "Reopen",
      confirmWord: word(p.payeeName, "reopen"),
      items: present([
        {
          app: "Accounts",
          label: "payment recorded against it",
          effect: "deleted",
          count: paid ? 1 : 0,
          examples: how ? [how] : undefined,
          note: "The date, amount, mode and reference are cleared; the audit log keeps them.",
        },
        {
          app: "Accounts",
          label: "payable back on the payment calendar",
          effect: "changed",
          count: paid ? 1 : 0,
          note: "Owed again, on its planned day or the next payment day if that has passed.",
        },
        {
          app: "Accounts",
          label: matched.length === 1 ? "bank line matched to the payment" : "bank lines matched to the payment",
          effect: "kept",
          count: matched.length,
          examples: matched.slice(0, 5).map((m) => m.line),
          note: "Still matched to this payout — undo the match on Reconcile if the money did not go.",
        },
      ]),
      blockers: paid ? [] : ["Only a paid payout can be reopened."],
    };
  },
};

export const payoutInvoiceImpact: ImpactSource = {
  authorize: async () => {
    await deskWith("payouts", CASH_FLOW, "payment.record");
  },

  async report(id): Promise<ImpactBody | null> {
    const [inv] = await db
      .select({
        kind: vendorPayoutInvoices.kind,
        no: vendorPayoutInvoices.invoiceNo,
        amount: vendorPayoutInvoices.amountPaise,
        attachmentId: vendorPayoutInvoices.attachmentId,
        payee: vendorPayouts.payeeName,
      })
      .from(vendorPayoutInvoices)
      .innerJoin(vendorPayouts, eq(vendorPayouts.id, vendorPayoutInvoices.payoutId))
      .where(eq(vendorPayoutInvoices.id, id));
    if (!inv) return null;
    const name = inv.no ? `${inv.kind} ${inv.no}` : inv.kind;
    return {
      title: `${name} on ${inv.payee}'s payable`,
      verb: "Remove",
      confirmWord: word(inv.no ?? inv.kind, "remove"),
      items: present([
        { app: "Accounts", label: "attached file", effect: "deleted", count: inv.attachmentId ? 1 : 0, note: "Taken off the payout; the file goes when its retention runs out." },
        {
          app: "Accounts",
          label: "payable itself",
          effect: "kept",
          count: 1,
          note: inv.amount != null ? `Its amount does not change — the invoices' total just stops including ${money(Number(inv.amount))}.` : "Its amount does not change.",
        },
      ]),
      blockers: [],
    };
  },
};
