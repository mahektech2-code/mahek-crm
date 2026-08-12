/**
 * Rebuild the payment ledger from Tally's Receipt Register.
 *
 *   npx tsx scripts/tally-receipts.ts --input=receipts.json --dry-run
 *   npx tsx scripts/tally-receipts.ts --input=receipts.json --customer="COLOUR CAMP"
 *   npx tsx scripts/tally-receipts.ts --input=receipts.json --apply
 *
 * WHY THIS EXISTS. Every bill in this database carries an assumed receipt
 * written by an earlier version of the sheet import: `source = 'sheet_import'`,
 * `received_at` = the bill's OWN `bill_date`, one bill each, nobody's name
 * against it. So the whole book reads as paid on the day it was billed, which
 * is true of no payment that has ever been made. Tally's Receipt Register says
 * what actually arrived, on what day, against which bills — and it is evidence
 * a person can be asked about, which a spreadsheet's silence is not.
 *
 * NOTHING IS DELETED. An assumed receipt is REVERSED, not removed: the row,
 * its amount and its bill link all stay, it shows on the customer's statement,
 * and every money path in the app keys on `confirmed`, so a reversed receipt
 * stops counting everywhere at once without anything being taught about it.
 * Deleting would destroy the only record of what the book used to claim, and
 * with it any way to check this migration after the fact.
 *
 * IT TOUCHES ONLY WHAT THE REGISTER NAMES. A bill no register mentions keeps
 * exactly the figures it has today. That rule is not caution for its own sake:
 * the `M/` series — 598 bills, Rs 1.4 crore across 17 customers — is billed in
 * a book these registers do not cover, and is named ZERO times in three years
 * of them. Treating "not named" as "not paid" would have invented Rs 1.4 crore
 * of debt against customers who owe nothing, and put every one of them on the
 * collections worklist. Silence is not evidence, in either direction.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  auditLog,
  bills,
  customers,
  paymentReceipts,
  payments,
} from "../src/db/schema";
import {
  recomputeBillPaid,
  recomputeFollowUpState,
  recomputeOutstanding,
} from "../src/lib/recompute";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function* batches<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

/** A receipt as Tally exported it. Produced by scripts/parse-receipt-register.py. */
type RegisterReceipt = {
  fy: string;
  date: string;
  party: string;
  vch: number | string;
  amount: number;
  bank: string | null;
  alloc: { kind: string; bill: string | null; amount: number }[];
};

type Landing = { billId: string; billNo: string; paise: number };

type PlannedReceipt = {
  customerId: string;
  customerName: string;
  fy: string;
  vch: string;
  date: string;
  bank: string | null;
  paise: number;
  landings: Landing[];
  /** Allocation lines that name a bill this database does not hold. */
  dropped: { ref: string; paise: number }[];
};

/* ----------------------------------------------------------------- parsing */

const rupeesToPaise = (n: number) => Math.round(n * 100);

/**
 * A bill number in the register, in any of the spellings Tally has produced.
 * `M/` is deliberately NOT matched loosely into `MMI/`: they are two different
 * series and conflating them would pay one book's bills with the other's money.
 */
const BILL_SHAPE = /^M{1,3}I?[/-]\d{2}[-/]\d{2}\/\d+/i;
const isBillRef = (s: string | null): s is string => !!s && BILL_SHAPE.test(s);

/* --------------------------------------------------------------- resolving */

type DbBill = {
  id: string;
  billNo: string;
  amount: number;
  billDate: string;
  customerId: string;
  customerName: string;
};

/**
 * One Tally bill number can be several rows here, and the reasons are all the
 * sheet import's: a contested number became `<tally>/<order>`, and a couple of
 * orders were billed under a fused `A & B` number. Both are resolved back to
 * the set of rows the number covers, because the register pays the Tally bill
 * and the rows beneath it are our own bookkeeping.
 */
function buildResolver(all: DbBill[]) {
  const exact = new Map<string, DbBill[]>();
  const byBase = new Map<string, DbBill[]>();
  const push = (m: Map<string, DbBill[]>, k: string, b: DbBill) => {
    const at = m.get(k);
    if (at) at.push(b);
    else m.set(k, [b]);
  };

  for (const b of all) {
    push(exact, b.billNo, b);
    // `MMI/25-26/3519/7122` — the Tally number plus the order that broke the tie.
    const parts = b.billNo.split("/");
    if (parts.length > 3) push(byBase, parts.slice(0, 3).join("/"), b);
    // `MMI/25-26/0990 & MMI/25-26/1007` — one row standing for two Tally bills.
    if (b.billNo.includes("&")) {
      for (const half of b.billNo.split("&")) push(byBase, half.trim(), b);
    }
  }

  return (ref: string): DbBill[] | null =>
    exact.get(ref) ?? byBase.get(ref) ?? null;
}

/**
 * Spread one Tally allocation across the rows that number covers, oldest bill
 * first, capped by what each row has LEFT to take.
 *
 * The capacity ledger is the whole point and it is shared across every receipt
 * in every year, which is why it is passed in rather than rebuilt per call. One
 * Tally bill is often settled by three or four payments over as many months —
 * 84 of the 96 split numbers here are — and an allocator that starts from the
 * oldest row each time fills that row again on every visit. That bug put Rs
 * 47.8 lakh onto 184 bills that had no room for it, drove 871 of one customer's
 * bills past their own value, and turned their outstanding NEGATIVE. Bills come
 * back from `paid` looking settled, so nothing downstream complains; the only
 * symptom is a balance nobody can explain.
 *
 * What will not fit anywhere goes on account. A bill cannot absorb more than it
 * is worth, and money that genuinely exceeds every bill it names is money the
 * customer is in credit for — which is a real thing that happens, and is a
 * truthful answer where "this bill was paid twice over" is not.
 */
function spread(
  paise: number,
  group: DbBill[],
  room: Map<string, number>,
): { landings: Landing[]; onAccount: number } {
  const ordered = [...group].sort((a, b) => a.billDate.localeCompare(b.billDate));
  const landings: Landing[] = [];
  let left = paise;
  for (const b of ordered) {
    if (left <= 0) break;
    const free = room.get(b.id) ?? b.amount;
    if (free <= 0) continue;
    const take = Math.min(left, free);
    landings.push({ billId: b.id, billNo: b.billNo, paise: take });
    room.set(b.id, free - take);
    left -= take;
  }
  return { landings, onAccount: left };
}

/* ------------------------------------------------------------------- plan */

type Plan = {
  byCustomer: Map<string, PlannedReceipt[]>;
  skipped: { reason: string; vch: string; fy: string; party: string; paise: number }[];
  /** Money that exceeded every bill it named, and became credit on the account. */
  creditedToAccount: number;
};

function buildPlan(
  register: RegisterReceipt[],
  all: DbBill[],
  customerByName: Map<string, { id: string; name: string }>,
): Plan {
  const resolve = buildResolver(all);
  const byCustomer = new Map<string, PlannedReceipt[]>();
  const skipped: Plan["skipped"] = [];
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

  // How much each bill can still take. Shared by every receipt of every year,
  // and consumed in the order the money actually arrived — so the earlier
  // payment fills the bill and the later one moves on to the next, which is
  // what happened in life.
  const room = new Map<string, number>(all.map((b) => [b.id, b.amount]));
  let creditedToAccount = 0;
  const inOrder = [...register].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(a.vch) - Number(b.vch),
  );

  for (const r of inOrder) {
    const vch = String(r.vch);
    const note = (reason: string) =>
      skipped.push({
        reason,
        vch,
        fy: r.fy,
        party: r.party,
        paise: rupeesToPaise(r.amount ?? 0),
      });

    // Salary, staff advances, sundry expenses, the directors' current accounts:
    // real receipts in Tally, nothing to do with a customer's ledger.
    if (!r.alloc.length) {
      note("no allocation — not a customer receipt");
      continue;
    }

    const landings: Landing[] = [];
    const dropped: PlannedReceipt["dropped"] = [];
    let onAccount = 0;
    // Whose money this is, learned from every bill the receipt names — including
    // the ones that turned out to have no room left. A receipt that overflows
    // entirely onto account still belongs to a known customer.
    const owners = new Set<string>();

    for (const a of r.alloc) {
      const paise = rupeesToPaise(a.amount ?? 0);
      if (a.kind === "On Account") {
        onAccount += paise;
        continue;
      }
      if (!isBillRef(a.bill)) {
        dropped.push({ ref: a.bill ?? "(blank)", paise });
        continue;
      }
      const group = resolve(a.bill);
      if (!group) {
        dropped.push({ ref: a.bill, paise });
        continue;
      }
      for (const b of group) owners.add(b.customerId);
      const placed = spread(paise, group, room);
      landings.push(...placed.landings);
      // Nothing left to bill it against: the customer is in credit by this much.
      onAccount += placed.onAccount;
      creditedToAccount += placed.onAccount;
    }

    if (owners.size > 1) {
      note("bills span more than one customer — needs a human");
      continue;
    }

    let customerId = [...owners][0] ?? "";
    let customerName = customerId
      ? all.find((b) => b.customerId === customerId)!.customerName
      : "";

    // Money with no bill named can only be placed by the party name.
    if (!customerId && onAccount > 0) {
      const hit = customerByName.get(norm(r.party));
      if (!hit) {
        note("on account, and the party name matches no customer");
        continue;
      }
      customerId = hit.id;
      customerName = hit.name;
    }

    if (!customerId) {
      note("nothing landed — every bill it names is absent");
      continue;
    }

    const paise = landings.reduce((s, l) => s + l.paise, 0) + onAccount;
    if (paise <= 0) {
      note("nothing landed");
      continue;
    }

    const planned: PlannedReceipt = {
      customerId,
      customerName,
      fy: r.fy,
      vch,
      date: r.date,
      bank: r.bank,
      paise,
      landings,
      dropped,
    };
    // An on-account remainder rides as a landing with no bill behind it.
    if (onAccount > 0) planned.landings.push({ billId: "", billNo: "", paise: onAccount });

    const at = byCustomer.get(customerId);
    if (at) at.push(planned);
    else byCustomer.set(customerId, [planned]);
  }

  return { byCustomer, skipped, creditedToAccount };
}

/* ------------------------------------------------------------------ apply */

/**
 * Nobody's name goes on these, and that is the honest record rather than a gap
 * in one. A receipt normally carries the person who says the money reached the
 * bank, because that is somebody you can go and ask. Here the assertion is
 * Tally's register — no member of staff sat and confirmed 7,258 receipts, and
 * writing one of their names against them would put a person behind a decision
 * they never made. `confirmed_by_id` and the audit actor are therefore NULL,
 * exactly as the receipts this replaces already were, and the provenance lives
 * where it can be read: `source = 'tally_receipts'`, and a note on every row
 * naming the register and the voucher it came from.
 */
const SYSTEM_ACTOR = "system:tally-records";

const REVERSAL_REASON =
  "Superseded by Tally's Receipt Register. This receipt was never a payment " +
  "somebody recorded — it was assumed by the sheet import, dated to the bill " +
  "date. The real receipt, on the day the money actually arrived, replaces it.";

async function applyCustomer(
  customerId: string,
  planned: PlannedReceipt[],
): Promise<{ reversed: number; created: number; lines: number }> {
  // Only the bills this register speaks for. A bill it never names keeps the
  // figures it has today, whatever they are.
  const touched = [
    ...new Set(planned.flatMap((p) => p.landings.map((l) => l.billId)).filter(Boolean)),
  ];

  const counts = { reversed: 0, created: 0, lines: 0 };

  await db.transaction(async (tx) => {
    // 1. Reverse the assumed receipts sitting on exactly those bills.
    const stale = touched.length
      ? await tx
          .selectDistinct({ id: paymentReceipts.id, amount: paymentReceipts.amount })
          .from(paymentReceipts)
          .innerJoin(payments, eq(payments.receiptId, paymentReceipts.id))
          .where(
            and(
              eq(paymentReceipts.source, "sheet_import"),
              eq(paymentReceipts.status, "confirmed"),
              inArray(payments.billId, touched),
            ),
          )
      : [];

    // Written in batches rather than a row at a time. A customer with a
    // thousand bills is a thousand round trips to a database in another
    // continent, and the whole book is ten thousand more — an hour of an open
    // transaction where there is no need for one.
    if (stale.length) {
      await tx
        .update(paymentReceipts)
        .set({
          status: "reversed",
          rejectReason: REVERSAL_REASON,
          updatedById: SYSTEM_ACTOR,
          updatedAt: new Date(),
        })
        .where(inArray(paymentReceipts.id, stale.map((s) => s.id)));
      for (const chunk of batches(stale, 500)) {
        await tx.insert(auditLog).values(
          chunk.map((s) => ({
            id: id("aud"),
            actorId: null,
            action: "payment.reverse",
            entityType: "payment_receipt",
            entityId: s.id,
            beforeState: { status: "confirmed" } as never,
            afterState: {
              status: "reversed",
              reason: REVERSAL_REASON,
              amount: Number(s.amount),
            } as never,
          })),
        );
      }
      counts.reversed = stale.length;
    }

    // 2. Write what Tally says arrived.
    const receiptRows = planned.map((p) => ({
      row: {
        id: id("rcp"),
        customerId,
        amount: p.paise,
        receivedAt: p.date,
        mode: p.bank ? "Bank transfer" : "Not stated",
        reference: `RCPT-${p.vch}${p.bank ? ` · ${p.bank}` : ""}`,
        note: `Tally Receipt Register ${p.fy}, voucher ${p.vch}`,
        status: "confirmed" as const,
        source: "tally_receipts",
        confirmedById: null,
        confirmedAt: new Date(),
        idempotencyKey: `TALLY-${p.fy}-${p.vch}`,
        createdById: SYSTEM_ACTOR,
      },
      planned: p,
    }));

    for (const chunk of batches(receiptRows, 500)) {
      await tx.insert(paymentReceipts).values(chunk.map((r) => r.row));
    }
    counts.created = receiptRows.length;

    const paymentRows = receiptRows.flatMap(({ row, planned: p }) =>
      p.landings.map((l) => ({
        id: id("pay"),
        receiptId: row.id,
        billId: l.billId || null,
        customerId,
        amount: l.paise,
        paidAt: p.date,
        mode: p.bank ? "Bank transfer" : "Not stated",
        reference: `RCPT-${p.vch}`,
        recordedById: null,
        createdById: SYSTEM_ACTOR,
      })),
    );
    for (const chunk of batches(paymentRows, 500)) {
      await tx.insert(payments).values(chunk);
    }
    counts.lines = paymentRows.length;

    // 3. A bill Tally names has been spoken for, whichever way it came out.
    if (touched.length) {
      await tx
        .update(bills)
        .set({ paymentPosition: "stated", paymentDecidedAt: new Date() })
        .where(inArray(bills.id, touched));
    }
  });

  // 4. Rebuild the caches for this customer only. Bill paid amounts derive from
  //    CONFIRMED receipts, so the reversals fall out of them on their own.
  await recomputeBillPaid(customerId);
  await db.execute(sql`
    update bills set status = case
      when paid_amount >= amount then 'paid'::bill_status
      when paid_amount > 0 then 'partially_paid'::bill_status
      else 'unpaid'::bill_status
    end, updated_at = now()
    where customer_id = ${customerId}
  `);
  await recomputeOutstanding(customerId);
  await recomputeFollowUpState(customerId);

  return counts;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const has = (name: string) => args.includes(`--${name}`);

  const input = flag("input");
  if (!input) throw new Error("--input=<receipts.json> is required");
  const apply = has("apply");
  const only = flag("customer");

  const register = JSON.parse(readFileSync(input, "utf8")) as RegisterReceipt[];

  const allRows = await db
    .select({
      id: bills.id,
      billNo: bills.billNo,
      amount: bills.amount,
      billDate: bills.billDate,
      customerId: bills.customerId,
      customerName: customers.name,
    })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId));
  const all = allRows.map((b) => ({ ...b, amount: Number(b.amount) }));

  const custRows = await db.select({ id: customers.id, name: customers.name }).from(customers);
  const customerByName = new Map<string, { id: string; name: string }>();
  for (const c of custRows) {
    const k = c.name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    if (!customerByName.has(k)) customerByName.set(k, c);
  }

  const plan = buildPlan(register, all, customerByName);

  // Anything already written is dropped from the plan, so this is re-runnable
  // and resumable. Each customer commits on its own, so a run that dies at
  // customer 300 has really done 299 — and without this the next attempt would
  // either throw on the unique idempotency key or, worse, write a second copy
  // of every receipt it had already made and double the customer's payments.
  const done = new Set(
    (
      await db
        .select({ key: paymentReceipts.idempotencyKey })
        .from(paymentReceipts)
        .where(eq(paymentReceipts.source, "tally_receipts"))
    ).map((r) => r.key),
  );
  if (done.size) {
    let dropped = 0;
    for (const [customerId, list] of plan.byCustomer) {
      const left = list.filter((p) => !done.has(`TALLY-${p.fy}-${p.vch}`));
      dropped += list.length - left.length;
      if (left.length) plan.byCustomer.set(customerId, left);
      else plan.byCustomer.delete(customerId);
    }
    console.log(`already written, skipping: ${dropped} receipts`);
  }

  const rupees = (p: number) => "Rs " + (p / 100).toLocaleString("en-IN");
  let receipts = 0;
  let money = 0;
  for (const list of plan.byCustomer.values()) {
    receipts += list.length;
    money += list.reduce((s, p) => s + p.paise, 0);
  }

  console.log("customers touched:", plan.byCustomer.size);
  console.log("receipts to write:", receipts, rupees(money));
  console.log("receipts skipped:", plan.skipped.length);
  console.log("credited on account (exceeded every bill named):", rupees(plan.creditedToAccount));
  const reasons: Record<string, number> = {};
  for (const s of plan.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  console.table(reasons);

  const targets = only
    ? [...plan.byCustomer.entries()].filter(([, v]) => v[0].customerName === only)
    : [...plan.byCustomer.entries()];
  if (only && !targets.length) throw new Error(`no planned receipts for "${only}"`);

  if (!apply) {
    console.log("\n--- DRY RUN, nothing written ---");
    for (const [, list] of targets.slice(0, only ? 1 : 3)) {
      console.log(`\n${list[0].customerName}: ${list.length} receipts`);
      for (const p of list.slice(0, 12)) {
        console.log(
          `  ${p.date}  vch ${p.vch}  ${rupees(p.paise)}  ->`,
          p.landings.map((l) => `${l.billNo || "on account"} ${rupees(l.paise)}`).join(", "),
        );
      }
      if (list.length > 12) console.log(`  … and ${list.length - 12} more`);
    }
    return;
  }

  let n = 0;
  const totals = { reversed: 0, created: 0, lines: 0 };
  for (const [customerId, list] of targets) {
    const c = await applyCustomer(customerId, list);
    totals.reversed += c.reversed;
    totals.created += c.created;
    totals.lines += c.lines;
    n += 1;
    if (n % 25 === 0) console.log(`  … ${n}/${targets.length} customers`);
  }
  console.log("done:", n, "customers |", totals);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
