"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadStageTransitions, users } from "@/db/schema";
import { assignedUserId, canFor, requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { customerEditRefusal } from "@/lib/customer-edit-gate";
import { canonicalState, isKnownState } from "@/lib/india-states";
import { bypassSchema, funnelPosition, type BypassInput, type FunnelPosition } from "@/lib/lead-bypass";
import { labelOf, salesTypeLabel, stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import { gstinChangeClear } from "@/lib/lead-review-void";
import { notifyUsers } from "@/lib/notify";
import { today } from "@/lib/queries";
import { reconcileContacts } from "@/lib/services/customer-contact-service";
import { conversionColumns, recordConversion } from "@/lib/services/lead-conversion-service";
import { placeShopsNow } from "@/lib/services/place-tree-service";
import { resolveSeat, type ResolvedSeat } from "@/lib/services/seat-resolve";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * THE ACCOUNTS BYPASS — a lead converted straight to a customer we invoice.
 * The rules are `lib/lead-bypass.ts`; this file checks them again, writes the
 * conversion in one transaction, and records what was skipped and why.
 *
 * WHO: `customer.reassign` — the Accounts manager and the platform admin,
 * nobody else — and only from the Accounts app (`customerEditRefusal`), because
 * the bypass edits the customer's details and those are edited in Accounts.
 *
 * WHAT CHANGES, so the account reads as a customer everywhere at once:
 *   - `kind` becomes `customer` → it leaves every lead list, the Calling desk,
 *     the board and the handset's Leads tab, and joins the Customers list in
 *     the CRM and Accounts, the Call Log's customer cadence and collections;
 *   - the stage becomes `won`, dated today, with `customer_since` and
 *     `lead_converted_at` — the same columns the second-order rule writes
 *     (`conversionColumns`), so funnel reports count it as won;
 *   - the third-party mark is cleared (we invoice it now); its distributor
 *     links are kept as history;
 *   - the details, seats and commercial terms typed in the dialog, the seats
 *     marked decided (`am_decided_at`) so the sheet cannot undo them;
 *   - a stage-history row of kind `overridden` naming every skipped rung, an
 *     audit row with before and after, the conversion's own audit + timeline
 *     entry + handset tombstone (`recordConversion`);
 *   - then the contacts list, the place tree, and the people involved told.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const OUTSIDE_ACCOUNTS = "Converting a lead directly is done in the Accounts app.";

/** The person, or null where the request is not standing in Accounts. */
async function guard() {
  const ctx = await requireCapability("customer.reassign");
  return (await customerEditRefusal(ctx.user.id)) ? null : ctx;
}

export type BypassLeadHit = {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  stage: string | null;
  ownerName: string | null;
};

/** Open leads matching a name, mobile, GSTIN or city. Trashed leads never. */
export async function searchLeadsForBypass(query: string): Promise<Result<BypassLeadHit[]>> {
  try {
    if (!(await guard())) return err(OUTSIDE_ACCOUNTS, "not_permitted");
    const q = query.trim();
    if (q.length < 2) return ok([]);
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const digits = q.replace(/\D/g, "");
    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        city: customers.city,
        stage: customers.leadStage,
        ownerName: users.name,
      })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.ownerId))
      .where(
        and(
          eq(customers.kind, "lead"),
          isNull(customers.deletedAt),
          or(
            sql`${customers.name} ilike ${like}`,
            sql`${customers.city} ilike ${like}`,
            sql`${customers.gstin} ilike ${like}`,
            digits.length >= 4 ? sql`${customers.phone} like ${`%${digits}%`}` : undefined,
          ),
        ),
      )
      .orderBy(desc(customers.updatedAt))
      .limit(20);
    return ok(
      rows.map((r) => ({
        ...r,
        stage: r.stage ? stageLabel(r.stage as LeadStage) : null,
      })),
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export type BypassLead = {
  id: string;
  name: string;
  stageLabel: string | null;
  salesTypeLabel: string;
  thirdParty: boolean;
  funnel: FunnelPosition;
  /** The form's starting values — the lead's own answers, where it has them. */
  values: {
    name: string;
    contactPerson: string;
    phone: string;
    whatsappPhone: string;
    email: string;
    customerType: string;
    gstin: string;
    address: string;
    city: string;
    state: string;
    creditTermDays: string;
    creditLimit: string;
    priceTag: string;
    freightTerm: string;
    deliveryType: string;
    sales: string;
    backOffice: string;
    salesManager: string;
  };
  /** Price list tags already in use, most used first. */
  priceTags: string[];
  reasons: { code: string; label: string }[];
};

const tenDigits = (v: string | null) => (v ?? "").replace(/\D/g, "").slice(-10);

/** One lead, as the form needs it. */
export async function loadLeadForBypass(leadId: string): Promise<Result<BypassLead>> {
  try {
    if (!(await guard())) return err(OUTSIDE_ACCOUNTS, "not_permitted");
    const [c] = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        deletedAt: customers.deletedAt,
        contactPerson: customers.contactPerson,
        phone: customers.phone,
        whatsappPhone: customers.whatsappPhone,
        email: customers.email,
        customerType: customers.customerType,
        gstin: customers.gstin,
        address: customers.address,
        city: customers.city,
        region: customers.region,
        stateName: sql<string | null>`(select p.name from places p where p.id = ${customers.resolvedStateId})`,
        creditDays: customers.creditDays,
        creditDaysWanted: customers.leadCreditDaysWanted,
        creditLimitPaise: customers.creditLimitPaise,
        priceTag: customers.priceTag,
        freightTerm: customers.freightTerm,
        deliveryType: customers.deliveryType,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
        salesManagerId: customers.salesManagerId,
        thirdParty: customers.thirdParty,
        leadStage: customers.leadStage,
        leadSalesType: customers.leadSalesType,
      })
      .from(customers)
      .where(eq(customers.id, leadId))
      .limit(1);
    if (!c || c.deletedAt) return err("That lead no longer exists.", "not_found");
    if (c.kind !== "lead") return err(`${c.name} is already a customer.`, "conflict");

    const [tags, config] = await Promise.all([
      db.execute<{ tag: string }>(sql`
        select trim(price_tag) as tag from customers
         where price_tag is not null and trim(price_tag) <> ''
         group by trim(price_tag) order by count(*) desc, trim(price_tag) limit 200`),
      getConfig(),
    ]);

    const state = [c.region, c.stateName].find((s) => s && isKnownState(s));
    const sales = assignedUserId({ kind: "lead", ownerId: c.ownerId, salesAmId: c.salesAmId });
    const credit = c.creditDays ?? c.creditDaysWanted;

    return ok({
      id: c.id,
      name: c.name,
      stageLabel: c.leadStage ? stageLabel(c.leadStage) : null,
      salesTypeLabel: salesTypeLabel(c.leadSalesType as LeadSalesType | null),
      thirdParty: Boolean(c.thirdParty),
      funnel: funnelPosition(c.leadStage, c.leadSalesType as LeadSalesType | null),
      values: {
        name: c.name,
        contactPerson: c.contactPerson ?? "",
        phone: tenDigits(c.phone),
        whatsappPhone: tenDigits(c.whatsappPhone) === tenDigits(c.phone) ? "" : tenDigits(c.whatsappPhone),
        email: c.email ?? "",
        customerType: c.customerType ?? "",
        gstin: c.gstin ?? "",
        address: c.address ?? "",
        city: c.city ?? "",
        state: state ? canonicalState(state) : "",
        creditTermDays: credit === null || credit === undefined ? "" : String(credit),
        creditLimit: c.creditLimitPaise === null ? "" : String(Number(c.creditLimitPaise) / 100),
        priceTag: c.priceTag ?? "",
        freightTerm: c.freightTerm === "paid" || c.freightTerm === "to_pay" ? c.freightTerm : "",
        deliveryType: c.deliveryType ?? "",
        sales: sales ?? "",
        backOffice: c.backOfficeAmId ?? "",
        salesManager: c.salesManagerId ?? "",
      },
      priceTags: (tags as unknown as { tag: string }[]).map((t) => t.tag),
      reasons: config["leads.bypassReasons"],
    });
  } catch (e) {
    return fromThrown(e);
  }
}

/** Convert. One transaction; everything a second-order conversion writes, plus the record of the bypass. */
export async function bypassConvertLead(raw: BypassInput): Promise<Result<{ id: string; name: string }>> {
  try {
    const ctx = await guard();
    if (!ctx) return err(OUTSIDE_ACCOUNTS, "not_permitted");

    const parsed = bypassSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? ""), message: i.message })));
    }
    const v = parsed.data;

    const config = await getConfig();
    const reasons = config["leads.bypassReasons"];
    if (!reasons.some((r) => r.code === v.reasonCode)) {
      return err("Pick a reason from the list.", "validation", [{ field: "reasonCode", message: "Pick a reason." }]);
    }
    if (v.creditLimitPaise !== null && !(await canFor(ctx.user, "payment.confirm"))) {
      return err("The credit limit is set by whoever confirms payments.", "not_permitted", [
        { field: "creditLimitPaise", message: "Leave it blank." },
      ]);
    }

    /* --- the seats ------------------------------------------------------- */
    const sales = await resolveSeat(v.sales, "sales account manager");
    if (typeof sales === "string") return err(sales, "validation", [{ field: "sales", message: sales }]);
    const backOffice = await resolveSeat(v.backOffice, "back office account manager");
    if (typeof backOffice === "string") return err(backOffice, "validation", [{ field: "backOffice", message: backOffice }]);
    let salesManager: ResolvedSeat = { userId: null, name: null };
    if (v.salesManager.kind !== "none") {
      if (!(await canFor(ctx.user, "customer.assignSalesManager"))) {
        return err("Setting the sales manager needs a manager or admin.", "not_permitted", [
          { field: "salesManager", message: "Leave it unassigned." },
        ]);
      }
      const resolved = await resolveSeat(v.salesManager, "sales manager");
      if (typeof resolved === "string") return err(resolved, "validation", [{ field: "salesManager", message: resolved }]);
      salesManager = resolved;
    }

    /* --- nobody else uses the number or the GSTIN ------------------------ */
    const numbers = [v.phone, v.whatsappPhone].filter(Boolean);
    const [byNumber] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(
        and(
          ne(customers.id, v.leadId),
          isNull(customers.deletedAt),
          or(
            inArray(customers.phone, numbers),
            inArray(customers.whatsappPhone, numbers),
            // `customers.id` spelled out — an interpolated column binds to the inner table.
            sql`exists (select 1 from customer_contacts cc where cc.customer_id = customers.id and cc.phone in ${numbers})`,
          ),
        ),
      )
      .limit(1);
    if (byNumber) {
      return err(`${byNumber.name} already uses that number.`, "duplicate", [{ field: "phone", message: `On ${byNumber.name}.` }]);
    }
    const gstin = v.gstNotRegistered ? null : v.gstin;
    if (gstin) {
      const [byGstin] = await db
        .select({ name: customers.name })
        .from(customers)
        .where(and(eq(customers.gstin, gstin), ne(customers.id, v.leadId), isNull(customers.deletedAt)))
        .limit(1);
      if (byGstin) {
        return err(`${byGstin.name} already has that GSTIN.`, "duplicate", [{ field: "gstin", message: `On ${byGstin.name}.` }]);
      }
    }

    const day = await today();
    const state = canonicalState(v.state);
    const reasonLabel = labelOf(reasons, v.reasonCode);
    const now = new Date();

    const outcome = await db.transaction(async (tx) => {
      // Locked, so two people pressing Convert at once convert once.
      const [lead] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, v.leadId))
        .for("update");
      if (!lead || lead.deletedAt) return { refused: "That lead no longer exists." } as const;
      if (lead.kind !== "lead") return { refused: `${lead.name} is already a customer.` } as const;
      if (lead.status === "deactivated") return { refused: `${lead.name} is deactivated. Reactivate it first.` } as const;

      const funnel = funnelPosition(lead.leadStage, lead.leadSalesType as LeadSalesType | null);
      const convertible = {
        id: lead.id,
        kind: "lead" as const,
        ownerId: lead.ownerId,
        salesAmId: lead.salesAmId,
        leadSource: lead.leadSource,
      };

      await tx
        .update(customers)
        .set({
          ...conversionColumns(convertible, day),
          // The details typed in the dialog.
          name: v.name,
          contactPerson: v.contactPerson,
          phone: v.phone,
          whatsappPhone: v.whatsappPhone || null,
          email: v.email || null,
          customerType: v.customerType,
          gstin,
          ...(gstinChangeClear(lead, gstin) ?? {}),
          address: v.address,
          city: v.city,
          region: state,
          creditTermDays: v.creditTermDays,
          // The nullable mirror — what says a person STATED the term.
          creditDays: v.creditTermDays,
          creditLimitPaise: v.creditLimitPaise,
          priceTag: v.priceTag,
          freightTerm: v.freightTerm,
          deliveryType: v.deliveryType,
          // A customer we invoice: never a third-party shop. Links stay as history.
          thirdParty: false,
          status: "active",
          // Whose book, and the mirrors with the ids. Decided, so the sheet keeps off.
          ownerId: sales.userId ?? lead.ownerId,
          salesAmId: sales.userId,
          salesPersonName: sales.name,
          backOfficeAmId: backOffice.userId,
          backOfficeName: backOffice.name,
          salesManagerId: salesManager.userId,
          salesManagerPersonName: salesManager.name,
          amDecidedAt: now,
          updatedById: ctx.user.id,
          updatedAt: now,
        })
        .where(eq(customers.id, lead.id));

      await tx.insert(leadStageTransitions).values({
        id: id("lst"),
        customerId: lead.id,
        fromStage: lead.leadStage,
        toStage: "won",
        salesType: lead.leadSalesType,
        kind: "overridden",
        reasonCode: v.reasonCode,
        note: v.note,
        overriddenConditions: funnel.skipped.map((s) => `stage:${s.stage}`),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
      });

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "customer.bypassConvert",
        entityType: "customer",
        entityId: lead.id,
        beforeState: {
          kind: "lead",
          leadStage: lead.leadStage,
          leadSalesType: lead.leadSalesType,
          thirdParty: lead.thirdParty,
          ownerId: lead.ownerId,
          name: lead.name,
          phone: lead.phone,
          gstin: lead.gstin,
        } as never,
        afterState: {
          ...v,
          confirm: undefined,
          gstin,
          state,
          sales: sales.name,
          backOffice: backOffice.name,
          salesManager: salesManager.name,
          skipped: funnel.skipped.map((s) => s.stage),
          reason: reasonLabel,
        } as never,
      });

      // The conversion's own audit row, timeline entry and handset tombstone.
      await recordConversion(tx, convertible, ctx.user.id, sales.userId, `bypassed in Accounts — ${reasonLabel}`);

      return { previousOwnerId: lead.ownerId } as const;
    });

    if ("refused" in outcome) return err(outcome.refused ?? "Could not convert.", "conflict");

    await reconcileContacts(v.leadId, ctx.user.id);
    await placeShopsNow([v.leadId]);

    const told = new Map<string, string>();
    if (outcome.previousOwnerId) told.set(outcome.previousOwnerId, "was your lead");
    if (sales.userId) told.set(sales.userId, "is now in your book");
    if (backOffice.userId && !told.has(backOffice.userId)) told.set(backOffice.userId, "has you on its back office");
    if (salesManager.userId && !told.has(salesManager.userId)) told.set(salesManager.userId, "has you as its sales manager");
    told.delete(ctx.user.id);
    if (told.size) {
      await notifyUsers(
        [...told].map(([userId, what]) => ({
          userId,
          title: `${v.name} is now a customer`,
          body: `${ctx.user.name} converted it directly in Accounts (${reasonLabel}) — it ${what}.`,
          href: `/crm/customers/${v.leadId}`,
        })),
      );
    }

    try {
      revalidatePath("/accounts", "layout");
      revalidatePath("/crm", "layout");
    } catch {
      /* no request context (tests, scripts) */
    }
    return ok({ id: v.leadId, name: v.name }, `${v.name} is now a customer`);
  } catch (e) {
    return fromThrown(e);
  }
}
