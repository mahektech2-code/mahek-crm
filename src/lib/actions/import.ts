"use server";

import { z } from "zod";
import { db } from "@/db";
import { bills, customers } from "@/db/schema";
import { isManager, requireUser } from "@/lib/auth";
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
};

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
  const user = await requireUser();
  if (!isManager(user)) return fail("Importing customers is a manager action.");
  if (!rows.length) return fail("That file had no rows.");

  const team = await db.query.users.findMany();
  const ownerByName = new Map(team.map((t) => [t.name.toLowerCase(), t.id]));

  const existing = await db.query.customers.findMany({
    columns: { id: true, phone: true },
  });
  const byPhone = new Map(existing.map((c) => [c.phone, c.id]));

  const summary: ImportSummary = { created: 0, updated: 0, skipped: [] };

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
      await db.update(customers).set(values).where(eqId(found));
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
  const user = await requireUser();
  if (!isManager(user)) return fail("Importing bills is a manager action.");
  if (!rows.length) return fail("That file had no rows.");

  const existingCustomers = await db.query.customers.findMany({
    columns: { id: true, phone: true },
  });
  const byPhone = new Map(existingCustomers.map((c) => [c.phone, c.id]));

  const existingBills = await db.query.bills.findMany({
    columns: { id: true, billNo: true },
  });
  const byNo = new Map(existingBills.map((b) => [b.billNo, b.id]));

  const summary: ImportSummary = { created: 0, updated: 0, skipped: [] };
  const touched = new Set<string>();

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

    // Rupees in the sheet, paise in the database.
    const values = {
      customerId,
      billDate: d.billDate,
      dueDate: d.dueDate,
      amount: Math.round(d.amount * 100),
      paidAmount: Math.round(d.paid * 100),
    };

    const found = byNo.get(d.billNo);
    if (found) {
      await db.update(bills).set(values).where(eqBillId(found));
      summary.updated += 1;
    } else {
      const id = newId("bil");
      await db.insert(bills).values({ ...values, id, billNo: d.billNo });
      byNo.set(d.billNo, id);
      summary.created += 1;
    }
    touched.add(customerId);
  }

  for (const customerId of touched) await recomputeOutstanding(customerId);

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
