import { z } from "zod";
import { isKnownState, canonicalState } from "@/lib/india-states";
import { checkGstin, gstState } from "@/lib/engines/lead-scan";
import { foldStage, ladderFor, TERMINAL_STAGES } from "@/lib/engines/lead-ladder";
import { stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import { seatSchema } from "@/lib/new-customer";

/* ---------------------------------------------------------------------------
 * CONVERTING A LEAD STRAIGHT TO A CUSTOMER — the Accounts bypass. PURE and
 * client-safe: the dialog and `bypassConvertLead` read the same rules.
 *
 * The ordinary way a lead becomes a customer is the funnel: Prospect,
 * Qualification, Sample / Trial, Negotiation, then its second approved order
 * converts it (`lead-conversion-service.ts`). Sometimes the shop is ready to be
 * billed before any of that is written down, and the ledger desk needs the
 * account now. The bypass is that door, and it is a RECORDED one: the steps it
 * skips, the reason and the person are kept on the stage history, the audit
 * log and the timeline.
 *
 * What it asks is everything an invoiced account needs to work the day it is
 * saved — stricter than "Add customer", because a bypass skips the very
 * conversations where those answers are usually collected:
 *
 *   contact   — bill name, contact person, mobile, type of business
 *   tax       — GSTIN whose state code matches the state, or "not registered"
 *               with a reason; billing address, city, state
 *   account   — sales account manager, credit days, price list, freight,
 *               delivery
 *   bypass    — a coded reason, a note, and CONVERT typed back
 * ------------------------------------------------------------------------- */

export const BYPASS_CONFIRM_WORD = "CONVERT";
export const BYPASS_NOTE_MIN = 10;

export const BYPASS_CUSTOMER_TYPES = ["dealer", "retailer", "distributor", "manufacturer"] as const;
export const BYPASS_FREIGHT = ["paid", "to_pay"] as const;
export const BYPASS_DELIVERY = ["Door Delivery", "Godown Delivery"] as const;

const mobile = /^[6-9]\d{9}$/;

export const bypassSchema = z
  .object({
    leadId: z.string().min(1),

    name: z.string().trim().min(2, "Enter the business name as on the bill.").max(200),
    contactPerson: z.string().trim().min(2, "Enter the contact person.").max(120),
    phone: z.string().trim().regex(mobile, "Enter a 10-digit mobile number."),
    whatsappPhone: z
      .string()
      .trim()
      .refine((v) => v === "" || mobile.test(v), "Enter a 10-digit mobile, or leave it blank.")
      .default(""),
    email: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "That email does not look complete.")
      .default(""),
    customerType: z.enum(BYPASS_CUSTOMER_TYPES, { message: "Pick the type of business." }),

    gstin: z.string().trim().toUpperCase().default(""),
    gstNotRegistered: z.boolean().default(false),
    gstNotRegisteredReason: z.string().trim().max(300).default(""),
    address: z.string().trim().min(5, "Enter the billing address.").max(500),
    city: z.string().trim().min(2, "Enter the city.").max(120),
    state: z.string().trim().refine((v) => isKnownState(v), "Pick the state."),

    sales: seatSchema,
    backOffice: seatSchema.default({ kind: "none" }),
    salesManager: seatSchema.default({ kind: "none" }),
    creditTermDays: z.coerce
      .number({ message: "Enter the credit days." })
      .int("Credit days are a whole number.")
      .min(0, "Credit days cannot be negative.")
      .max(180, "Credit days are at most 180."),
    creditLimitPaise: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
    priceTag: z.string().trim().min(1, "Pick the price list.").max(120),
    freightTerm: z.enum(BYPASS_FREIGHT, { message: "Pick who pays the freight." }),
    deliveryType: z.enum(BYPASS_DELIVERY, { message: "Pick the delivery." }),

    reasonCode: z.string().trim().min(1, "Pick a reason."),
    note: z.string().trim().min(BYPASS_NOTE_MIN, `Write at least ${BYPASS_NOTE_MIN} characters.`).max(1000),
    confirm: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (v.sales.kind === "none") {
      ctx.addIssue({ code: "custom", path: ["sales"], message: "Pick the sales account manager." });
    }
    if (v.whatsappPhone && v.whatsappPhone === v.phone) {
      ctx.addIssue({ code: "custom", path: ["whatsappPhone"], message: "Leave it blank — it is the mobile." });
    }
    if (v.gstNotRegistered) {
      if (v.gstNotRegisteredReason.length < 5) {
        ctx.addIssue({ code: "custom", path: ["gstNotRegisteredReason"], message: "Say why there is no GSTIN." });
      }
    } else {
      const checked = v.gstin ? checkGstin(v.gstin) : null;
      if (!v.gstin) {
        ctx.addIssue({ code: "custom", path: ["gstin"], message: "Enter the GSTIN, or tick Not registered." });
      } else if (checked?.check !== "valid") {
        ctx.addIssue({ code: "custom", path: ["gstin"], message: "That GSTIN does not check out." });
      } else if (isKnownState(v.state)) {
        const fromGst = gstState(v.gstin);
        if (fromGst && canonicalState(fromGst) !== canonicalState(v.state)) {
          ctx.addIssue({ code: "custom", path: ["state"], message: `The GSTIN is registered in ${fromGst}.` });
        }
      }
    }
    if (v.confirm.toUpperCase() !== BYPASS_CONFIRM_WORD) {
      ctx.addIssue({ code: "custom", path: ["confirm"], message: `Type ${BYPASS_CONFIRM_WORD}.` });
    }
  });

export type BypassInput = z.input<typeof bypassSchema>;
export type BypassValues = z.output<typeof bypassSchema>;

export type BypassStep = "lead" | "details" | "account" | "confirm";

/** Which step of the dialog a field lives on, so a refusal opens it. */
export const BYPASS_STEP_OF: Record<string, BypassStep> = {
  leadId: "lead",
  name: "details",
  contactPerson: "details",
  phone: "details",
  whatsappPhone: "details",
  email: "details",
  customerType: "details",
  gstin: "details",
  gstNotRegistered: "details",
  gstNotRegisteredReason: "details",
  address: "details",
  city: "details",
  state: "details",
  sales: "account",
  backOffice: "account",
  salesManager: "account",
  creditTermDays: "account",
  creditLimitPaise: "account",
  priceTag: "account",
  freightTerm: "account",
  deliveryType: "account",
  reasonCode: "confirm",
  note: "confirm",
  confirm: "confirm",
};

/** The fields each step owns — what "Next" checks before moving on. */
export function fieldsOfStep(step: BypassStep): string[] {
  return Object.entries(BYPASS_STEP_OF)
    .filter(([, s]) => s === step)
    .map(([f]) => f);
}

export type FunnelPosition = {
  /** Rungs already behind the lead, in order — the one it stands on is not finished. */
  passed: { stage: LeadStage; label: string }[];
  /** Its current rung and every working rung above it — what `overridden_conditions` records. */
  skipped: { stage: LeadStage; label: string }[];
};

/**
 * Where the lead stands on its own ladder, and what converting it now skips.
 * Terminal rungs (won, customer, lost) are neither — they are where it lands.
 * A lead not on its ladder at all (on hold, lost) skips every working rung.
 */
export function funnelPosition(stage: LeadStage | null, salesType: LeadSalesType | null): FunnelPosition {
  const ladder = ladderFor(salesType).filter((s) => !TERMINAL_STAGES.includes(s));
  const at = stage ? ladder.indexOf(foldStage(stage)) : -1;
  const labelled = (s: LeadStage) => ({ stage: s, label: stageLabel(s) });
  return {
    passed: at >= 0 ? ladder.slice(0, at).map(labelled) : [],
    skipped: (at >= 0 ? ladder.slice(at) : ladder).map(labelled),
  };
}
