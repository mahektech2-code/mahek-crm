"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { assertCustomerInScope, resolveScope } from "@/lib/access-control";
import { canFor } from "@/lib/access-control";
import { CONTACT_DESIGNATIONS, CONTACT_ROLE_CODES } from "@/lib/customer-contacts";
import {
  addContact as addContactService,
  customerOfContact,
  designateContact as designateContactService,
  listCustomerContacts,
  removeContact as removeContactService,
  updateContact as updateContactService,
  type CustomerContact,
} from "@/lib/services/customer-contact-service";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";

/*
 * THE CONTACTS PANEL'S DOORS. Each one asks the question `updateCustomer`
 * asks — is this customer in your scope — because a contact is part of the
 * customer record and whoever may edit the record may edit who is on it. The
 * screens hide nothing the action does not also refuse: an action is a URL.
 */

async function inScope(customerId: string): Promise<{ actorId: string } | Result<never>> {
  const ctx = await resolveScope();
  const [row] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!row) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(row);
  return { actorId: ctx.user.id };
}

function refresh() {
  try {
    revalidatePath("/crm/customers");
    revalidatePath("/crm/customers/[id]", "page");
    revalidatePath("/accounts/customers");
  } catch {
    /* no request context */
  }
}

const contactSchema = z.object({
  name: z.string().trim().max(120).nullish(),
  role: z.enum(CONTACT_ROLE_CODES).nullish(),
  phone: z.string().trim().min(1, "Enter a phone number.").max(24),
  email: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(500).nullish(),
  birthDay: z.coerce.number().int().min(1).max(31).nullish(),
  birthMonth: z.coerce.number().int().min(1).max(12).nullish(),
});

function validation(e: z.ZodError): Result<never> {
  const issue = e.issues[0];
  return err(issue.message, "validation", [{ field: issue.path.join("."), message: issue.message }]);
}

/**
 * A birthday typed here may be exactly what a field task was sent to collect.
 * Completing that task — and refreshing the phones still holding it — is a
 * courtesy on top of a saved contact, so it can never fail the save.
 */
async function settleTasksFor(customerId: string) {
  try {
    const { settleLinkedTasks } = await import("@/lib/services/task-link-service");
    await settleLinkedTasks([customerId]);
  } catch (e) {
    console.error("settling linked tasks failed", e);
  }
}

export async function loadCustomerContacts(customerId: string): Promise<Result<CustomerContact[]>> {
  try {
    const scope = await inScope(customerId);
    if ("ok" in scope) return scope;
    return ok(await listCustomerContacts(customerId));
  } catch (e) {
    return fromThrown(e);
  }
}

export async function addCustomerContact(
  customerId: string,
  raw: unknown,
): Promise<Result<CustomerContact[]>> {
  try {
    const scope = await inScope(customerId);
    if ("ok" in scope) return scope;
    const parsed = contactSchema
      .extend({ designations: z.array(z.enum(CONTACT_DESIGNATIONS)).max(3).optional() })
      .safeParse(raw);
    if (!parsed.success) return validation(parsed.error);
    const result = await addContactService(customerId, parsed.data, scope.actorId);
    if (result.ok) {
      refresh();
      await settleTasksFor(customerId);
    }
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function updateCustomerContact(
  contactId: string,
  raw: unknown,
): Promise<Result<CustomerContact[]>> {
  try {
    const customerId = await customerOfContact(contactId);
    if (!customerId) return err("That contact no longer exists.", "not_found");
    const scope = await inScope(customerId);
    if ("ok" in scope) return scope;
    const parsed = contactSchema.safeParse(raw);
    if (!parsed.success) return validation(parsed.error);
    const result = await updateContactService(contactId, parsed.data, scope.actorId);
    if (result.ok) {
      refresh();
      await settleTasksFor(customerId);
    }
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function removeCustomerContact(contactId: string): Promise<Result<CustomerContact[]>> {
  try {
    const customerId = await customerOfContact(contactId);
    if (!customerId) return err("That contact no longer exists.", "not_found");
    const scope = await inScope(customerId);
    if ("ok" in scope) return scope;
    const result = await removeContactService(contactId, scope.actorId);
    if (result.ok) refresh();
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function designateCustomerContact(
  contactId: string,
  designation: string,
  on: boolean,
): Promise<Result<CustomerContact[]>> {
  try {
    const d = z.enum(CONTACT_DESIGNATIONS).safeParse(designation);
    if (!d.success) return err("Unknown designation.", "validation");
    const customerId = await customerOfContact(contactId);
    if (!customerId) return err("That contact no longer exists.", "not_found");
    const scope = await inScope(customerId);
    if ("ok" in scope) return scope;
    const result = await designateContactService(contactId, d.data, Boolean(on), scope.actorId);
    if (result.ok) refresh();
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Everything the full edit form shows, read fresh when it opens.
 *
 * The list row carries a dozen columns; the form edits thirty. Shipping the
 * other eighteen on every row of a 25-row page to serve a form that opens on
 * one of them would be the catalogue mistake again — so the form asks for its
 * one customer when it opens, and the contacts with it.
 */
export type CustomerEditorData = {
  customer: {
    id: string;
    name: string;
    externalCode: string | null;
    customerType: string | null;
    potential: string | null;
    potentialMonthlyPaise: number | null;
    rating: string | null;
    segmentation: string | null;
    dealerCode: string | null;
    customerSince: string | null;
    specialInstructions: string | null;
    email: string | null;
    whatsappDest: "personal" | "group" | "both";
    whatsappGroupName: string | null;
    address: string | null;
    city: string;
    region: string | null;
    area: string | null;
    beat: string | null;
    territoryRegion: string | null;
    route: string | null;
    visitFrequencyDays: number | null;
    gstin: string | null;
    creditTermDays: number;
    creditLimitPaise: number | null;
    creditBlocked: boolean;
    creditBlockReason: string | null;
    priceTag: string | null;
    freightTerm: string | null;
    deliveryType: string | null;
    doNotContact: boolean;
  };
  contacts: CustomerContact[];
  /** The business date, so the panel can say "birthday in 3 days". */
  today: string;
  /** `customers.birthdayHeadsUpDays`. */
  birthdayHeadsUpDays: number;
  /** Whether this person may change the credit limit and the supply stop. */
  canDecideCredit: boolean;
};

export async function loadCustomerEditor(customerId: string): Promise<Result<CustomerEditorData>> {
  try {
    const ctx = await resolveScope();
    const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
    if (!c) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(c);
    const contacts = await listCustomerContacts(customerId);
    return ok({
      customer: {
        id: c.id,
        name: c.name,
        externalCode: c.externalCode,
        customerType: c.customerType,
        potential: c.potential,
        potentialMonthlyPaise: c.potentialMonthlyPaise === null ? null : Number(c.potentialMonthlyPaise),
        rating: c.rating,
        segmentation: c.segmentation,
        dealerCode: c.dealerCode,
        customerSince: c.customerSince,
        specialInstructions: c.specialInstructions,
        email: c.email,
        whatsappDest: c.whatsappDest,
        whatsappGroupName: c.whatsappGroupName,
        address: c.address,
        city: c.city,
        region: c.region,
        area: c.area,
        beat: c.beat,
        territoryRegion: c.territoryRegion,
        route: c.route,
        visitFrequencyDays: c.visitFrequencyDays,
        gstin: c.gstin,
        creditTermDays: c.creditTermDays,
        creditLimitPaise: c.creditLimitPaise === null ? null : Number(c.creditLimitPaise),
        creditBlocked: c.creditBlocked,
        creditBlockReason: c.creditBlockReason,
        priceTag: c.priceTag,
        freightTerm: c.freightTerm,
        deliveryType: c.deliveryType,
        doNotContact: c.doNotContact,
      },
      contacts,
      today: await today(),
      birthdayHeadsUpDays: (await getConfig())["customers.birthdayHeadsUpDays"],
      canDecideCredit: await canFor(ctx.user, "payment.confirm"),
    });
  } catch (e) {
    return fromThrown(e);
  }
}
