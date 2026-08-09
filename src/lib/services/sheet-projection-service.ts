import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  customers,
  orders,
  paymentReceipts,
  payments,
  sheetOrderRows,
  sheetPaymentRows,
  sheetSyncRuns,
  type OrderLine,
} from "@/db/schema";
import { isReceived } from "@/lib/sheet-parse";
import {
  recomputeAllBillPaid,
  recomputeAllBuyingCycles,
  recomputeAllFollowUpStates,
  recomputeAllOutstanding,
  recomputeBillStatuses,
  recomputeSlowPayers,
} from "@/lib/recompute";

/* ---------------------------------------------------------------------------
 * Sheet rows → the CRM's own tables.
 *
 * The landing table is a faithful copy of somebody else's spreadsheet. This is
 * where it becomes customers and orders that the queue, the record and the
 * engines can read — and it is a SEPARATE pass on purpose, so that importing
 * and believing are two decisions rather than one.
 *
 * Three rules it will not bend:
 *
 *   IDEMPOTENT. Keyed on the party code and the order number, so running it
 *   twice changes nothing the second time. The sheet gets corrected and
 *   re-synced; this has to be re-runnable on top of that forever.
 *
 *   NOTHING IS INVENTED. A customer with no phone number in the source gets no
 *   phone number here. The temptation is a placeholder so the column looks
 *   full — and then somebody dials it. A blank is a fact; a filler is a lie
 *   that survives into a call.
 *
 *   BILLS ARE OPTIONAL AND OFF. The sheet records what was billed and never
 *   what was paid, so bills projected from it are unpaid by construction. That
 *   is not "everyone owes us everything", it is "we do not know" — and the
 *   collections screens cannot tell those apart. So bills are written only
 *   when explicitly asked for, and the default is not to.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Rows per statement.
 *
 * The projection used to write a row at a time, which is invisible on a local
 * Postgres and ruinous on a hosted one: eleven thousand round trips took a
 * minute and a half against Neon, a third of the route's ceiling, and would
 * have started timing out mid-write as the sheet grew. Writing in chunks turns
 * the network cost from per-row into per-chunk.
 *
 * 500 leaves room under Postgres's 65,535 bind parameters for rows this wide.
 */
const WRITE_CHUNK = 500;

function chunked<T>(rows: T[], size = WRITE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** An order date, placed inside its own business day in IST.
 *
 *  Never a bare date cast: Postgres reads a timestamptz in the session zone,
 *  Neon runs in GMT, and midnight IST lands on the previous day there. Ten in
 *  the morning is comfortably inside the working day in any of them. */
const istNoon = (date: string) => new Date(`${date}T10:00:00+05:30`);

/**
 * The stable identity of an imported customer.
 *
 * Prefixed so it can never collide with a code from a real ERP later, and
 * derived from the name because that is what this document identifies a
 * customer by. Whitespace and case are folded so a stray double space in the
 * spreadsheet does not create a second customer on the next sync.
 */
const partyKey = (name: string) =>
  `SHEET:${name.trim().replace(/\s+/g, " ").toUpperCase()}`;

export type ProjectionReport = {
  customers: {
    created: number;
    updated: number;
    withoutPhone: number;
    /** Created in nobody's book, so visible on no list. */
    unassigned: number;
  };
  orders: { created: number; updated: number; lines: number };
  bills: {
    created: number;
    updated: number;
    /** Written only where a received date exists. */
    payments: number;
    /** Marked Received with no date: the bill is settled, the date unknown. */
    paidWithoutDate: number;
    /** No status at all — read as unpaid, which is a choice worth counting. */
    blankStatus: number;
    skipped: boolean;
  };
  skipped: { reason: string; count: number }[];
};

export type ProjectionOptions = {
  /**
   * Write bills too. Off by default — see the note above. Turn it on only
   * when the source carries payments, or every customer reads as maximally
   * overdue and the follow-up list stops meaning anything.
   */
  includeBills?: boolean;
  /** Report what would change without writing. */
  dryRun?: boolean;
  /**
   * Who the imported customers answer to.
   *
   * This is NOT in the source. The sheet's only ownership column is Sales Man,
   * and it holds sales channels ("Company Own", "Indiamart") rather than
   * people, so nothing in the file says who works these accounts.
   *
   * It matters more than it looks: a customer with no owner and no sales AM
   * sits in nobody's scope, so it appears on no list for anybody — not the
   * team view, not a telecaller's. Left unset, the import succeeds and every
   * screen stays empty, which reads as a broken import rather than an
   * unassigned book.
   *
   * Set only on CREATE. Reassigning accounts is somebody's decision and a
   * re-import must not undo it.
   */
  assignToUserId?: string | null;
  /**
   * Also move customers that already exist to `assignToUserId`.
   *
   * Ownership is written on create, so an import that guessed wrong once used
   * to be uncorrectable without hand-written SQL — and a customer in nobody's
   * book appears on no list for anybody, which is exactly the mistake somebody
   * makes on a first run. This is the way back.
   *
   * Off by default: a routine re-sync must not quietly rearrange who works
   * which accounts.
   */
  reassign?: boolean;
};

/* ------------------------------------------------------------- customers */

type PartyRow = {
  partyCode: string | null;
  name: string;
  area: string | null;
  creditDays: number | null;
  segment: string | null;
  firstOrder: string | null;
};

/**
 * The distinct billing parties.
 *
 * The BILLING PARTY NAME is the key, not the Order Party Code. A code would be
 * the better key in principle — codes survive spelling changes, names do not —
 * but this document does not support it: the code is filled on 16% of rows,
 * 270 of the 557 parties never carry one at all, and where it is present it is
 * no longer one-to-one (7 codes name several parties, 20 parties carry several
 * codes). A key that is absent 84% of the time and ambiguous where it appears
 * is not a key.
 *
 * The name holds up: all 557 are already distinct under trimming, case folding
 * and punctuation stripping alike, so there are no variants to merge and no
 * fuzzy matching to get wrong.
 *
 * Area, credit days and segment are order-level in the sheet and repeat down
 * every line, so the most recent order's value is taken as the customer's.
 */
async function distinctParties(): Promise<PartyRow[]> {
  const rows = await db.execute<{
    party_code: string | null;
    name: string;
    area: string | null;
    credit_days: number | null;
    segment: string | null;
    first_order: string | null;
  }>(sql`
    select distinct on (r.billing_party_name)
      r.billing_party_name              as name,
      r.area                            as area,
      r.credit_days                     as credit_days,
      r.segment_counter_type            as segment,
      min(r.order_date) over (partition by r.billing_party_name) as first_order,
      -- Kept for reference only. Never the join key: see the note above.
      max(nullif(r.raw ->> 'Order Party Code', ''))
        over (partition by r.billing_party_name) as party_code
    from sheet_order_rows r
    where r.status = 'present'
      and r.billing_party_name is not null
    order by r.billing_party_name, r.order_date desc nulls last
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    partyCode: (r.party_code as string) ?? null,
    name: r.name as string,
    area: (r.area as string) ?? null,
    creditDays: r.credit_days === null ? null : Number(r.credit_days),
    segment: (r.segment as string) ?? null,
    firstOrder: (r.first_order as string) ?? null,
  }));
}

export async function projectCustomers(
  options: ProjectionOptions = {},
): Promise<ProjectionReport["customers"]> {
  const parties = await distinctParties();
  const codes = parties.map((p) => partyKey(p.name));

  const existing = codes.length
    ? await db
        .select({
          id: customers.id,
          externalCode: customers.externalCode,
          phone: customers.phone,
        })
        .from(customers)
        .where(inArray(customers.externalCode, codes))
    : [];
  const byCode = new Map(existing.map((c) => [c.externalCode!, c]));

  let created = 0;
  let updated = 0;
  let withoutPhone = 0;
  let unassigned = 0;

  const toInsert: (typeof customers.$inferInsert)[] = [];
  const toUpdate: { id: string; values: Partial<typeof customers.$inferInsert> }[] = [];

  for (const party of parties) {
    const known = byCode.get(partyKey(party.name));

    // This source carries no phone number at all. A new record therefore gets
    // none, and an existing one keeps whatever a person has since typed. The
    // count is what is actually blank afterwards, so it is a known quantity
    // rather than a surprise on a telecaller's screen.
    if (!known || !known.phone.trim()) withoutPhone++;

    if (!known && !options.assignToUserId) unassigned++;

    if (known) {
      // Only the fields the sheet actually owns. Anything a person has since
      // typed into the CRM — a phone number, a contact name — is theirs, and a
      // re-run must not wipe it back to the blank the sheet has.
      //
      // Ownership is the exception, and only when it is asked for: reassigning
      // a book is an operator's decision that the first import should not be
      // able to lock in forever.
      toUpdate.push({
        id: known.id,
        values: {
          name: party.name,
          city: party.area ?? "",
          creditTermDays: party.creditDays ?? 30,
          creditDays: party.creditDays,
          ...(options.reassign && options.assignToUserId
            ? { ownerId: options.assignToUserId, salesAmId: options.assignToUserId }
            : {}),
          updatedAt: new Date(),
        },
      });
      updated++;
    } else {
      toInsert.push({
        id: newId("cus"),
        externalCode: partyKey(party.name),
        name: party.name,
        // Not known from this source. Empty is the honest value.
        contactPerson: "",
        phone: "",
        city: party.area ?? "",
        kind: "customer",
        status: "active",
        leadSource: party.segment,
        creditTermDays: party.creditDays ?? 30,
        creditDays: party.creditDays,
        customerSince: party.firstOrder,
        // NOT activeInOrderSystem. That flag means there is live activity in
        // the external order system, and the calling queue holds such a
        // customer back — `queue.excludeActiveInOrderSystem` is on by default.
        // Setting it from an import of order HISTORY mutes the entire book at
        // once: every customer imported, every customer suppressed, and a Call
        // Log that is empty for a reason nothing on the screen can show.
        // Both, deliberately: ownerId records who found the account and
        // salesAmId is what scope actually reads for a customer.
        ownerId: options.assignToUserId ?? null,
        salesAmId: options.assignToUserId ?? null,
      });
      created++;
    }
  }

  if (!options.dryRun) {
    for (const batch of chunked(toInsert)) {
      await db.insert(customers).values(batch);
    }
    for (const batch of chunked(toUpdate, 100)) {
      await Promise.all(
        batch.map((u) =>
          db.update(customers).set(u.values).where(eq(customers.id, u.id)),
        ),
      );
    }
  }

  return { created, updated, withoutPhone, unassigned };
}

/* ---------------------------------------------------------------- orders */

export async function projectOrders(
  options: ProjectionOptions = {},
): Promise<{ orders: ProjectionReport["orders"]; skipped: ProjectionReport["skipped"] }> {
  const lines = await db
    .select()
    .from(sheetOrderRows)
    .where(
      and(
        eq(sheetOrderRows.status, "present"),
        sql`${sheetOrderRows.orderNumber} is not null`,
      ),
    )
    .orderBy(sheetOrderRows.orderNumber, sheetOrderRows.rowNumber);

  // Group into orders. The sheet is flat: an order of seven products is seven
  // rows carrying the same order-level values, so the order is the group and
  // its value is the SUM of the group — never one row's Final Amount.
  const grouped = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = line.orderNumber!;
    const list = grouped.get(key) ?? [];
    list.push(line);
    grouped.set(key, list);
  }

  const codes = [
    ...new Set(
      lines.map((l) => (l.billingPartyName ? partyKey(l.billingPartyName) : null)),
    ),
  ].filter(Boolean) as string[];
  const known = codes.length
    ? await db
        .select({ id: customers.id, externalCode: customers.externalCode })
        .from(customers)
        .where(inArray(customers.externalCode, codes))
    : [];
  const customerByCode = new Map(known.map((c) => [c.externalCode!, c.id]));

  const refs = [...grouped.keys()].map((n) => `SHEET-${n}`);
  const existing = refs.length
    ? await db
        .select({ id: orders.id, externalRef: orders.externalRef })
        .from(orders)
        .where(inArray(orders.externalRef, refs))
    : [];
  const orderByRef = new Map(existing.map((o) => [o.externalRef!, o.id]));

  let created = 0;
  let updated = 0;
  let lineCount = 0;
  const pending: (typeof orders.$inferInsert)[] = [];
  const skipReasons = new Map<string, number>();
  const skip = (reason: string) =>
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);

  for (const [orderNumber, group] of grouped) {
    const head = group[0];
    const customerId = head.billingPartyName
      ? customerByCode.get(partyKey(head.billingPartyName))
      : undefined;

    if (!customerId) {
      skip("no matching customer for the billing party");
      continue;
    }
    if (!head.orderDate) {
      skip("no readable order date");
      continue;
    }

    // The order's value: the sum of its lines, GST and discount included, which
    // is what Final Amount is per line.
    const total = group.reduce((sum, l) => sum + (l.finalAmountPaise ?? 0), 0);

    const lineItems: OrderLine[] = group.map((l) => ({
      // The sheet's own words. Matching these to catalogue SKUs is a separate
      // decision — four of these names match nothing and five are ambiguous —
      // so the name is carried as written rather than resolved to a guess.
      product: l.description ?? "(not named)",
      quantity: l.cans ?? 0,
      unitPrice: l.ratePaise ?? 0,
      amount: l.finalAmountPaise ?? 0,
    }));
    lineCount += lineItems.length;

    const externalRef = `SHEET-${orderNumber}`;
    const values = {
      customerId,
      source: "external" as const,
      externalRef,
      // Dispatched, because the sheet says so on every row and it is a
      // purchase status: these are sales that already happened, not orders
      // waiting on somebody's approval.
      status: "dispatched" as const,
      orderedAt: istNoon(head.orderDate),
      totalAmount: total,
      lineItems,
      creditDays: head.creditDays,
      expectedDispatch: head.dispatchDate,
      updatedAt: new Date(),
    };

    if (orderByRef.has(externalRef)) updated++;
    else created++;
    pending.push({ id: orderByRef.get(externalRef) ?? newId("ord"), ...values });
  }

  // One statement per five hundred orders rather than one per order. The
  // external reference is unique, so an order already here is updated in place
  // and the pass stays re-runnable.
  if (!options.dryRun) {
    for (const batch of chunked(pending)) {
      await db
        .insert(orders)
        .values(batch)
        .onConflictDoUpdate({
          target: orders.externalRef,
          set: {
            customerId: sql`excluded.customer_id`,
            status: sql`excluded.status`,
            orderedAt: sql`excluded.ordered_at`,
            totalAmount: sql`excluded.total_amount`,
            lineItems: sql`excluded.line_items`,
            creditDays: sql`excluded.credit_days`,
            expectedDispatch: sql`excluded.expected_dispatch`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  return {
    orders: { created, updated, lines: lineCount },
    skipped: [...skipReasons].map(([reason, count]) => ({ reason, count })),
  };
}

/* ----------------------------------------------------------------- bills */

/**
 * Bills and payments, from the Payment Status tab.
 *
 * That tab is one row per ORDER, and Order Number is its key — the Tally bill
 * number cannot be, because 113 of them repeat across 539 rows and
 * `bills.bill_no` is unique. Where a Tally number does repeat, the order
 * number is appended so the human-readable identifier stays unique without
 * losing what it was; `external_ref` carries the stable key either way.
 *
 * What the tab supports, and what it does not:
 *
 *   RECEIVED means the bill is settled, so `paid_amount` is set to the full
 *   amount. That matches how the app already works — the payment action
 *   maintains paid_amount incrementally rather than deriving it, so writing it
 *   here is consistent rather than a shortcut.
 *
 *   A PAYMENT ROW is written only where a received DATE exists. 2,302 rows say
 *   Received without saying when, and `payments.paid_at` is not nullable. An
 *   invented date would flow straight into ageing, slow-payer flags and every
 *   collections figure built on them. So the bill is marked paid — which is
 *   known — and no payment row is fabricated to carry a date that is not.
 *
 *   A BLANK STATUS is treated as unpaid. It is genuinely ambiguous: 2,383 rows
 *   say nothing at all, and "not yet paid" and "nobody has updated this" wear
 *   the same blank. Unpaid is the conservative reading for collections, and
 *   the count is reported so it is a known quantity rather than an assumption
 *   nobody sees.
 *
 *   A MISSING DUE DATE is left null. 87% of rows have none, and the existing
 *   rule already resolves one from the order's term, then the customer's, then
 *   the configured default — which is better than inventing a date here.
 */
/**
 * A payment the Payment Status tab reports, as a CONFIRMED receipt.
 *
 * Confirmed, not reported, because that tab IS accounts' own record of what
 * reached the bank — it is not a telecaller relaying what a customer said.
 * Putting a year of it into the confirmation queue would ask accounts to
 * re-verify their own ledger.
 *
 * Idempotent on the external reference, so a re-sync writes nothing twice.
 */
async function writeSheetReceipt(input: {
  billId: string;
  customerId: string;
  amount: number;
  paidAt: string;
  externalRef: string;
}): Promise<boolean> {
  const [already] = await db
    .select({ id: paymentReceipts.id })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.idempotencyKey, input.externalRef))
    .limit(1);
  if (already) return false;

  const receiptId = newId("rcp");
  await db.transaction(async (tx) => {
    await tx.insert(paymentReceipts).values({
      id: receiptId,
      customerId: input.customerId,
      amount: input.amount,
      receivedAt: input.paidAt,
      // The tab says the money arrived, never how. Naming a mode would be
      // inventing a fact that reconciliation later depends on.
      mode: "Not stated",
      status: "confirmed",
      source: "sheet_import",
      confirmedAt: new Date(),
      idempotencyKey: input.externalRef,
    });
    await tx.insert(payments).values({
      id: newId("pay"),
      receiptId,
      billId: input.billId,
      customerId: input.customerId,
      amount: input.amount,
      paidAt: input.paidAt,
      mode: "Not stated",
      externalRef: input.externalRef,
    });
  });
  return true;
}

/**
 * Bills from the ORDER history, one per order, every one marked paid.
 *
 * A sales bill in this business IS the order — the Order Details tab carries a
 * Tally bill number on 23,593 of its 23,619 lines and the amount on all of
 * them, and that ledger is what Sales Bills is meant to show. Sourcing bills
 * from the Payment Status tab alone left the screen empty whenever that tab
 * had not been pulled, which is a bill list missing because of a second
 * document rather than because there are no bills.
 *
 * PAID IS THE STARTING POSITION, and that is a deliberate instruction rather
 * than a fact the sheet supplies. The order tab records what was billed and
 * never what was received — its Payment Status column is empty on every row —
 * so the only two options are to assume everything is owed or to assume
 * everything is settled. Assuming owed invents roughly nine crore of debt and
 * puts every customer on the collections list. Assuming settled shows nothing
 * owed until somebody says otherwise, which understates rather than fabricates
 * and is the safer of the two lies. Marking the genuinely unpaid ones is a
 * person's job from here.
 *
 * The receipt carries `mode: "Not stated"` and `source: "sheet_import"` so
 * nothing downstream mistakes it for a payment somebody witnessed, and its
 * date is the bill's own date because that is the only date this tab has.
 *
 * Keyed `SHEETPAY-<order number>`, the same key the Payment Status path uses,
 * so the two can never produce two bills for one order.
 */
export async function projectBillsFromOrders(
  options: ProjectionOptions = {},
): Promise<ProjectionReport["bills"]> {
  const lines = await db
    .select()
    .from(sheetOrderRows)
    .where(
      and(
        eq(sheetOrderRows.status, "present"),
        sql`${sheetOrderRows.orderNumber} is not null`,
      ),
    )
    .orderBy(sheetOrderRows.orderNumber, sheetOrderRows.rowNumber);

  // One order is one bill, and its value is the SUM of its lines — Final
  // Amount is line-level and roughly half these orders are multi-line.
  const grouped = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = grouped.get(line.orderNumber!) ?? [];
    list.push(line);
    grouped.set(line.orderNumber!, list);
  }

  const refs = [...grouped.keys()].map((n) => `SHEET-${n}`);
  const orderRows = refs.length
    ? await db
        .select({ id: orders.id, externalRef: orders.externalRef, customerId: orders.customerId })
        .from(orders)
        .where(inArray(orders.externalRef, refs))
    : [];
  const orderByRef = new Map(orderRows.map((o) => [o.externalRef!, o]));

  // A Tally number carried by more than one order gains the order number, so
  // the identifier stays unique without losing what it was.
  const tallyCounts = new Map<string, number>();
  for (const [, group] of grouped) {
    const tally = group[0].tallyBillNo?.trim();
    if (tally) tallyCounts.set(tally, (tallyCounts.get(tally) ?? 0) + 1);
  }

  const existing = await db
    .select({ id: bills.id, externalRef: bills.externalRef })
    .from(bills)
    .where(sql`${bills.externalRef} like 'SHEETPAY-%'`);
  const billByRef = new Map(existing.map((b) => [b.externalRef!, b.id]));

  let created = 0;
  let updated = 0;
  let receipts = 0;

  for (const [orderNumber, group] of grouped) {
    const head = group[0];
    const order = orderByRef.get(`SHEET-${orderNumber}`);
    if (!order) continue;

    const amount = group.reduce((sum, l) => sum + (l.finalAmountPaise ?? 0), 0);
    if (amount <= 0) continue;

    const billDate = head.dispatchDate ?? head.orderDate;
    if (!billDate) continue;

    const tally = head.tallyBillNo?.trim();
    const billNo =
      tally && (tallyCounts.get(tally) ?? 0) === 1
        ? tally
        : tally
          ? `${tally}/${orderNumber}`
          : `ORD-${orderNumber}`;

    const externalRef = `SHEETPAY-${orderNumber}`;
    const values = {
      customerId: order.customerId,
      billNo,
      orderId: order.id,
      billDate,
      // Left null on purpose: E3 resolves a due date from the order's term,
      // then the customer's, then the configured default. This tab has none.
      dueDate: null,
      amount,
      externalRef,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };

    if (options.dryRun) {
      if (billByRef.has(externalRef)) updated++;
      else created++;
      continue;
    }

    let billId = billByRef.get(externalRef);
    if (billId) {
      await db.update(bills).set(values).where(eq(bills.id, billId));
      updated++;
    } else {
      billId = newId("bil");
      await db.insert(bills).values({ id: billId, ...values });
      created++;
    }

    // Settled by instruction, not by evidence. Idempotent on the key, so a
    // re-run never pays the same bill twice.
    const wrote = await writeSheetReceipt({
      billId,
      customerId: order.customerId,
      amount,
      paidAt: billDate,
      externalRef,
    });
    if (wrote) receipts++;
  }

  return {
    created,
    updated,
    payments: receipts,
    // Neither figure applies here: this tab states no payment status at all,
    // so there is nothing "received without a date" and nothing left blank.
    paidWithoutDate: 0,
    blankStatus: 0,
    skipped: false,
  };
}

export async function projectBills(
  options: ProjectionOptions = {},
): Promise<ProjectionReport["bills"]> {
  if (!options.includeBills) {
    return {
      created: 0,
      updated: 0,
      payments: 0,
      paidWithoutDate: 0,
      blankStatus: 0,
      skipped: true,
    };
  }

  const rows = await db
    .select()
    .from(sheetPaymentRows)
    .where(eq(sheetPaymentRows.status, "present"));

  // Bills hang off the customer, and the customer is the billing party name.
  const names = [
    ...new Set(rows.map((r) => r.billingPartyName).filter(Boolean) as string[]),
  ];
  const known = names.length
    ? await db
        .select({ id: customers.id, externalCode: customers.externalCode })
        .from(customers)
        .where(inArray(customers.externalCode, names.map(partyKey)))
    : [];
  const customerByKey = new Map(known.map((c) => [c.externalCode!, c.id]));

  // Which orders exist, so a bill is never attached to a customer the order
  // does not belong to.
  const refs = rows.map((r) => `SHEET-${r.orderNumber}`);
  const orderRows = refs.length
    ? await db
        .select({
          id: orders.id,
          externalRef: orders.externalRef,
          customerId: orders.customerId,
        })
        .from(orders)
        .where(inArray(orders.externalRef, refs))
    : [];
  const orderByRef = new Map(orderRows.map((o) => [o.externalRef!, o.customerId]));
  // The bill records which order it came from, rather than leaving the two
  // joined by a naming convention only this file knows about.
  const orderIdByRef = new Map(orderRows.map((o) => [o.externalRef!, o.id]));

  // Tally numbers that repeat, so those bills can be disambiguated.
  const tallyCounts = new Map<string, number>();
  for (const r of rows) {
    if (!r.tallyBillNo) continue;
    tallyCounts.set(r.tallyBillNo, (tallyCounts.get(r.tallyBillNo) ?? 0) + 1);
  }

  const existing = await db
    .select({ id: bills.id, externalRef: bills.externalRef })
    .from(bills)
    .where(sql`${bills.externalRef} like 'SHEETPAY-%'`);
  const billByRef = new Map(existing.map((b) => [b.externalRef!, b.id]));

  let created = 0;
  let updated = 0;
  let paymentsWritten = 0;
  let paidWithoutDate = 0;
  let blankStatus = 0;

  for (const row of rows) {
    const externalRef = `SHEETPAY-${row.orderNumber}`;
    const customerId =
      orderByRef.get(`SHEET-${row.orderNumber}`) ??
      (row.billingPartyName ? customerByKey.get(partyKey(row.billingPartyName)) : undefined);

    if (!customerId) continue;
    if (row.billAmountPaise === null || row.billAmountPaise <= 0) continue;

    const received = isReceived(row.paymentStatus);
    if (!row.paymentStatus?.trim()) blankStatus++;
    if (received && !row.paymentReceivedDate) paidWithoutDate++;

    // A repeated Tally number keeps its text and gains the order number, so it
    // is still recognisable to whoever reads it against the ledger.
    const tally = row.tallyBillNo?.trim();
    const billNo =
      tally && (tallyCounts.get(tally) ?? 0) === 1
        ? tally
        : tally
          ? `${tally}/${row.orderNumber}`
          : `ORD-${row.orderNumber}`;

    const values = {
      customerId,
      billNo,
      orderId: orderIdByRef.get(`SHEET-${row.orderNumber}`) ?? null,
      billDate: row.dispatchDate ?? row.dueDate!,
      dueDate: row.dueDate,
      amount: row.billAmountPaise,
      // `paidAmount` is not set here. It is derived from confirmed receipts by
      // `recomputeBillPaid`, and writing it directly would make the importer a
      // second author of a cached figure that already has one.
      externalRef,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };
    if (!values.billDate) continue;

    if (options.dryRun) {
      if (billByRef.has(externalRef)) updated++;
      else created++;
      continue;
    }

    const billId = billByRef.get(externalRef);
    if (billId) {
      await db.update(bills).set(values).where(eq(bills.id, billId));
      updated++;
      if (received && row.paymentReceivedDate) {
        const wrote = await writeSheetReceipt({
          billId,
          customerId,
          amount: row.billAmountPaise,
          paidAt: row.paymentReceivedDate,
          externalRef,
        });
        if (wrote) paymentsWritten++;
      }
    } else {
      const id = newId("bil");
      await db.insert(bills).values({ id, ...values });
      created++;
      if (received && row.paymentReceivedDate) {
        const wrote = await writeSheetReceipt({
          billId: id,
          customerId,
          amount: row.billAmountPaise,
          paidAt: row.paymentReceivedDate,
          externalRef,
        });
        if (wrote) paymentsWritten++;
      }
    }
  }

  // The importer writes the money and the bills together, so the cached paid
  // amounts and everything downstream of them are rebuilt once at the end
  // rather than per row.
  if (!options.dryRun) {
    await recomputeAllBillPaid();
    await recomputeBillStatuses();
  }

  return {
    created,
    updated,
    payments: paymentsWritten,
    paidWithoutDate,
    blankStatus,
    skipped: false,
  };
}

/* ------------------------------------------------------------ the whole */

export async function projectSheet(
  options: ProjectionOptions = {},
): Promise<ProjectionReport> {
  const customerResult = await projectCustomers(options);
  const { orders: orderResult, skipped } = await projectOrders(options);

  // A sales bill is the order, so bills come from the order history by
  // default and every one starts settled. `--bills` swaps the source to the
  // Payment Status tab, which carries real received/not-received for 8,277 of
  // its rows — better evidence where it has been pulled. Never both: they key
  // on the same `SHEETPAY-<order number>`, and running one after the other
  // would have two authors for one bill.
  const billResult = options.includeBills
    ? await projectBills(options)
    : await projectBillsFromOrders(options);

  if (!options.dryRun) {
    // Derived values are never written by hand — they are rebuilt from the
    // rows that just landed. Order matters: statuses come from paid_amount,
    // outstanding from the bills, and the follow-up stage from what is
    // outstanding and how old it is.
    await recomputeAllBuyingCycles();
    // Unconditional now: bills are written on every run, so the figures over
    // them are always stale by the time we get here. paid_amount comes from
    // the confirmed receipts first, then statuses from that, then outstanding,
    // then the follow-up stage from what is outstanding and how old it is.
    await recomputeAllBillPaid();
    await recomputeBillStatuses();
    await recomputeAllOutstanding();
    await recomputeAllFollowUpStates();
    await recomputeSlowPayers();

    // The flag finally means something. It was written on every sync and read
    // only to warn that nothing was derived from these rows — which stopped
    // being true the moment a projection existed, leaving the console
    // contradicting the screens next to it. Marking the batches that have been
    // projected is the fact worth showing.
    await db
      .update(sheetSyncRuns)
      .set({ feedsCrm: true })
      .where(eq(sheetSyncRuns.status, "ok"));
  }

  return {
    customers: customerResult,
    orders: orderResult,
    bills: billResult,
    skipped,
  };
}
