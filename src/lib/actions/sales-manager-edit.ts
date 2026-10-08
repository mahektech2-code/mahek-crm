"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { auditLog, customers, products } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { assignLeadManager, saveProspectFields } from "@/lib/actions/leads";
import { reassignLead } from "@/lib/actions/sales";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { inCrmSalesManagerWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { phoneAlreadyOnTheBook } from "@/lib/services/lead-intake-service";

/* Its own file, not `sales-manager-pipeline.ts`: that one is pinned to thin
   orchestrations that never write the tables the real actions own, and this
   action writes city and phone itself (see below). */

function refresh() {
  try {
    revalidatePath("/crm/leads/sales-manager", "layout");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/* ══════════════════════════════════════════════════ edit the six basics */

const editSchema = z.object({
  customerId: z.string().min(1),
  /** Absent or empty leaves the owner alone. Moving a lead is `reassignLead`'s. */
  ownerId: z.string().nullish(),
  /** Absent or empty leaves the seat alone. Naming one is `assignLeadManager`'s. */
  leadManagerId: z.string().nullish(),
  city: z.string().trim().min(2, "Enter the city.").max(120),
  /** Empty clears it. */
  contact: z.string().trim().max(200).nullish(),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit telephone number."),
  /** Null clears it; a `ProductField` pick sets it. */
  productId: z.string().min(1).nullish(),
});

export type EditLeadBasicsInput = z.input<typeof editSchema>;

/**
 * THE SALES MANAGER'S EDIT — six fields, and nothing else: owner, sales manager,
 * city, contact, phone and product.
 *
 * Where a field already has an action, THAT action is what writes it, so its
 * rules, its audit row and its notifications are not copied here: the owner is
 * `reassignLead` (the Salesman App holder, both people told), the sales manager
 * is `assignLeadManager`, and the contact and the product are
 * `saveProspectFields` (which also voids a verified review the change makes
 * untrue). Only city and phone have no action of their own — `updateCustomer`
 * is the only other writer and it carries a credit term, a cycle and a route
 * this screen must not touch — so they are written here, with an audit row and
 * the same duplicate-number question `captureLead` asks.
 *
 * STAGE IS NEVER IN IT, and neither is any seat but the two named. In
 * particular `sales_manager_id`, the seat the workspace's scope reads, is not
 * written: moving it would take the lead out of the book of the person editing
 * it. "Sales manager" here is the lead-manager seat the record header prints.
 *
 * SCOPE IS ENFORCED HERE AND NOT ONLY BY THE PAGE. A server action is a URL;
 * this one refuses anywhere but the CRM Sales Manager workspace, requires the
 * module and `lead.work`, and asks `assertCustomerInScope` — which in that
 * workspace is the seat rule, `sales_manager_id = me`, at any level.
 *
 * EVERYTHING IS CHECKED BEFORE ANYTHING IS WRITTEN, but the writes themselves
 * are up to four separate ones. If a later one is refused, the earlier ones
 * stand and the refusal says which.
 */
export async function editLeadBasics(input: EditLeadBasicsInput): Promise<Result<null>> {
  try {
    const parsed = editSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [{ field: issue.path.join("."), message: issue.message }]);
    }
    const v = parsed.data;

    const ctx = await requireCapability("lead.work");
    if (!(await inCrmSalesManagerWorkspace()) || !(await canOpenModule(ctx.user.id, "crm.sales-manager"))) {
      return err("This edit is only available in the Sales Manager workspace.", "not_permitted");
    }

    const [lead] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, v.customerId), isNotNull(customers.leadStage)))
      .limit(1);
    if (!lead) return err("That lead is no longer here.", "not_found");
    await assertCustomerInScope({
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
      salesManagerId: lead.salesManagerId,
    });

    const contact = v.contact?.trim() || null;
    const productId = v.productId ?? null;
    const cityChanged = v.city !== (lead.city ?? "");
    const phoneChanged = v.phone !== (lead.phone ?? "");
    const contactChanged = contact !== (lead.contactPerson ?? null);
    const productChanged = productId !== (lead.leadRequiredProductId ?? null);
    const ownerChanged = Boolean(v.ownerId) && v.ownerId !== lead.ownerId;
    const managerChanged = Boolean(v.leadManagerId) && v.leadManagerId !== lead.leadManagerId;

    if (!(cityChanged || phoneChanged || contactChanged || productChanged || ownerChanged || managerChanged)) {
      return ok(null, "Nothing to change.");
    }

    /* Checked first, so a refusal leaves nothing half-written. */
    if (phoneChanged) {
      const existing = await phoneAlreadyOnTheBook(v.phone);
      if (existing && existing.id !== lead.id) {
        return err(
          `${existing.name}${existing.city ? ` in ${existing.city}` : ""} is already on the book with this number.`,
          "duplicate",
          [{ field: "phone", message: "Already on the book." }],
        );
      }
    }
    if (productChanged && productId) {
      const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1);
      if (!p) return err("That product is not in the catalogue.", "validation", [{ field: "productId", message: "Not found." }]);
    }

    const saved: string[] = [];
    const stopped = (what: string, r: Extract<Result<unknown>, { ok: false }>) =>
      err(
        `${what}: ${r.error}${saved.length ? ` (Already saved: ${saved.join(", ")}.)` : ""}`,
        r.code ?? "validation",
        r.fieldErrors,
      );

    if (cityChanged || phoneChanged) {
      await db.transaction(async (tx) => {
        await tx
          .update(customers)
          .set({
            ...(cityChanged ? { city: v.city } : {}),
            ...(phoneChanged ? { phone: v.phone } : {}),
            updatedAt: new Date(),
            updatedById: ctx.user.id,
          })
          .where(eq(customers.id, lead.id));
        await tx.insert(auditLog).values({
          id: `aud_${randomUUID().slice(0, 12)}`,
          actorId: ctx.user.id,
          action: "lead.basics.edit",
          entityType: "customer",
          entityId: lead.id,
          actorRole: ctx.authorisedBy,
          actorApp: ctx.authorisedIn,
          beforeState: { city: lead.city, phone: lead.phone },
          afterState: { city: v.city, phone: v.phone },
        });
      });
      if (cityChanged) saved.push("city");
      if (phoneChanged) saved.push("phone");
    }

    if (contactChanged || productChanged) {
      const r = await saveProspectFields(lead.id, {
        ...(contactChanged ? { contactPerson: contact } : {}),
        ...(productChanged ? { requiredProductId: productId } : {}),
      });
      if (!r.ok) return stopped("Contact / product not saved", r);
      if (contactChanged) saved.push("contact");
      if (productChanged) saved.push("product");
    }

    if (managerChanged) {
      const r = await assignLeadManager(lead.id, v.leadManagerId!);
      if (!r.ok) return stopped("Sales manager not changed", r);
      saved.push("sales manager");
    }

    if (ownerChanged) {
      const r = await reassignLead({ leadId: lead.id, salesmanId: v.ownerId! });
      if (!r.ok) return stopped("Owner not changed", r);
      saved.push("owner");
    }

    refresh();
    return ok(null, "Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}
