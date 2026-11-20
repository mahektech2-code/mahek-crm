"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { auditLog, customers, products, users } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireCapability } from "@/lib/access-control";
import { assignLeadManager, saveProspectFields } from "@/lib/actions/leads";
import { reassignLead } from "@/lib/actions/sales";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { inCrmSalesManagerWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { phoneAlreadyOnTheBook } from "@/lib/services/lead-intake-service";
import { ownerChoices } from "@/lib/services/lead-desk-assignment-service";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import { leadManagerCandidatesFor } from "@/lib/services/lead-service";

/* Its own file, not `sales-manager-pipeline.ts`: that one is pinned to thin
   orchestrations that never write the tables the real actions own, and this
   action writes city and phone itself (see below). */

function refresh() {
  try {
    /* The lead is drawn under all three — the CRM, the Sales Dashboard and
       the pipeline — and the modal can be opened from any of them. */
    for (const path of ["/crm/leads", "/sales/leads", "/sales-lead-pipeline"]) revalidatePath(path, "layout");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/**
 * MAY THIS PERSON MOVE THE TWO SEATS (owner, sales manager) from the edit?
 * Only inside the CRM Sales Manager workspace, holding its module — the one
 * place the edit ever offered them. Everywhere else the lead's owner and its
 * managers correct the details, and moving a lead stays the Reassign
 * action's, with its own rules.
 */
async function maySetSeats(userId: string): Promise<boolean> {
  return (await inCrmSalesManagerWorkspace()) && (await canOpenModule(userId, "crm.sales-manager"));
}

/* ══════════════════════════════════════════════════ edit the six basics */

const editSchema = z.object({
  customerId: z.string().min(1),
  /** The lead's own name — the shop as it is written on the board. Absent leaves it alone. */
  name: z.string().trim().min(2, "Enter the lead's name.").max(200).optional(),
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
 * THE LEAD'S EDIT — name, city, contact, phone and product for anybody who
 * works the lead; and, inside the CRM Sales Manager workspace only, the owner
 * and the sales manager too (`maySetSeats`). It used to be that workspace's
 * alone, so a lead's own salesman or telecaller could not fix a typo in it.
 *
 * Where a field already has an action, THAT action is what writes it, so its
 * rules, its audit row and its notifications are not copied here: the owner is
 * `reassignLead` (the Salesman App holder, both people told), the sales manager
 * is `assignLeadManager`, and the contact and the product are
 * `saveProspectFields` (which also voids a verified review the change makes
 * untrue). Only name, city and phone have no action of their own — `updateCustomer`
 * is the only other writer and it carries a credit term, a cycle and a route
 * this screen must not touch — so they are written here, with an audit row and
 * the same duplicate-number question `captureLead` asks.
 *
 * STAGE IS NEVER IN IT, and neither is any seat but the two named. In
 * particular `sales_manager_id`, the seat the workspace's scope reads, is not
 * written: moving it would take the lead out of the book of the person editing
 * it. "Sales manager" here is the lead-manager seat the record header prints.
 *
 * SCOPE IS ENFORCED HERE AND NOT ONLY BY THE MODAL. A server action is a URL;
 * this one requires `lead.work` and asks `assertLeadInScope` — which inside
 * the Sales Manager workspace is the seat rule, `sales_manager_id = me`, and
 * everywhere else the person's own book and seats. A seat change from outside
 * that workspace is refused before anything is written.
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
    const seats = await maySetSeats(ctx.user.id);

    const [lead] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, v.customerId), isNotNull(customers.leadStage)))
      .limit(1);
    if (!lead) return err("That lead is no longer here.", "not_found");
    /* The scope of wherever it was opened: the seat rule inside the Sales
       Manager workspace, the person's own book and seats everywhere else. */
    await assertLeadInScope(lead.id, lead);

    const name = v.name ?? lead.name;
    const nameChanged = name !== lead.name;
    const contact = v.contact?.trim() || null;
    const productId = v.productId ?? null;
    const cityChanged = v.city !== (lead.city ?? "");
    const phoneChanged = v.phone !== (lead.phone ?? "");
    const contactChanged = contact !== (lead.contactPerson ?? null);
    const productChanged = productId !== (lead.leadRequiredProductId ?? null);
    const ownerChanged = Boolean(v.ownerId) && v.ownerId !== lead.ownerId;
    const managerChanged = Boolean(v.leadManagerId) && v.leadManagerId !== lead.leadManagerId;

    if (!(nameChanged || cityChanged || phoneChanged || contactChanged || productChanged || ownerChanged || managerChanged)) {
      return ok(null, "Nothing to change.");
    }
    if ((ownerChanged || managerChanged) && !seats) {
      return err("Change the owner or the sales manager with Reassign — the edit corrects the lead's details.", "not_permitted");
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

    if (nameChanged || cityChanged || phoneChanged) {
      await db.transaction(async (tx) => {
        await tx
          .update(customers)
          .set({
            ...(nameChanged ? { name } : {}),
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
          beforeState: { name: lead.name, city: lead.city, phone: lead.phone },
          afterState: { name, city: v.city, phone: v.phone },
        });
      });
      if (nameChanged) saved.push("name");
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

/* ══════════════════════════════════════════════ what the modal opens with */

type Person = { id: string; name: string };

export type LeadEditForm = {
  lead: {
    id: string;
    name: string;
    ownerId: string;
    managerId: string;
    city: string;
    contact: string;
    phone: string;
    productId: string | null;
    product: string | null;
    lost: boolean;
  };
  /** The two seat boxes, only where `editLeadBasics` would accept them. */
  seats: { salesmen: Person[]; managers: Person[] } | null;
};

/**
 * The edit modal's starting values, read under the SAME rule the save asks:
 * `lead.work`, and the lead in scope wherever the modal was opened. The seat
 * lists come only to somebody who may set them.
 */
export async function loadLeadEditForm(customerId: string): Promise<Result<LeadEditForm>> {
  try {
    const ctx = await requireCapability("lead.work");
    const [lead] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNotNull(customers.leadStage)))
      .limit(1);
    if (!lead) return err("That lead is no longer here.", "not_found");
    await assertLeadInScope(lead.id, lead);

    const [product] = lead.leadRequiredProductId
      ? await db.select({ name: products.name }).from(products).where(eq(products.id, lead.leadRequiredProductId)).limit(1)
      : [];

    let seats: LeadEditForm["seats"] = null;
    if (await maySetSeats(ctx.user.id)) {
      const [team, candidates] = await Promise.all([ownerChoices(), leadManagerCandidatesFor(lead.id)]);
      const salesmen = team.map((p) => ({ id: p.id, name: p.name }));
      const managers = candidates.map((p) => ({ id: p.id, name: p.name }));
      /* The current holders are always offered, even where they would not be
         picked today, so a box never opens on a name it does not hold and a
         save cannot silently move the lead. */
      const named = async (id: string) =>
        (await db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1))[0]?.name ?? "Current holder";
      if (lead.ownerId && !salesmen.some((p) => p.id === lead.ownerId)) salesmen.unshift({ id: lead.ownerId, name: await named(lead.ownerId) });
      if (lead.leadManagerId && !managers.some((p) => p.id === lead.leadManagerId)) managers.unshift({ id: lead.leadManagerId, name: await named(lead.leadManagerId) });
      seats = { salesmen, managers };
    }

    return ok({
      lead: {
        id: lead.id,
        name: lead.name,
        ownerId: lead.ownerId ?? "",
        managerId: lead.leadManagerId ?? "",
        city: lead.city ?? "",
        contact: lead.contactPerson ?? "",
        phone: lead.phone ?? "",
        productId: lead.leadRequiredProductId ?? null,
        product: product?.name ?? null,
        lost: lead.leadStage === "lost",
      },
      seats,
    });
  } catch (e) {
    return fromThrown(e);
  }
}
