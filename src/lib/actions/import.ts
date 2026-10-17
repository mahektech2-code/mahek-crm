"use server";

import { z } from "zod";
import { db } from "@/db";
import { bills, customers } from "@/db/schema";
import { canOpen } from "@/lib/access";
import { NotPermittedError, requireCapability } from "@/lib/access-control";
import { randomUUID } from "node:crypto";
import { auditLog } from "@/db/schema";
import { recomputeOutstanding } from "@/lib/recompute";
import { err as fail, fromThrown, ok, type Result as ActionResult } from "@/lib/result";
import { today } from "@/lib/recompute";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * CSV import — how real Mahek data gets in.
 *
 * Rows are validated one at a time and reported per row, so a single bad
 * telephone number never silently drops a customer or aborts the whole file.
 * ------------------------------------------------------------------------- */

export type ImportIssue = { row: number; name: string; problem: string };
export type ImportSummary = {
  created: number;
  updated: number;
  skipped: ImportIssue[];
  /**
   * What the file asked for and the import deliberately did not do — said in
   * words on the result, because a column silently ignored reads afterwards as
   * an import that did not work.
   */
  notes: string[];
};

/*
 * WHO MAY RUN AN IMPORT, asked on the server for both files.
 *
 * It was `isManager`, the widest level held anywhere — so a manager of the
 * Reports app or of HRMS, with no business in the calling book at all, could
 * post a CSV that created and rewrote customers. It is `sheet.import` now, the
 * capability every other import door in MahekOne asks for, AND the CRM grant,
 * because this is the CRM's import screen: a capability is a union over hats,
 * and holding it on the ledger desk is not a reason to be writing the calling
 * book from a door the CRM layout would never have shown you.
 */
async function requireImporter() {
  const ctx = await requireCapability("sheet.import");
  if (!(await canOpen(ctx.user.id, "crm"))) throw new NotPermittedError("sheet.import");
  return ctx.user;
}

const customerRow = z.object({
  name: z.string().trim().min(2),
  contactPerson: z.string().trim().min(1),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, "").slice(-10))
    .refine((v) => /^[6-9]\d{9}$/.test(v), "not a valid 10-digit mobile number"),
  city: z.string().trim().min(1),
  gstin: z.string().trim().optional(),
  creditTermDays: z.coerce.number().int().min(0).max(180).catch(30),
  cycleDays: z.coerce.number().int().min(1).max(365).catch(30),
  route: z.string().trim().optional(),
  ownerName: z.string().trim().optional(),
});

/*
 * A THROW HERE IS A DEAD BUTTON.
 *
 * These two ran their whole body outside a try, so anything the database
 * objected to on row four hundred left the screen with a rejected promise
 * rather than a Result — no message about what went wrong, and an Import
 * button stuck on "Importing…" until somebody reloaded the page. Every other
 * action in MahekOne answers with a Result whatever happens, and these two
 * now do the same. What is already written stays written: the import reports
 * per row and is re-runnable, so a failure part way is recoverable by running
 * it again rather than by unwinding it.
 */
export async function importCustomers(
  rows: Array<Record<string, string>>,
  defaultOwnerId: string,
): Promise<ActionResult<ImportSummary>> {
  try {
    return await importCustomersInner(rows, defaultOwnerId);
  } catch (e) {
    return fromThrown(e);
  }
}

async function importCustomersInner(
  rows: Array<Record<string, string>>,
  defaultOwnerId: string,
): Promise<ActionResult<ImportSummary>> {
  const user = await requireImporter();
  if (!rows.length) return fail("That file had no rows.");

  const team = await db.query.users.findMany();
  const ownerByName = new Map(team.map((t) => [t.name.toLowerCase(), t.id]));

  const existing = await db.query.customers.findMany({
    columns: { id: true, phone: true, ownerId: true },
  });
  const byPhone = new Map(existing.map((c) => [c.phone, c.id]));
  const ownerOf = new Map(existing.map((c) => [c.id, c.ownerId]));

  const summary: ImportSummary = { created: 0, updated: 0, skipped: [], notes: [] };
  /* Existing customers whose row named a different owner — kept, and counted. */
  let ownerKept = 0;

  for (const [i, raw] of rows.entries()) {
    const parsed = customerRow.safeParse(raw);
    if (!parsed.success) {
      summary.skipped.push({
        row: i + 2, // +1 for the header, +1 for 1-based counting
        name: raw.name ?? "(no name)",
        problem: parsed.error.issues[0].message,
      });
      continue;
    }

    const d = parsed.data;
    const ownerId =
      (d.ownerName ? ownerByName.get(d.ownerName.toLowerCase()) : null) ??
      defaultOwnerId;

    const values = {
      name: d.name,
      contactPerson: d.contactPerson,
      phone: d.phone,
      city: d.city,
      ownerId,
      gstin: d.gstin || null,
      creditTermDays: d.creditTermDays,
      cycleDays: d.cycleDays,
      route: d.route || null,
    };

    // Phone is the natural key — re-importing the same sheet updates, not duplicates.
    const found = byPhone.get(d.phone);
    if (found) {
      /*
       * AN IMPORT NEVER MOVES AN EXISTING CUSTOMER'S BOOK.
       *
       * Whose book an account sits in decides who is credited for its orders,
       * whose target it counts towards and whose Call Log it lands on — which is
       * why reassignment is `customer.reassign`, accounts' and admin's, with a
       * reason, a history row and both people told. A re-imported sheet carrying
       * a different owner column was a way to do all of that silently, by
       * anybody who could import, with no record of who decided it. So the owner
       * is written on CREATE only; a row that asks to move an existing account
       * is applied everywhere else and counted, and the result says so.
       */
      const { ownerId: asked, ...rest } = values;
      if (asked !== ownerOf.get(found)) ownerKept += 1;
      await db.update(customers).set(rest).where(eqId(found));
      summary.updated += 1;
    } else {
      const id = newId("cus");
      await db
        .insert(customers)
        .values({ ...values, id, status: "active", cycleIsDefault: true, customerSince: await today() });
      byPhone.set(d.phone, id);
      summary.created += 1;
    }
  }

  if (ownerKept) {
    summary.notes.push(
      `${ownerKept} existing customer${ownerKept === 1 ? "" : "s"} named a different owner in the file and ${ownerKept === 1 ? "was" : "were"} left in the book ${ownerKept === 1 ? "it was" : "they were"} in. An import does not reassign accounts — change the account manager from the customer list, where the move is recorded and both people are told.`,
    );
  }

  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: user.id,
    action: "import.customers",
    entityType: "customer",
    afterState: summary as never,
  });

  return ok(
    summary,
    `${summary.created} created, ${summary.updated} updated` +
      (summary.skipped.length ? `, ${summary.skipped.length} skipped` : ""),
  );
}

const billRow = z.object({
  billNo: z.string().trim().min(1),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, "").slice(-10)),
  billDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  dueDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "due date must be YYYY-MM-DD"),
  amount: z.coerce.number().positive("amount must be a positive number"),
  paid: z.coerce.number().min(0).catch(0),
});

export async function importBills(
  rows: Array<Record<string, string>>,
): Promise<ActionResult<ImportSummary>> {
  try {
    return await importBillsInner(rows);
  } catch (e) {
    return fromThrown(e);
  }
}

async function importBillsInner(
  rows: Array<Record<string, string>>,
): Promise<ActionResult<ImportSummary>> {
  const user = await requireImporter();
  if (!rows.length) return fail("That file had no rows.");

  const existingCustomers = await db.query.customers.findMany({
    columns: { id: true, phone: true },
  });
  const byPhone = new Map(existingCustomers.map((c) => [c.phone, c.id]));

  const existingBills = await db.query.bills.findMany({
    columns: { id: true, billNo: true },
  });
  const byNo = new Map(existingBills.map((b) => [b.billNo, b.id]));

  const summary: ImportSummary = { created: 0, updated: 0, skipped: [], notes: [] };
  const touched = new Set<string>();
  /* Rows that carried a paid figure, which the import does not write. */
  let paidIgnored = 0;

  for (const [i, raw] of rows.entries()) {
    const parsed = billRow.safeParse(raw);
    if (!parsed.success) {
      summary.skipped.push({
        row: i + 2,
        name: raw.billNo ?? "(no bill number)",
        problem: parsed.error.issues[0].message,
      });
      continue;
    }

    const d = parsed.data;
    const customerId = byPhone.get(d.phone);
    if (!customerId) {
      summary.skipped.push({
        row: i + 2,
        name: d.billNo,
        problem: `no customer with telephone ${d.phone} - import customers first`,
      });
      continue;
    }

    /*
     * A FILE NEVER WRITES MONEY — the rule the order-sheet projection already
     * keeps, applied to its CSV cousin.
     *
     * This wrote the file's `paid` column straight into `bills.paidAmount`, so
     * a spreadsheet cell reduced outstanding, aged the debt and took customers
     * off the collections list with no person behind any of it. `paidAmount`
     * is rebuilt from CONFIRMED receipts and nothing else; whether money
     * arrived is the ledger desk's to record. So a new bill lands owed in full
     * — a bill nobody has spoken for is owed from its due date, Mahek's rule
     * since October 2026 — and an existing bill keeps the position and paid
     * figure it already has, so a re-import never undoes a recorded payment.
     * A paid figure in the file is counted and said, not quietly dropped.
     */
    // Rupees in the sheet, paise in the database.
    const values = {
      customerId,
      billDate: d.billDate,
      dueDate: d.dueDate,
      amount: Math.round(d.amount * 100),
    };
    if (d.paid > 0) paidIgnored += 1;

    const found = byNo.get(d.billNo);
    if (found) {
      await db.update(bills).set(values).where(eqBillId(found));
      summary.updated += 1;
    } else {
      const id = newId("bil");
      await db
        .insert(bills)
        .values({ ...values, id, billNo: d.billNo, paymentPosition: "stated" });
      byNo.set(d.billNo, id);
      summary.created += 1;
    }
    touched.add(customerId);
  }

  for (const customerId of touched) await recomputeOutstanding(customerId);

  if (paidIgnored) {
    summary.notes.push(
      `${paidIgnored} row${paidIgnored === 1 ? "" : "s"} carried a paid amount, which was not recorded. A file cannot say money arrived — record or confirm the payment in Accounts, and the bill's balance follows from that.`,
    );
  }

  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: user.id,
    action: "import.bills",
    entityType: "bill",
    afterState: summary as never,
  });

  return ok(
    summary,
    `${summary.created} created, ${summary.updated} updated` +
      (summary.skipped.length ? `, ${summary.skipped.length} skipped` : ""),
  );
}

/* Tiny helpers so the drizzle `eq` import stays out of the action signatures. */
import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(customers.id, id);
}
function eqBillId(id: string) {
  return eq(bills.id, id);
}
