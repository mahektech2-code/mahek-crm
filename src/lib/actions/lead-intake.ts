"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customerDistributors, customers, notifications, users } from "@/db/schema";
import { canFor, requireCapability } from "@/lib/access-control";
import { LEAD_PRIORITIES } from "@/lib/lead-priority";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { err, fromThrown, ok, type Err, type FieldError, type Result } from "@/lib/result";
import { salesTypeIsOffered, salesTypeLabel, type LeadSalesType } from "@/lib/lead-labels";
import {
  enquiryForLeadConversion,
  EnquiryLeadConflict,
  linkEnquiryToNewLead,
} from "@/lib/services/enquiry-service";
import { notifyDeskAssigners } from "@/lib/services/lead-desk-assignment-service";
import {
  DUPLICATE_DISMISSED_ACTION,
  phoneAlreadyOnTheBook,
  phonesOnTheBook,
  type ExistingAccount,
} from "@/lib/services/lead-intake-service";

/* ---------------------------------------------------------------------------
 * The office's own way of raising a lead — screens 5, 34 and the one write
 * screen 7 is allowed to make.
 *
 * Until this existed a lead reached MahekOne two ways: a salesman raised one
 * standing in the shop, or the sheet projection produced one. Somebody at a
 * desk taking a telephone call had nowhere to put it, which is how a lead ends
 * up as a line in somebody's notebook and then as nothing at all.
 *
 * `captureLead` is the one genuinely new write the Lead Management release
 * needs, and everything else here is it applied to more rows or refused.
 *
 * FOUR RULES RUN THROUGH ALL OF IT, and each one is a scar somewhere else in
 * this codebase:
 *
 * **The sales type is never guessed.** Null is the fourth answer and it is
 * load-bearing — it means a lead nobody has decided a ladder for, and it
 * climbs the original six rungs. A capture that filled it in with the
 * commonest value would be a migration's worth of guessing done one row at a
 * time, and the ladder decides which GATES apply, so a wrong guess does not
 * mislabel a lead: it blocks the person working it.
 *
 * **§24 IS NO LONGER ASKED AT SCREEN 5, and that is deliberate.** A telecaller
 * capturing a call has no diary to promise a day from, and demanding one here
 * was the field this form lost people on. §24 still holds — the gate engine
 * refuses to move a lead off Suspect with nothing owed by anybody, exactly as
 * it already does for a lead this screen raises with no owner at all — so a
 * lead captured here is unowed until somebody at the desk or in the field
 * picks it up, the same as any other channel that does not know the answer
 * yet. Screen 34's bulk import kept its own copy of the question, because a
 * spreadsheet of a hundred rows is filled in by somebody who DOES have that
 * answer for each one.
 *
 * **`owner_id` is never the person doing the capturing.** A telecaller taking
 * a call is not the person who will walk to the shop, and on a file of a
 * thousand rows a defaulted owner reads as one person's book on every scoped
 * list. Unassigned is said in words on a team list; a false owner is not said
 * at all.
 *
 * **`active_in_order_system` is never written.** Migration `0021` had to clear
 * what an import last wrote to that column, because setting it on every row it
 * touched muted the entire calling book — a full database and an empty Call
 * Log, with the cause in a column no screen shows. Only
 * `recomputeOrderSystemHolds()` writes it, and nothing here goes near it.
 *
 * `lead.work` throughout, checked in the action: a server action is a URL, and
 * a hidden button is not a permission.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function refresh(customerId?: string) {
  try {
    revalidatePath("/sales/leads");
    revalidatePath("/sales/leads/intake");
    revalidatePath("/sales/leads/intake/duplicates");
    if (customerId) revalidatePath(`/sales/leads/${customerId}`);
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

function zodErr(error: z.ZodError): Err {
  const fieldErrors: FieldError[] = error.issues.map((i) => ({
    field: i.path.join(".") || "form",
    message: i.message,
  }));
  return err(fieldErrors[0]?.message ?? "Check the form.", "validation", fieldErrors);
}

/* ═════════════════════════════════════════════ screen 5 — one lead, by hand */

/*
 * The shape the wire may carry, which is NOT the same list as the shape a new
 * lead may be raised on. `distributor` stays here so a request naming it is
 * refused in a sentence that says why and what to do instead, rather than by a
 * zod enum error reading "invalid enum value" — the check is a few lines into
 * `captureLead`.
 */
const SALES_TYPES = ["direct", "distributor", "third_party"] as const;
const CUSTOMER_TYPES = ["dealer", "manufacturer", "distributor", "retailer"] as const;

/**
 * §24's four answers. A DATE STRING, never a JS `Date`: `lead_next_action_date`
 * is a stored date, and binding a `Date` into a query throws inside the driver
 * where no type check can see it.
 */
const nextActionSchema = z.object({
  action: z.string().trim().min(1, "Say what happens next.").max(300),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date."),
  ownerId: z.string().min(1, "Somebody has to owe this."),
  outcome: z.string().trim().max(500).optional(),
});

const captureSchema = z.object({
  /*
   * Optional, and `null` is a real answer rather than a missing one — see the
   * header. `undefined` and `null` both mean "nobody has said", which is why
   * there is no default here to fall back to.
   */
  salesType: z.enum(SALES_TYPES).nullable().optional(),

  name: z.string().trim().min(2, "The shop needs a name.").max(200),
  companyName: z.string().trim().max(200).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  /** The customer's own address, where they gave one. Optional: a phone call often has none. */
  email: z.string().trim().max(200).email("That is not an email address.").optional().or(z.literal("")),
  phone: z
    .string()
    .trim()
    .refine((v) => v.replace(/[^0-9]/g, "").length >= 10, "A ten-digit mobile."),
  city: z.string().trim().min(2, "Which town?").max(120),
  address: z.string().trim().max(500).optional(),
  source: z.string().trim().min(1, "Where did this come from?").max(120),
  /**
   * The sentence behind `other`. Validated against the CONFIGURED list below
   * rather than a literal, because the source list is a manager's to edit.
   */
  sourceDetail: z.string().trim().max(200).optional(),
  customerType: z.enum(CUSTOMER_TYPES).nullable().optional(),

  /*
   * §6's four, captured OPTIONALLY. This is a telephone call and not a visit:
   * the gate demands them at the rung where they matter, and demanding them
   * here loses the lead rather than improving it.
   *
   * Litres, not cans — the one place in MahekOne where cans do not win. There
   * is no SKU at capture, so a can is a unit nobody has agreed the size of.
   */
  monthlyLitres: z.number().int().positive().max(1_000_000).nullable().optional(),
  competitor: z.string().trim().max(200).optional(),
  /*
   * What they want, IN THEIR OWN WORDS, and deliberately not a product id.
   * Resolving "thinner for a spray booth" to a SKU while somebody is on the
   * phone is the person capturing guessing on the customer's behalf, and
   * `lead_required_product_id` is a foreign key that would then be wrong with
   * nothing saying so. `leadRequirement` is the column for this.
   */
  requirement: z.string().trim().max(500).optional(),
  application: z.string().trim().max(200).optional(),

  /** Who it belongs to. Absent means UNASSIGNED, which is a real answer. */
  ownerId: z.string().min(1).nullable().optional(),

  /**
   * §24's four answers, still accepted here because `captureLeadBatch`
   * (screen 34) reuses this same writer for every row of a file, with one
   * batch-wide answer. Screen 5's own form no longer asks for it — see the
   * file header — so a desk capture simply never sends one.
   */
  nextAction: nextActionSchema.optional(),

  /**
   * §23 — WHO BILLS THIS SHOP, asked at capture rather than reconstructed at
   * conversion. Meaningful only on the third-party ladder; the action ignores
   * it for anything else, because the picker itself only draws it there.
   * Validated against the same rule `convertToThirdParty` enforces — a direct
   * customer, not itself marked third-party — so a stale tab cannot name an
   * account that could never actually bill a shop.
   */
  distributorCustomerId: z.string().min(1).nullable().optional(),

  /**
   * Set only after the person has been shown the account this telephone number
   * already reaches and has said it is a different shop. Two counters of one
   * business under one number is real; what must not happen is a second row
   * arriving silently, because MahekOne cannot merge two of them back.
   */
  allowDuplicate: z.boolean().optional(),

  notes: z.string().trim().max(2000).optional(),

  /**
   * RAISED FROM A WEBSITE ENQUIRY. Set only by the enquiry screen's Create lead,
   * and it changes three things and nothing else: the source is the enquiry's
   * own (the client's `source` and `sourceDetail` are ignored, so a stale tab
   * cannot claim a channel the enquiry did not come from), the enquiry must be
   * one that may become a lead and must not already have one, and the enquiry
   * is pointed at the new lead in the SAME transaction. Everything else — the
   * duplicate guard, the Suspect rung, the audit, the timeline — is this
   * function's own, which is the point: there is one way to raise a lead.
   */
  fromEnquiry: z.object({ enquiryId: z.string().min(1) }).optional(),

  /**
   * How hard the team should push this one — the MANAGER'S judgement, and
   * `setLeadPriority` holds it to `lead.verify`. Accepted here only from
   * somebody who holds that too (checked below, not just by hiding the field),
   * because otherwise raising a lead would be a way round the one capability
   * that decides who may say it.
   */
  priority: z.enum(LEAD_PRIORITIES).nullable().optional(),
});

export type CaptureLeadInput = z.input<typeof captureSchema>;

export type CapturedLead = {
  customerId: string;
  /** What it was raised at — `suspect`, or `new` where no ladder was chosen. */
  stage: "suspect" | "new";
};

/**
 * Raise a lead from a desk.
 *
 * The stage is the foot of whichever ladder was chosen: `suspect` for all three
 * real ones, `new` for the legacy six where nobody chose. That mirrors what the
 * handset's own lead handler does, deliberately — a lead raised at a desk and
 * one raised in a shop are the same record and must not start life on different
 * rungs depending on which door they came through.
 */
export async function captureLead(
  input: CaptureLeadInput,
): Promise<Result<CapturedLead>> {
  try {
    const parsed = captureSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    let v = parsed.data;

    const ctx = await requireCapability("lead.work");
    const config = await getConfig();

    /* An enquiry's own facts win over what the form sent for them. */
    if (v.fromEnquiry) {
      const found = await enquiryForLeadConversion(v.fromEnquiry.enquiryId);
      if (!found.ok) return found;
      v = { ...v, source: found.data.leadSource, sourceDetail: found.data.sourceDetail };
    }

    /*
     * THE SOURCE IS ONE OF THE CONFIGURED TEN, AND "OTHER" HAS TO SAY WHAT.
     *
     * Checked against `leads.sources` rather than a literal, so a manager who
     * adds an eleventh channel on the Settings screen does not have to wait for
     * a deploy — and so a code retired there stops being accepted here on the
     * same afternoon.
     *
     * Enforced in the action and not only in the form, because a server action
     * is a URL: a stale tab and a replayed request both still reach this.
     *
     * The detail is required on `other` for the reason `other` exists at all:
     * it is the easiest answer on any dropdown, it costs nothing to pick, and
     * left free it becomes the biggest bar on the chart with nothing behind it.
     * A sentence is what makes it get picked when it is true, and the sentences
     * are what tell Mahek which eleventh source is worth adding to the list.
     */
    if (v.priority && !(await canFor(ctx.user, "lead.verify"))) {
      return err(
        "Priority is set by a manager. Raise the lead without it and ask them to set it.",
        "not_permitted",
        [{ field: "priority", message: "Set by a manager." }],
      );
    }

    const sources = config["leads.sources"];
    if (!sources.some((o) => o.code === v.source)) {
      return err(
        `"${v.source}" is not one of the sources we record. Pick one from the list.`,
        "validation",
        [{ field: "source", message: "Pick where this came from." }],
      );
    }
    if (v.source === "other" && !v.sourceDetail?.trim()) {
      return err(
        "Say where this one actually came from. \u201cOther\u201d with nothing behind it is a source nobody can count later.",
        "validation",
        [{ field: "sourceDetail", message: "Where did it come from?" }],
      );
    }

    /*
     * A RETIRED LADDER IS REFUSED HERE AND NOT ONLY IN THE PICKER, because a
     * server action is a URL: the intake form no longer draws a Distributor
     * chip, and a stale tab, a replayed request or a bulk file still can name
     * one. Mahek's decision is that distributors are not appointed through
     * MahekOne — see `SALES_TYPES` in `lib/lead-labels.ts` for what starting a
     * lead on that ladder cost. It says nothing about the leads already on it,
     * which keep every rung, gate and answer they have; this door is only ever
     * asked about a lead being raised NOW.
     */
    if (v.salesType && !salesTypeIsOffered(v.salesType)) {
      return err(
        `${salesTypeLabel(v.salesType)} is no longer a ladder a new lead can be raised on. Raise them as a direct or third-party customer — the leads already on it are untouched.`,
        "rule_violation",
        [{ field: "salesType", message: "No longer offered." }],
      );
    }

    /* The picker is not a permission: the owner, and whoever a next action is
       owed by (screen 34's batch-wide answer, riding through per row), both
       have to be somebody who can sign in and see it. */
    const idsToCheck = [v.ownerId, v.nextAction?.ownerId].filter(
      (id): id is string => Boolean(id),
    );
    for (const id of Array.from(new Set(idsToCheck))) {
      const [u] = await db
        .select({ id: users.id, active: users.active })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!u || !u.active) {
        return err(
          "That person cannot sign in, so nothing can be owed by them.",
          "validation",
          [{ field: id === v.ownerId ? "ownerId" : "nextAction.ownerId", message: "Not an active account." }],
        );
      }
    }

    /*
     * "UNDER" IS THE THIRD-PARTY LADDER'S OWN QUESTION, so it is validated only
     * there — the picker offers nothing on the other two ladders, and a stray
     * value from a stale tab is ignored rather than refused. Where it is
     * meaningful the rule is `convertToThirdParty`'s own: an account we bill
     * ourselves, `kind = 'customer'`, not itself marked third-party, and not
     * deactivated — the same three sentences, so a distributor good enough to
     * be named here is good enough to survive conversion.
     */
    const distributorId =
      v.salesType === "third_party" ? (v.distributorCustomerId ?? null) : null;
    if (distributorId) {
      const [d] = await db
        .select({
          id: customers.id,
          name: customers.name,
          kind: customers.kind,
          thirdParty: customers.thirdParty,
          status: customers.status,
        })
        .from(customers)
        .where(eq(customers.id, distributorId))
        .limit(1);
      if (!d) {
        return err(
          "That account no longer exists.",
          "validation",
          [{ field: "distributorCustomerId", message: "Not found." }],
        );
      }
      if (d.kind !== "customer" || d.thirdParty) {
        return err(
          `${d.name} cannot bill a shop — a distributor is an account we invoice directly.`,
          "rule_violation",
          [{ field: "distributorCustomerId", message: "Not a direct customer." }],
        );
      }
      if (d.status === "deactivated") {
        return err(
          `${d.name} is deactivated, so it cannot be named as who bills this shop.`,
          "rule_violation",
          [{ field: "distributorCustomerId", message: "Deactivated." }],
        );
      }
    }

    let existing: ExistingAccount | null = null;
    if (!v.allowDuplicate) {
      existing = await phoneAlreadyOnTheBook(v.phone);
      if (existing) {
        return err(
          `${existing.name}${existing.city ? ` in ${existing.city}` : ""} is already on the book with this number. Raising a second row cannot be undone — MahekOne has no way to merge two customer records.`,
          "duplicate",
          [{ field: "phone", message: "Already on the book." }],
        );
      }
    }

    const day = await today();
    const customerId = gen("cus");
    const foot: "suspect" | "new" = v.salesType ? "suspect" : "new";

    await db.transaction(async (tx) => {
      await tx.insert(customers).values({
        id: customerId,
        name: v.name,
        companyName: v.companyName || null,
        contactPerson: v.contactPerson || null,
        email: v.email || null,
        phone: v.phone,
        city: v.city,
        address: v.address || null,
        kind: "lead",
        leadSource: v.source,
        /* Kept even where the source is later changed away from `other`: it is
           a record of what somebody believed on the day they raised it. */
        leadSourceDetail: v.sourceDetail?.trim() || null,

        /* Absent means unassigned, and unassigned is said in words on every
           team list. It is NEVER `ctx.user.id` — see the file header. */
        ownerId: v.ownerId ?? null,

        leadSalesType: v.salesType ?? null,
        leadStage: foot,
        /* The console ages every list by this. A null would read as a lead
           that has been standing on this rung since the epoch. */
        leadStageSince: day,
        leadLastActivityDate: day,
        leadNotes: v.notes || null,

        customerType: v.customerType ?? null,
        leadMonthlyVolumeLitres: v.monthlyLitres ?? null,
        leadCompetitor: v.competitor || null,
        leadRequirement: v.requirement || null,
        leadApplication: v.application || null,
        leadPriority: v.priority ?? null,

        /* §24, where somebody answered it — screen 34's batch-wide next
           action, riding through this shared writer one row at a time. */
        leadNextAction: v.nextAction?.action ?? null,
        leadNextActionDate: v.nextAction?.date ?? null,
        leadNextActionOwnerId: v.nextAction?.ownerId ?? null,
        leadNextActionOutcome: v.nextAction?.outcome || null,
      });

      /*
       * §23 — WHO BILLS THIS SHOP, in the same transaction as the lead it
       * describes. Validated above; `distributorId` is already narrowed to the
       * third-party ladder and to an eligible account. `isPrimary` is true
       * because this is the only distributor named for a lead this new — there
       * is nothing yet for it to conflict with.
       */
      if (distributorId) {
        await tx.insert(customerDistributors).values({
          id: gen("cd"),
          customerId,
          distributorCustomerId: distributorId,
          isPrimary: true,
          /* Said the way the handset's own write says it, so the panel on the
             record shows where the arrangement came from. */
          note: "Named when the lead was raised",
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
      }

      /*
       * §R — where the account began, on the shared stream, in the SAME
       * transaction as the row it describes. A timeline entry for a lead that
       * rolled back is a lead somebody reads about and cannot open.
       *
       * `MBOS_EVENT.leadCreated` rather than a literal: the natural key is
       * built from this string, and a spelling that drifts by one character
       * makes a second stream that can never deduplicate against itself. It is
       * written under `crm` because that is the app somebody pressed the button
       * in, which keeps a desk capture and a handset capture of one shop
       * distinguishable on the record.
       */
      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.leadCreated,
        sourceApp: "crm",
        sourceRecordId: customerId,
        occurredAt: new Date(),
        actorUserId: ctx.user.id,
        summary: `Lead raised at the desk — ${salesTypeLabel(v.salesType ?? null)}, from ${v.source}`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.captured",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: null,
        afterState: {
          name: v.name,
          city: v.city,
          source: v.source,
          salesType: v.salesType ?? null,
          stage: foot,
          ownerId: v.ownerId ?? null,
          nextActionOwnerId: v.nextAction?.ownerId ?? null,
          distributorCustomerId: distributorId,
          duplicateAllowed: Boolean(v.allowDuplicate),
          fromEnquiryId: v.fromEnquiry?.enquiryId ?? null,
        },
      });

      /* Last, inside the same transaction: if the enquiry already has a lead
         this throws, and the lead above is undone with it. */
      if (v.fromEnquiry) {
        await linkEnquiryToNewLead(tx, {
          enquiryId: v.fromEnquiry.enquiryId,
          customerId,
          leadName: v.name,
          actorId: ctx.user.id,
        });
      }
    });

    /*
     * Both seats are told, and it is not a courtesy: work has arrived on
     * somebody's list without them asking, and the first they would otherwise
     * know is a lead ageing against their name. Outside the transaction and
     * unable to fail it — a lead is never lost to a notification. Nobody is
     * told what they just did themselves.
     */
    const told = new Set<string>();
    for (const [userId, title, body] of [
      [
        v.ownerId,
        `A lead was raised for you: ${v.name}`,
        `${v.city}${v.contactPerson ? ` — ${v.contactPerson}` : ""}. Raised from ${v.source}.`,
      ],
      [
        v.nextAction?.ownerId,
        `Next action on ${v.name}`,
        v.nextAction ? `${v.nextAction.action} — due ${v.nextAction.date}.` : "",
      ],
    ] as const) {
      if (!userId || userId === ctx.user.id || told.has(userId)) continue;
      told.add(userId);
      await db
        .insert(notifications)
        .values({
          id: gen("ntf"),
          userId,
          title,
          body,
          kind: "info",
          href: `/sales/leads/${customerId}`,
        })
        .catch(() => {});
    }

    if (v.fromEnquiry) {
      try {
        revalidatePath("/enquiries");
        revalidatePath("/enquiries/list");
        revalidatePath(`/enquiries/list/${v.fromEnquiry.enquiryId}`);
      } catch {
        /* no request context */
      }
      /* An unowned lead is on nobody's desk, so whoever assigns is told it is waiting. */
      if (!v.ownerId) {
        await notifyDeskAssigners({ customerId, leadName: v.name, byUserId: ctx.user.id }).catch(() => {});
      }
    }

    refresh(customerId);
    return ok(
      { customerId, stage: foot },
      v.fromEnquiry && !v.ownerId
        ? "Lead created from the enquiry. It has no owner yet, so it is not on anybody's calling desk until it is assigned."
        : v.salesType
        ? "Lead raised as a Suspect."
        : "Lead raised. No sales type was chosen, so it climbs the original six rungs until somebody sets one.",
    );
  } catch (e) {
    if (e instanceof EnquiryLeadConflict) return err(e.message, "conflict");
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════ screen 34 — a file of them */

/** One row as the file gave it, before anything has been made of it. */
export type BulkRow = Record<string, string>;

export type BulkRowVerdict = {
  /** 1-based, counting the header as row 1, so it matches what the sheet shows. */
  row: number;
  name: string;
  phone: string;
  city: string;
  salesType: LeadSalesType | null;
  source: string;
  /** Why this row cannot go in. Empty means it can. */
  problems: string[];
  /** The account this row's telephone already reaches, where there is one. */
  existing: { id: string; name: string; city: string | null; kind: string } | null;
  /** Another row of the SAME file carrying this telephone number. */
  repeatOfRow: number | null;
};

export type BulkPreview = {
  rows: BulkRowVerdict[];
  ready: number;
  blocked: number;
  /** True where §24 is switched on and the batch therefore needs an action. */
  nextActionRequired: boolean;
};

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  shop: "name",
  shopname: "name",
  company: "companyName",
  companyname: "companyName",
  contact: "contactPerson",
  contactperson: "contactPerson",
  phone: "phone",
  mobile: "phone",
  city: "city",
  town: "city",
  address: "address",
  source: "source",
  leadsource: "source",
  salestype: "salesType",
  customertype: "customerType",
  litres: "monthlyLitres",
  monthlylitres: "monthlyLitres",
  competitor: "competitor",
  product: "requirement",
  requirement: "requirement",
  application: "application",
};

/** Header matching is forgiving about case, spaces and underscores only. */
function normalised(row: BulkRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(row)) {
    const key = HEADER_ALIASES[k.toLowerCase().replace(/[\s_-]/g, "")];
    if (key && value != null && String(value).trim()) out[key] = String(value).trim();
  }
  return out;
}

function readSalesType(raw: string | undefined): {
  value: LeadSalesType | null;
  problem: string | null;
} {
  if (!raw) return { value: null, problem: null };
  const v = raw.toLowerCase().replace(/[\s_-]/g, "");
  if (v === "direct" || v === "directcustomer") return { value: "direct", problem: null };
  if (v === "thirdparty" || v === "thirdpartycustomer")
    return { value: "third_party", problem: null };
  /*
   * A word this column used to accept, and the row is REFUSED rather than read
   * as blank. Mahek withdrew the distributor ladder for new leads — the note on
   * `SALES_TYPES` has the reasoning — and a file written before that says
   * "distributor" in perfectly good faith. Reading it as "nobody decided" would
   * raise the lead on the legacy six rungs with nothing anywhere recording that
   * a ladder somebody typed had been thrown away, which is the exact failure
   * the unrecognised-word branch below exists to prevent.
   */
  if (v === "distributor") {
    return {
      value: null,
      problem:
        "Distributor is no longer a ladder a new lead can be raised on — Mahek does not appoint distributors through MahekOne. Use direct or third_party, or leave it empty. Leads already on that ladder are untouched.",
    };
  }
  /*
   * NOT silently null. An unrecognised word in this column is somebody having
   * MEANT a ladder, and reading it as "nobody said" would put the lead on the
   * legacy six rungs with nothing anywhere recording that a spelling was
   * thrown away. Blank is the only thing that means nobody said.
   */
  return {
    value: null,
    problem: `"${raw}" is not a sales type. Use direct or third_party — or leave it empty, which means nobody has decided.`,
  };
}

/**
 * What the file would do, without doing any of it.
 *
 * It is a SERVER action although it writes nothing, and that is deliberate: the
 * rules a row is judged by are the rules `captureLeadBatch` applies, and a copy
 * of them typed into the browser to make a preview would drift inside one
 * release — with the half that drifts being the half somebody is reading before
 * they press the button. The browser parses the file; the server is the only
 * thing that says what a row means.
 */
export async function previewBulkIntake(rows: BulkRow[]): Promise<Result<BulkPreview>> {
  try {
    await requireCapability("lead.work");
    const config = await getConfig();

    const parsedRows = rows.map(normalised);
    const onTheBook = await phonesOnTheBook(parsedRows.map((r) => r.phone ?? ""));

    const seen = new Map<string, number>();
    const verdicts: BulkRowVerdict[] = parsedRows.map((r, i) => {
      const row = i + 2; /* the header is row 1 in the sheet somebody is looking at */
      const problems: string[] = [];

      if (!r.name || r.name.length < 2) problems.push("No shop name.");
      const digits = (r.phone ?? "").replace(/[^0-9]/g, "");
      if (digits.length < 10) problems.push("No ten-digit telephone number.");
      if (!r.city) problems.push("No town.");
      if (!r.source) problems.push("No source — where did this lead come from?");

      const type = readSalesType(r.salesType);
      if (type.problem) problems.push(type.problem);

      if (r.monthlyLitres && !/^\d+$/.test(r.monthlyLitres.replace(/[\s,]/g, ""))) {
        problems.push("Monthly litres is not a whole number.");
      }

      const key = digits.length >= 10 ? digits.slice(-10) : "";
      const existing = key ? (onTheBook.get(key) ?? null) : null;
      if (existing) {
        problems.push(
          `${existing.name} is already on the book with this number. There is no way to merge two records, so this row is left out.`,
        );
      }

      let repeatOfRow: number | null = null;
      if (key) {
        const first = seen.get(key);
        if (first != null) {
          repeatOfRow = first;
          problems.push(`The same number is on row ${first} of this file.`);
        } else {
          seen.set(key, row);
        }
      }

      return {
        row,
        name: r.name ?? "",
        phone: r.phone ?? "",
        city: r.city ?? "",
        salesType: type.value,
        source: r.source ?? "",
        problems,
        existing: existing
          ? { id: existing.id, name: existing.name, city: existing.city, kind: existing.kind }
          : null,
        repeatOfRow,
      };
    });

    return ok({
      rows: verdicts,
      ready: verdicts.filter((v) => !v.problems.length).length,
      blocked: verdicts.filter((v) => v.problems.length).length,
      nextActionRequired: config["leads.requireNextAction"],
    });
  } catch (e) {
    return fromThrown(e);
  }
}

export type BulkSummary = {
  created: number;
  /** Row number and why, so the file can be fixed and offered again. */
  skipped: Array<{ row: number; name: string; problem: string }>;
};

const batchSchema = z.object({
  /**
   * §24 asked ONCE for the whole file, because a CSV does not carry it.
   *
   * This is the half of bulk intake that had to be designed rather than
   * copied: the rule demands an action, a day, a person and what that person
   * comes back with, and a spreadsheet of leads names none of them. The
   * choices were to invent one per row, to switch the rule off for imports, or
   * to make the person importing state it once and stand behind it. The first
   * two are how a thousand leads land owing nothing to anybody.
   */
  nextAction: nextActionSchema.optional(),
  /** Whose book these join. Absent means unassigned — see the file header. */
  ownerId: z.string().min(1).nullable().optional(),
});

/**
 * Write the rows the preview said were ready, and nothing else.
 *
 * Row by row rather than one transaction for the file: a file of four hundred
 * that dies on row three hundred and ninety-nine must not throw away the three
 * hundred and ninety-eight that were fine, and every row is independent — a
 * lead is not half of anything. Each row is still ONE transaction of its own,
 * because the lead, its §24 answer and its timeline entry are one act.
 *
 * It RE-VALIDATES rather than trusting the preview it was given. A server
 * action is a URL, the browser holds the parsed rows between the two calls, and
 * the book can change underneath in between — a shop raised by a salesman while
 * somebody was reading a preview is exactly the duplicate this refuses.
 */
export async function captureLeadBatch(
  rows: BulkRow[],
  batch: z.input<typeof batchSchema>,
): Promise<Result<BulkSummary>> {
  try {
    const parsedBatch = batchSchema.safeParse(batch);
    if (!parsedBatch.success) return zodErr(parsedBatch.error);
    const b = parsedBatch.data;

    await requireCapability("lead.work");
    const config = await getConfig();
    if (config["leads.requireNextAction"] && !b.nextAction) {
      return err(
        "Every lead in this file would land owing nothing to anybody. Say what happens next, on what day, and who is doing it — once, for the whole file.",
        "rule_violation",
        [{ field: "nextAction.action", message: "Required." }],
      );
    }

    const preview = await previewBulkIntake(rows);
    if (!preview.ok) return preview;

    const parsedRows = rows.map(normalised);
    const summary: BulkSummary = { created: 0, skipped: [] };

    for (const [i, verdict] of preview.data.rows.entries()) {
      if (verdict.problems.length) {
        summary.skipped.push({
          row: verdict.row,
          name: verdict.name || "(no name)",
          problem: verdict.problems[0],
        });
        continue;
      }
      const r = parsedRows[i];

      const written = await captureLead({
        salesType: verdict.salesType,
        name: r.name,
        companyName: r.companyName,
        contactPerson: r.contactPerson,
        phone: r.phone,
        city: r.city,
        address: r.address,
        source: r.source,
        customerType:
          r.customerType &&
          (CUSTOMER_TYPES as readonly string[]).includes(r.customerType.toLowerCase())
            ? (r.customerType.toLowerCase() as (typeof CUSTOMER_TYPES)[number])
            : null,
        monthlyLitres: r.monthlyLitres
          ? Number(r.monthlyLitres.replace(/[\s,]/g, ""))
          : null,
        competitor: r.competitor,
        requirement: r.requirement,
        application: r.application,
        /* NEVER the person running the import. The whole file lands unassigned
           unless somebody named a salesman on the screen. */
        ownerId: b.ownerId ?? null,
        nextAction: b.nextAction,
      });

      if (written.ok) summary.created += 1;
      else
        summary.skipped.push({
          row: verdict.row,
          name: verdict.name || "(no name)",
          problem: written.error,
        });
    }

    refresh();
    return ok(
      summary,
      `${summary.created} lead${summary.created === 1 ? "" : "s"} raised.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ════════════════════════════ screen 7 — the only write a duplicate allows */

/**
 * "These two are different shops."
 *
 * The ONLY action on the duplicates screen, and the reason is on the screen
 * itself in words: there is no merge in MahekOne. Merging two `customers` rows
 * means deciding what becomes of two sets of orders, bills, receipts, visits,
 * tasks, timeline entries and — the one that is a business decision rather than
 * a technical one — two append-only `lead_stage_transitions` histories. A
 * screen that offered a Merge button it could not honour would be worse than
 * one that offers nothing.
 *
 * IT IS RECORDED IN `audit_log`, AND THAT IS INTERIM. A dismissal is state — it
 * is read back by `duplicateCandidates` to keep the pair off the screen — and
 * state does not belong in a log, which is a record of what people did rather
 * than a table anybody queries by. It is here because the proper home is the
 * `customer_merges` table this release may not create, and the alternatives
 * were worse: a dismissal held in the browser lasts until the tab closes and
 * the same eleven pairs are back tomorrow, and a screen whose only control does
 * nothing is a screen people learn to distrust. When `customer_merges` lands,
 * this moves, and the rows already written are readable and carry the person,
 * the reason and the moment.
 *
 * The key is `<lower id>:<higher id>`, sorted, because a pair dismissed from
 * one direction must stay dismissed when the detection happens to present it
 * from the other.
 */
export async function dismissDuplicatePair(
  a: string,
  b: string,
  reason: string,
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        a: z.string().min(1),
        b: z.string().min(1),
        reason: z
          .string()
          .trim()
          .min(3, "Say why they are different — the next person to see this pair reads it.")
          .max(500),
      })
      .safeParse({ a, b, reason });
    if (!parsed.success) return zodErr(parsed.error);

    const ctx = await requireCapability("lead.work");

    const [left, right] = [parsed.data.a, parsed.data.b].sort();
    const key = `${left}:${right}`;

    /* Both sides have to exist. A dismissal naming a record that is not there
       is a row nobody can ever interpret, and the pair it was meant to silence
       would go on being offered. */
    const found = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.id, left));
    const other = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.id, right));
    if (!found.length || !other.length) {
      return err("One of those records is no longer on the book.", "not_found");
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: ctx.user.id,
      action: DUPLICATE_DISMISSED_ACTION,
      entityType: "customer_pair",
      entityId: key,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      beforeState: null,
      afterState: {
        left: { id: left, name: found[0].name },
        right: { id: right, name: other[0].name },
        reason: parsed.data.reason,
      },
    });

    refresh();
    return ok(null, "Marked as two different shops.");
  } catch (e) {
    return fromThrown(e);
  }
}
