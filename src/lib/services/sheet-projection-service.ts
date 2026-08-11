import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  customers,
  orders,
  paymentReceipts,
  sheetOrderRows,
  sheetPaymentRows,
  sheetSyncRuns,
  syncConflicts,
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
    /**
     * Always 0, and kept so a caller reading the report can SEE that it is 0.
     * The sheet no longer writes money in any form — no receipt, no
     * `paid_amount`, no `status`, no `outstanding` — so a projection that
     * reported nothing about payments would look like one that had not been
     * asked rather than one that is forbidden.
     */
    payments: number;
    /** Marked Received with no date. Counted as evidence to act on, not acted on. */
    paidWithoutDate: number;
    /** No status at all — the blank that used to be read as settled. */
    blankStatus: number;
    /**
     * Orders whose bill number is already held by a different bill and could
     * not be made unique. Skipped and counted, never renamed into something
     * nobody can reconcile — and never thrown, because one unusable number
     * must not cost the other ten thousand rows.
     */
    clashed: number;
    /**
     * Bills created carrying no payment position, because nobody has stated
     * one. They count as neither paid nor owed until somebody does. This is
     * the number worth watching: it is how much of the book is waiting on a
     * person rather than how much has been decided.
     */
    unstated: number;
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
  /*
   * Read the decided orders BEFORE the upsert, because after it the kept
   * status and the sheet's are indistinguishable — the whole point of the
   * guard is that the row comes out unchanged.
   */
  if (!options.dryRun) {
    await recordStatusConflicts(pending);
  }

  if (!options.dryRun) {
    for (const batch of chunked(pending)) {
      await db
        .insert(orders)
        .values(batch)
        .onConflictDoUpdate({
          target: orders.externalRef,
          set: {
            customerId: sql`excluded.customer_id`,
            /*
             * THE ONE COLUMN THE SHEET DOES NOT ALWAYS WIN.
             *
             * Every other field here is the sheet's to state and the sheet is
             * simply right about it. Status is different, because accounts
             * decide it in the app: approving or declining an order is a
             * person taking responsibility, and this statement used to undo
             * that on the next pass without telling anybody.
             *
             * `approved_at` is the evidence a decision was made — it is set by
             * both approve and decline, and never by this projection. Where it
             * is null the order is untouched by anybody and the sheet wins as
             * before; where it is set, the decision stands and the
             * disagreement is written to `sync_conflicts` instead.
             */
            status: sql`case when ${orders.approvedAt} is null
                             then excluded.status else ${orders.status} end`,
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


/**
 * Write down the orders where the sheet and a person disagree.
 *
 * Called before the upsert, because afterwards there is nothing to see: the
 * guard keeps the app's status, so the row that was protected and a row that
 * simply agreed look identical.
 *
 * Only orders with `approvedAt` set are considered — that is the mark of a
 * decision, written by approve and decline alike and never by this projection.
 * Of those, only the ones whose status the sheet actually contradicts, so an
 * order approved and then dispatched in the sheet raises nothing.
 */
async function recordStatusConflicts(
  pending: Array<{ externalRef?: string | null; status?: string }>,
): Promise<void> {
  const refs = pending
    .map((p) => p.externalRef)
    .filter((r): r is string => Boolean(r));
  if (!refs.length) return;

  const wanted = new Map(
    pending.flatMap((p) =>
      p.externalRef && p.status ? [[p.externalRef, p.status] as const] : [],
    ),
  );

  const decided = await db
    .select({
      id: orders.id,
      externalRef: orders.externalRef,
      status: orders.status,
      approvedById: orders.approvedById,
      approvedAt: orders.approvedAt,
    })
    .from(orders)
    .where(and(inArray(orders.externalRef, refs), sql`${orders.approvedAt} is not null`));

  const rows = decided
    .filter((o) => o.externalRef && wanted.get(o.externalRef) !== o.status)
    .map((o) => ({
      id: newId("cfl"),
      entityType: "orders",
      entityId: o.id,
      field: "status",
      sheetValue: wanted.get(o.externalRef as string) ?? null,
      appValue: o.status,
      decidedById: o.approvedById,
      decidedAt: o.approvedAt,
    }));

  if (!rows.length) return;

  /*
   * An unresolved conflict is re-detected on every pass — every thirty
   * minutes, for as long as nobody corrects the sheet. Doing nothing on
   * conflict keeps the ORIGINAL detection time, which is the useful one: how
   * long this has been waiting, not how recently a schedule ran.
   */
  await db.insert(syncConflicts).values(rows).onConflictDoNothing();
}

/* ----------------------------------------------------------------- bills */

/**
 * Bills — and NOT payments — from the Payment Status tab.
 *
 * That tab is one row per ORDER, and Order Number is its key — the Tally bill
 * number cannot be, because 113 of them repeat across 539 rows and
 * `bills.bill_no` is unique. Where a Tally number does repeat, the order
 * number is appended so the human-readable identifier stays unique without
 * losing what it was; `external_ref` carries the stable key either way.
 *
 * This path used to write money, and it had the best claim to: the tab really
 * does carry received/not-received, on 8,277 rows, which is evidence and not
 * an assumption. It still does not write money, because a receipt is the
 * assertion that funds reached the bank and a spreadsheet cell cannot make
 * that assertion — no person is behind it, and there is nobody to ask when it
 * turns out to be wrong. The tab now informs accounts rather than acting for
 * them.
 *
 * What the tab supports, and what is done with it:
 *
 *   RECEIVED is COUNTED, not applied. `paidWithoutDate` and `blankStatus` come
 *   back on the report so somebody can see how much of the book the tab claims
 *   to know about, and go and confirm it. Nothing is written to `paid_amount`,
 *   no receipt is created, and no bill changes status.
 *
 *   A BLANK STATUS is neither paid nor unpaid. 2,383 rows say nothing at all,
 *   and "not yet paid" and "nobody has updated this" wear the same blank. It
 *   was read as settled once and as unpaid before that; it is now read as what
 *   it is, which is the same `unstated` every other row gets.
 *
 *   A MISSING DUE DATE is left null. 87% of rows have none, and the existing
 *   rule already resolves one from the order's term, then the customer's, then
 *   the configured default — which is better than inventing a date here.
 */
/**
 * Order numbers the Payment Status tab affirmatively says are NOT settled.
 *
 * One definition, read by the projection that must not settle them and by the
 * revert that undoes the ones already settled. Two copies of this rule is how
 * a cleanup deletes a different set to the one the importer stopped writing,
 * and the difference would be money.
 *
 * Affirmative is the operative word. A row must EXIST, be present, carry a
 * non-blank status, and that status must not be "received". A blank says
 * nothing and is not evidence; an order with no row at all is not evidence
 * either. Neither is claimed as debt.
 */
export async function unpaidPerPaymentTab(): Promise<Set<string>> {
  const rows = await db
    .select({
      orderNumber: sheetPaymentRows.orderNumber,
      paymentStatus: sheetPaymentRows.paymentStatus,
    })
    .from(sheetPaymentRows)
    .where(eq(sheetPaymentRows.status, "present"));

  const unpaid = new Set<string>();
  for (const row of rows) {
    if (!row.paymentStatus?.trim()) continue;
    if (isReceived(row.paymentStatus)) continue;
    unpaid.add(row.orderNumber);
  }
  return unpaid;
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
 * IT STATES NO PAYMENT POSITION AT ALL, and that is the point.
 *
 * This path used to assume every bill was settled and write a confirmed
 * receipt for the full amount to say so. The reasoning was that the order tab
 * records what was billed and never what was received, so the only options
 * were to assume everything owed — roughly nine crore of invented debt, every
 * customer on the collections list — or to assume everything settled, which
 * understates rather than fabricates. It was called the safer of two lies.
 *
 * It was still a lie, and it was the one that hides money. Every customer's
 * every bill read as paid on the authority of a spreadsheet, with no person
 * behind any of it, and the assumption twice overwrote a real decision: the 9
 * August receivables report marked 395 bills owed and a scheduled pass settled
 * 348 of them again, Rs 1.18 crore, fourteen hours later.
 *
 * So the third answer is the true one: nobody has said. A bill lands
 * `payment_position = 'unstated'` and counts as NEITHER paid nor owed — held
 * out of outstanding, aging, the collections worklist and the slow-payer flag
 * until the app or the Tally receivables report speaks. Nothing chases a debt
 * nobody has vouched for, and nothing is written off either.
 *
 * THE SHEET NEVER WRITES MONEY. Not a receipt, not `paid_amount`, not
 * `status`, not `outstanding`. Those are the app's, and only the app's. What
 * this function writes is what the tab actually knows: which bill exists,
 * against which order and customer, for how much, on what date. `unstated` is
 * written on INSERT and never on UPDATE, because a bill somebody has since
 * spoken for must not be returned to silence by the next scheduled pass.
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

  /*
   * The Payment Status tab used to be read here, to hold back the orders it
   * affirmatively called unpaid from being settled by assumption. There is no
   * assumption left to hold back — nothing on this path settles anything — so
   * the read is gone with it. `unpaidPerPaymentTab()` remains, because the
   * revert that undoes the receipts this path once wrote still needs it.
   */

  const refs = [...grouped.keys()].map((n) => `SHEET-${n}`);
  const orderRows = refs.length
    ? await db
        .select({ id: orders.id, externalRef: orders.externalRef, customerId: orders.customerId })
        .from(orders)
        .where(inArray(orders.externalRef, refs))
    : [];
  const orderByRef = new Map(orderRows.map((o) => [o.externalRef!, o]));

  // A Tally number carried by more than one order gains the order number, so
  // the identifier stays unique without losing what it was. Counted across
  // EVERY line, not just each order's first: three orders here carry a
  // different number further down, and a count that only reads the head is
  // blind to exactly the repeats it exists to find.
  const tallyCounts = new Map<string, number>();
  for (const [, group] of grouped) {
    const seen = new Set<string>();
    for (const line of group) {
      const t = line.tallyBillNo?.trim();
      if (t) seen.add(t);
    }
    for (const t of seen) tallyCounts.set(t, (tallyCounts.get(t) ?? 0) + 1);
  }

  // EVERY bill, not only the ones this importer wrote. `bills_no_key` is a
  // unique index over the whole table, so a number is available or it is not —
  // that is a fact about the table and cannot be worked out from this run.
  // Reading only `SHEETPAY-%` meant a number already held by a bill somebody
  // typed in, or written by the Payment Status path, or left behind by a run
  // that died halfway, collided on insert and took the whole import down with
  // it — after thousands of rows had already landed.
  const existing = await db
    .select({
      id: bills.id,
      billNo: bills.billNo,
      externalRef: bills.externalRef,
      paymentDecidedAt: bills.paymentDecidedAt,
    })
    .from(bills);
  const billByRef = new Map(
    existing.filter((b) => b.externalRef).map((b) => [b.externalRef!, b.id]),
  );
  const billByNo = new Map(existing.map((b) => [b.billNo, b]));

  let created = 0;
  let updated = 0;
  let clashed = 0;
  // Reported, not silent. How much of the book is waiting on a person to say
  // what happened to the money is a fact the person reading the run output is
  // entitled to, and it is the number that should be falling over time.
  let unstated = 0;

  for (const [orderNumber, group] of grouped) {
    const head = group[0];
    const order = orderByRef.get(`SHEET-${orderNumber}`);
    if (!order) continue;

    const amount = group.reduce((sum, l) => sum + (l.finalAmountPaise ?? 0), 0);
    if (amount <= 0) continue;

    const billDate = head.dispatchDate ?? head.orderDate;
    if (!billDate) continue;

    const tally = head.tallyBillNo?.trim();
    let billNo =
      tally && (tallyCounts.get(tally) ?? 0) === 1
        ? tally
        : tally
          ? `${tally}/${orderNumber}`
          : `ORD-${orderNumber}`;

    const externalRef = `SHEETPAY-${orderNumber}`;

    // The number this order would like, then what it settles for. A candidate
    // held by a DIFFERENT bill is taken; held by this one is simply itself.
    const held = (candidate: string) => {
      const owner = billByNo.get(candidate);
      return Boolean(owner && owner.externalRef !== externalRef);
    };
    if (held(billNo)) billNo = tally ? `${tally}/${orderNumber}` : `ORD-${orderNumber}`;
    if (held(billNo)) billNo = `ORD-${orderNumber}`;
    // Nothing left to fall back on that is still recognisable, so the row is
    // reported rather than renamed into something nobody can reconcile.
    if (held(billNo)) {
      clashed++;
      continue;
    }

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
      /*
       * `payment_position` is NOT in `values`, so an update never touches it.
       * A bill somebody has since spoken for — a receipt recorded, the
       * receivables report applied — must not be returned to silence because
       * a scheduled pass re-read the row it came from.
       */
      await db.update(bills).set(values).where(eq(bills.id, billId));
      updated++;
    } else {
      billId = newId("bil");
      /*
       * Nobody has said what this bill's payment position is, and this tab
       * cannot say: it records what was billed and never what was received.
       * So it is written down as unsaid rather than assumed either way, and
       * counts as neither paid nor owed until somebody speaks.
       */
      await db.insert(bills).values({ id: billId, ...values, paymentPosition: "unstated" });
      created++;
      unstated++;
    }
    // So the next order in this same pass sees the number as taken. A bill
    // this pass just wrote carries no decision — the projection never makes
    // one — so the mark is null whether it was created or updated here.
    billByNo.set(billNo, { id: billId, billNo, externalRef, paymentDecidedAt: null });
  }

  return {
    created,
    updated,
    // Structurally zero: this function writes no money and has no branch that
    // could. Reported rather than omitted so the run output says so out loud.
    payments: 0,
    // Neither figure applies here: this tab states no payment status at all,
    // so there is nothing "received without a date" and nothing left blank.
    paidWithoutDate: 0,
    blankStatus: 0,
    clashed,
    unstated,
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
      clashed: 0,
      unstated: 0,
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
  let paidWithoutDate = 0;
  let blankStatus = 0;
  let unstated = 0;

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
      // `payment_position` is not in `values`, so an update never touches it.
      await db.update(bills).set(values).where(eq(bills.id, billId));
      updated++;
    } else {
      /*
       * `unstated` even here, where the tab DOES carry a received flag.
       *
       * This is the harder call of the two, because this tab genuinely knows
       * something — 8,277 of its rows say received or not received, and that
       * is real evidence rather than the order tab's silence. It is still a
       * spreadsheet cell, and a receipt is the assertion that money reached
       * the bank. Writing one from a cell puts a confirmed receipt in the
       * ledger with no person behind it, which is the thing we are removing,
       * and it does not become acceptable because this cell is better
       * informed than that one.
       *
       * The evidence is not thrown away: the tab is read every pass and
       * `paidWithoutDate` and `blankStatus` still count what it says, so
       * accounts can act on it. What changes is that a person does the acting.
       */
      await db.insert(bills).values({ id: newId("bil"), ...values, paymentPosition: "unstated" });
      created++;
      unstated++;
    }
  }

  /*
   * No recompute here any more. This function no longer writes money, so
   * `paid_amount` and the statuses over it cannot have changed — and running
   * them anyway would make a read-only import look like one that touches the
   * ledger every pass.
   */

  return {
    created,
    updated,
    // Structurally zero, like the order-history path: no branch writes money.
    payments: 0,
    // What the tab SAYS, still counted, so somebody can act on it.
    paidWithoutDate,
    blankStatus,
    // The Payment Status path keys one bill per order too, so a clash here
    // would mean the same thing — it simply has not been seen.
    clashed: 0,
    unstated,
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
  // default and every one starts settled EXCEPT the ones the Payment Status
  // tab calls unpaid. `--bills` swaps the source to that tab outright, which
  // carries real received/not-received for 8,277 of its rows. The two are
  // still not interchangeable — they key on the same `SHEETPAY-<order
  // number>` — but they no longer contradict each other on the one question
  // that moves money, so a caller that forgets the flag understates the bill
  // list rather than erasing the debt on it.
  const billResult = options.includeBills
    ? await projectBills(options)
    : await projectBillsFromOrders(options);

  if (!options.dryRun) {
    // Derived values are never written by hand — they are rebuilt from the
    // rows that just landed. Order matters: statuses come from paid_amount,
    // outstanding from the bills, and the follow-up stage from what is
    // outstanding and how old it is.
    await recomputeAllBuyingCycles();

    /*
     * `recomputeAllBillPaid` and `recomputeBillStatuses` are deliberately NOT
     * here any more. Both derive from confirmed receipts, and the projection
     * no longer writes one — so there is nothing new for them to read, and
     * running them would make a pass that touches no money look like a pass
     * that rewrites the ledger every thirty minutes. Nothing else calls them
     * on this path either: the money screens rebuild them when a person
     * records or confirms something, which is now the only way they change.
     *
     * Outstanding IS still rebuilt, because bills arriving changes it: a new
     * `unstated` bill contributes nothing, but a bill whose AMOUNT the sheet
     * corrected changes what a stated bill is worth. The follow-up stage and
     * the slow-payer flag follow outstanding, so they come after it, in that
     * order.
     */
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

/* -------------------------------------------------- undoing a settled book */

export type RevertReport = {
  /** Receipts deleted, and the money they wrongly claimed had arrived. */
  deleted: number;
  restoredPaise: number;
  /** Customers whose outstanding the deletion gives back a balance to. */
  customers: number;
  /**
   * Receipts left alone because the tab says the money DID arrive. Counted so
   * the run says what it kept as well as what it took.
   */
  kept: number;
  dryRun: boolean;
};

/**
 * Undo the receipts the order-history path wrote over known debt.
 *
 * WHAT WENT WRONG: `projectBillsFromOrders` settles by default, and every
 * scheduled `mode=project` call took that path because only the Admin Console
 * passes `bills: true`. Both key on `SHEETPAY-<order number>`, so the
 * scheduled run walked over the bills the screen import had correctly marked
 * unpaid and gave each a confirmed receipt for its full amount. Bills the tab
 * marked RECEIVED already held a receipt on that key and were skipped by the
 * idempotency check — so the set it damaged is exactly the set carrying real
 * debt, and outstanding went to zero across the book.
 *
 * WHY IT IS RECOVERABLE: the projection reads `sheet_payment_rows` and never
 * writes to it, and `mode=payments` keeps it current. The tab's own verdict
 * was never overwritten, so the receipts that should exist are derivable
 * rather than guessed at — `unpaidPerPaymentTab()` is that derivation, and
 * this function and the importer share it so they cannot disagree.
 *
 * WHAT IT DELETES is narrow on purpose: a receipt at `source = 'sheet_import'`
 * whose key names an order the tab affirmatively calls unpaid. Nothing a
 * person recorded is touched — a telecaller's reported payment and an
 * accounts confirmation both carry a different source. `payments.receipt_id`
 * cascades, so the allocation lines go with the receipt they belonged to.
 *
 * WHAT IT DELIBERATELY LEAVES: orders the tab calls Received, orders it
 * leaves BLANK, and orders it has no row for. The last two are silence, not
 * evidence, and turning silence into debt is the nine-crore mistake this
 * whole path exists to avoid. That is why "all the outstanding" does not come
 * back — only the outstanding the workbook can actually vouch for does.
 */
export async function revertSheetSettledBills(
  options: { dryRun?: boolean } = {},
): Promise<RevertReport> {
  const unpaid = await unpaidPerPaymentTab();

  const sheetReceipts = await db
    .select({
      id: paymentReceipts.id,
      customerId: paymentReceipts.customerId,
      amount: paymentReceipts.amount,
      key: paymentReceipts.idempotencyKey,
    })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.source, "sheet_import"));

  const doomed: typeof sheetReceipts = [];
  let kept = 0;
  for (const receipt of sheetReceipts) {
    // The key is `SHEETPAY-<order number>`, and an order number may itself
    // contain a hyphen — so strip the known prefix rather than splitting.
    const orderNumber = receipt.key?.startsWith("SHEETPAY-")
      ? receipt.key.slice("SHEETPAY-".length)
      : null;
    if (orderNumber && unpaid.has(orderNumber)) doomed.push(receipt);
    else kept++;
  }

  const report: RevertReport = {
    deleted: doomed.length,
    restoredPaise: doomed.reduce((sum, r) => sum + r.amount, 0),
    customers: new Set(doomed.map((r) => r.customerId)).size,
    kept,
    dryRun: Boolean(options.dryRun),
  };

  if (options.dryRun || doomed.length === 0) return report;

  // One transaction. A half-deleted set would leave the book in a state
  // neither the sheet nor the app describes, and the next scheduled pass
  // would build on it.
  await db.transaction(async (tx) => {
    for (let i = 0; i < doomed.length; i += 500) {
      const batch = doomed.slice(i, i + 500).map((r) => r.id);
      await tx.delete(paymentReceipts).where(inArray(paymentReceipts.id, batch));
    }
  });

  // Derived values are never hand-edited — they are rebuilt. Same order as the
  // projection: paid_amount from the confirmed receipts that remain, statuses
  // from that, outstanding from the bills, then the follow-up stage from what
  // is outstanding and how old it is. The slow-payer flag comes last because
  // it reads the payment history the earlier passes have just corrected.
  await recomputeAllBillPaid();
  await recomputeBillStatuses();
  await recomputeAllOutstanding();
  await recomputeAllFollowUpStates();
  await recomputeSlowPayers();

  return report;
}
