import type { DeskField, DeskFieldKey } from "@/lib/engines/lead-calling-desk";
import type { ProductMatch } from "@/lib/engines/call-intel-decide";
import type { LeadCallReading } from "@/lib/lead-call-intel-schema";

/* ---------------------------------------------------------------------------
 * WHAT A LEAD QUALIFICATION CALL'S READING SHOULD FILL, AND WHAT IT SHOULD
 * LEAVE ALONE.
 *
 * The call and visit assistants each have an engine that turns a reading into
 * proposals a person checks before anything is saved; this is the Calling
 * Desk's own, and the rule it exists to enforce is narrower than either of
 * them: it may only propose a value for a field that is CURRENTLY BEING
 * ASKED — `questionsForCall(lead.values, n).askNow` — on THIS call. Nothing
 * else. A field already answered is not in `askNow` to begin with, because
 * `questionsForCall` builds `askNow` from what is still open; a field planned
 * for a later call is in `later`, never `askNow`; so refusing anything not
 * named in `askNow` is enough, on its own, to satisfy both "never overwrite
 * an answered field" and "never ask about a field not yet due" — there is
 * no separate rule to write for either.
 *
 * PURE. The reading, the askNow set and the resolved product matches are
 * arguments; nothing here reads a clock or a database.
 * ------------------------------------------------------------------------- */

export type FillState = "ready" | "confirm";

export type LeadCallFill = {
  key: DeskFieldKey;
  label: string;
  state: FillState;
  /** What to put in the dialog's `text` state — every kind except `product`. */
  textValue: string | null;
  /** Set only for the `product` field, and only once a match has been resolved. */
  product: ProductMatch | null;
  confidence: number;
  evidence: string | null;
  /** Why it is `confirm` rather than `ready`, or what is still needed. */
  questions: string[];
};

export type LeadCallAnalysis = {
  /** One entry per field the reading said anything usable about, in `askNow` order. */
  fills: LeadCallFill[];
  /** Everything the reading could not tell, asked of the telecaller rather than guessed. */
  unclear: string[];
  /** False where no language model answered and there is nothing to propose. */
  readByModel: boolean;
};

export type LeadCallDecideInput = {
  reading: LeadCallReading | null;
  /** The raw words, for cross-checking a number the model read against the text itself. */
  text: string;
  /** Only these fields may ever receive a proposal — `questionsForCall(values, n).askNow`. */
  askNow: readonly DeskField[];
  /** Keyed by the product exactly as the reading named it. */
  products: Record<string, ProductMatch>;
  config: {
    /** 0-100, shared with the call assistant's own floor. Below this: `confirm`, not `ready`. */
    confirmBelow: number;
  };
};

/** A positive integer, or null — the shape every litres/days box expects. */
function intOrNull(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r;
}

/**
 * One field's slot, read against the askNow set and resolved into a fill — or
 * nothing, where the key is not currently a question, nothing was said, or the
 * model said nothing usable about it.
 */
function fillFor(
  field: DeskField,
  reading: LeadCallReading,
  input: LeadCallDecideInput,
): LeadCallFill | null {
  const q: string[] = [];
  const conf = input.config.confirmBelow;

  switch (field.key) {
    case "customerType": {
      const slot = reading.customerType;
      if (!slot?.value) return null;
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Which kind of business — ${slot.value}?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: slot.value,
        product: null,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }

    case "monthlyLitres": {
      const slot = reading.monthlyLitres;
      if (!slot || slot.value == null) return null;
      const litres = intOrNull(slot.value);
      if (litres === null || litres <= 0) return null;
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Check the monthly requirement — ${litres} litres?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: String(litres),
        product: null,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }

    case "requiredProductId": {
      const slot = reading.product;
      if (!slot?.value) return null;
      const match = input.products[slot.value] ?? { state: "none" as const };
      if (match.state === "none") {
        q.push(`"${slot.value}" — which product is that?`);
        return {
          key: field.key,
          label: field.label,
          state: "confirm",
          textValue: null,
          product: null,
          confidence: slot.confidence,
          evidence: slot.evidence || null,
          questions: q,
        };
      }
      if (match.state === "ambiguous") {
        q.push(`Which ${slot.value}?`);
        return {
          key: field.key,
          label: field.label,
          state: "confirm",
          textValue: null,
          product: match,
          confidence: slot.confidence,
          evidence: slot.evidence || null,
          questions: q,
        };
      }
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Was the product ${match.name}?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: null,
        product: match,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }

    case "competitor":
    case "application":
    case "gstin":
    case "address":
    case "email": {
      const slot = reading[field.key as "competitor" | "application" | "gstin" | "address" | "email"];
      if (!slot?.value?.trim()) return null;
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Check this — "${slot.value}"?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: slot.value.trim(),
        product: null,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }

    /*
     * DECISION MAKER AND BUYER ARE NEVER THE SAME QUESTION. The prompt tells
     * the model this explicitly, and the engine never falls one back onto the
     * other — a reading that named only a decision maker proposes nothing for
     * `buyer`, rather than assuming the two are one person.
     */
    case "decisionMaker": {
      const slot = reading.decisionMaker;
      if (!slot?.value?.trim()) return null;
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Check the decision maker — "${slot.value}"?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: slot.value.trim(),
        product: null,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }
    case "buyer": {
      const slot = reading.buyer;
      if (!slot?.value?.trim()) return null;
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Check the buyer — "${slot.value}"?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: slot.value.trim(),
        product: null,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }

    case "creditDaysWanted": {
      const slot = reading.creditDaysWanted;
      /* 0 is a real answer, so the check is for a number at all, not for a
         truthy one. */
      if (!slot || slot.value === null || slot.value === undefined) return null;
      const days = intOrNull(slot.value);
      if (days === null || days < 0 || days > 365) return null;
      const sure = slot.confidence >= conf;
      if (!sure) q.push(`Check the credit days — ${days}?`);
      return {
        key: field.key,
        label: field.label,
        state: sure ? "ready" : "confirm",
        textValue: String(days),
        product: null,
        confidence: slot.confidence,
        evidence: slot.evidence || null,
        questions: q,
      };
    }

    default:
      return null;
  }
}

export function decideLeadCallFill(input: LeadCallDecideInput): LeadCallAnalysis {
  const { reading } = input;
  if (!reading) {
    return { fills: [], unclear: [], readByModel: false };
  }

  /* ONLY fields currently in askNow may ever be proposed — this is the whole
     of the "do not overwrite an answered field, do not ask about one not yet
     due" rule, enforced by never looking past this set rather than by a
     second check against `isAnswered`. */
  const fills: LeadCallFill[] = [];
  for (const field of input.askNow) {
    const fill = fillFor(field, reading, input);
    if (fill) fills.push(fill);
  }

  return {
    fills,
    unclear: [...new Set(reading.unclear ?? [])],
    readByModel: true,
  };
}
