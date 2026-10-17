"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers, focusCustomers } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { isManager, requireUser } from "@/lib/auth";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Adding a customer to Focus customers, and taking one off.
 *
 * `customer.write` — the capability anybody working a book holds for saying
 * something about a customer in it — and the customer's own scope, asked
 * before the capability so a refusal cannot be used to find out whether an id
 * exists. A server action is a URL, so both are checked here and not only by
 * which customers the picker offers.
 *
 * Taking one off is the person who added it, or a manager. A list anybody can
 * clear is a list that quietly empties the week nobody wants to look at it.
 * ------------------------------------------------------------------------- */

const NOTE_MAX = 500;

const addSchema = z.object({
  customerId: z.string().min(1),
  note: z.string().trim().max(NOTE_MAX).optional(),
});

export async function addFocusCustomer(
  input: z.infer<typeof addSchema>,
): Promise<Result<null>> {
  try {
    const parsed = addSchema.safeParse(input);
    if (!parsed.success) return err(`Pick a customer. A note can be up to ${NOTE_MAX} characters.`, "validation");
    const { customerId } = parsed.data;
    const note = parsed.data.note || null;

    const user = await requireUser();
    const row = await db.query.customers.findFirst({
      where: eq(customers.id, customerId),
      columns: {
        id: true,
        name: true,
        kind: true,
        ownerId: true,
        salesAmId: true,
        backOfficeAmId: true,
        deletedAt: true,
      },
    });
    if (!row) return err("That customer is not here.", "not_found");
    await assertCustomerInScope(row);
    const { authorisedBy, authorisedIn } = await requireCapability("customer.write");

    const existing = await db.query.focusCustomers.findFirst({
      where: eq(focusCustomers.customerId, customerId),
      columns: { id: true },
    });
    if (existing) return ok(null, `${row.name} is already a focus customer.`);

    const id = `foc_${randomUUID().slice(0, 12)}`;
    await db.transaction(async (tx) => {
      await tx
        .insert(focusCustomers)
        .values({ id, customerId, addedById: user.id, note })
        // Two people adding the same shop in the same second is one entry.
        .onConflictDoNothing();
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: user.id,
        action: "customer.focus.add",
        entityType: "customer",
        entityId: customerId,
        actorRole: authorisedBy,
        actorApp: authorisedIn,
        afterState: { note },
      });
    });

    revalidatePath("/crm/targets");
    revalidatePath("/accounts/customer-targets");
    return ok(null, `${row.name} added to focus customers.`);
  } catch (e) {
    return fromThrown(e);
  }
}

const removeSchema = z.object({ entryId: z.string().min(1) });

export async function removeFocusCustomer(
  input: z.infer<typeof removeSchema>,
): Promise<Result<null>> {
  try {
    const parsed = removeSchema.safeParse(input);
    if (!parsed.success) return err("Say which entry.", "validation");

    const user = await requireUser();
    const entry = await db.query.focusCustomers.findFirst({
      where: eq(focusCustomers.id, parsed.data.entryId),
    });
    if (!entry) return ok(null, "Already removed.");

    const row = await db.query.customers.findFirst({
      where: eq(customers.id, entry.customerId),
      columns: {
        id: true,
        name: true,
        kind: true,
        ownerId: true,
        salesAmId: true,
        backOfficeAmId: true,
        deletedAt: true,
      },
    });
    if (!row) return err("That customer is not here.", "not_found");
    await assertCustomerInScope(row);
    const { authorisedBy, authorisedIn } = await requireCapability("customer.write");

    if (entry.addedById !== user.id && !isManager(user)) {
      return err(
        "Only the person who added this customer, or a manager, can take it off the list.",
        "not_permitted",
      );
    }

    await db.transaction(async (tx) => {
      await tx.delete(focusCustomers).where(eq(focusCustomers.id, entry.id));
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: user.id,
        action: "customer.focus.remove",
        entityType: "customer",
        entityId: entry.customerId,
        actorRole: authorisedBy,
        actorApp: authorisedIn,
        beforeState: {
          note: entry.note,
          addedById: entry.addedById,
          addedAt: entry.addedAt.toISOString(),
        },
      });
    });

    revalidatePath("/crm/targets");
    revalidatePath("/accounts/customer-targets");
    return ok(null, `${row.name} taken off focus customers.`);
  } catch (e) {
    return fromThrown(e);
  }
}
