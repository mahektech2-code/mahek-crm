import { parseAmounts } from "@/lib/engines/call-intel-signals";
import type { IntakeFillKey, IntakeReading } from "@/lib/intake-intel-schema";

/* ---------------------------------------------------------------------------
 * WHAT A TELEPHONE CALL'S READING SHOULD FILL IN THE LEAD INTAKE FORM, AND
 * WHAT IT SHOULD LEAVE ALONE.
 *
 * The Calling Desk's engine decides over the questions a lead is currently
 * being asked; this decides over the Intake form's fixed boxes. Both turn a
 * reading into proposals a person checks before anything happens, and neither
 * saves anything: a proposal only ever becomes a value in the form's own state
 * when somebody presses Apply, and the existing "Raise the lead" is the only
 * thing that writes a lead.
 *
 * THE SALES TYPE IS NOT AN INPUT AND NOT AN OUTPUT. This function takes no
 * sales type, produces no fill for one, and cannot be made to: a fill's key is
 * an `IntakeFillKey`, and the sales type is not one. The only thing that
 * depends on the human's choice is `offerUnder`, a boolean the form works out
 * for itself, which decides whether the "Under" box exists to be proposed to —
 * it is never given to the model and it never produces a recommendation.
 *
 * PURE. The reading, the words, the configured sources and the valid
 * distributors are arguments; nothing here reads a clock or a database.
 * ------------------------------------------------------------------------- */

export type FillState = "ready" | "confirm";

export type IntakeFill = {
  key: IntakeFillKey;
  label: string;
  state: FillState;
  /** What goes into the form's state for `key` (an id for `distributorCustomerId`). */
  value: string;
  /** What the card prints where `value` is not readable (a distributor's name). */
  display: string;
  confidence: number;
  evidence: string | null;
  /** Why it is `confirm` rather than `ready`. */
  questions: string[];
};

export type IntakeAnalysis = {
  fills: IntakeFill[];
  /** Plain statements of what was said. Read-only: nothing consumes these but the card. */
  observations: string[];
  unclear: string[];
  /** False where no language model answered and there is nothing to propose. */
  readByModel: boolean;
};

export type IntakeDecideInput = {
  reading: IntakeReading | null;
  /** The raw words, for cross-checking a number the model read against the text itself. */
  text: string;
  /** The configured `leads.sources`, read live. */
  sources: readonly { code: string; label: string }[];
  /** Valid distributors only — the list the form's own "Under" box offers. */
  distributors: readonly { id: string; name: string; city: string | null }[];
  /** Whether the form is drawing "Under". Worked out by the form; never sent to the model. */
  offerUnder: boolean;
  config: {
    /** 0-100, shared with the call assistant's floor. Below this: `confirm`, not `ready`. */
    confirmBelow: number;
  };
};

const LABEL: Record<IntakeFillKey, string> = {
  name: "Business / shop name",
  contactPerson: "Contact person",
  phone: "Mobile",
  companyName: "Registered name",
  city: "Town",
  address: "Address",
  customerType: "Account type",
  monthlyLitres: "Monthly requirement, litres",
  competitor: "Buying from now",
  requirement: "What they want",
  application: "What they'll use it on",
  notes: "Note",
  source: "Lead source",
  sourceDetail: "Source details",
  distributorCustomerId: "Under",
};

/** `captureSchema`'s own ceilings, so a proposal is never longer than the save would take. */
const MAX: Partial<Record<IntakeFillKey, number>> = {
  name: 200,
  contactPerson: 120,
  companyName: 200,
  city: 120,
  address: 500,
  competitor: 200,
  requirement: 500,
  application: 200,
  notes: 2000,
  sourceDetail: 200,
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/* ------------------------------------------------------------------ mobile */

/** Ten digits, or null. A country prefix or a leading zero is dropped; nothing is completed. */
export function normaliseMobile(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/* ------------------------------------------------------------------ litres */

/** Every number the words contain — bare ones, and Indian number words ("2 hazar"). */
function numbersIn(text: string): number[] {
  const bare = [...text.replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Math.round(Number(m[0])));
  return [...new Set([...bare, ...parseAmounts(text)])].filter((n) => Number.isFinite(n) && n > 0);
}

/* ------------------------------------------------------------- distributor */

const NOISE = new Set(["pvt", "ltd", "limited", "co", "company", "and", "the"]);
const tokens = (s: string) => norm(s).split(" ").filter((t) => t && !NOISE.has(t));

export type DistributorMatch =
  | { state: "matched"; id: string; name: string }
  | { state: "ambiguous" }
  | { state: "none" };

/**
 * A spoken distributor against the valid list. STRONG OR NOTHING: the whole
 * normalised name equal, or every word of what was said inside exactly one
 * candidate's name (and enough of a word to mean something). Two candidates
 * that fit is ambiguous, and an ambiguous name is never resolved by picking one.
 */
export function matchDistributor(
  said: string,
  list: readonly { id: string; name: string }[],
): DistributorMatch {
  const want = tokens(said);
  if (!want.length) return { state: "none" };
  const wantKey = want.join(" ");

  const exact = list.filter((d) => tokens(d.name).join(" ") === wantKey);
  if (exact.length === 1) return { state: "matched", id: exact[0].id, name: exact[0].name };
  if (exact.length > 1) return { state: "ambiguous" };

  if (want.length === 1 && want[0].length < 4) return { state: "none" };
  const within = list.filter((d) => {
    const have = new Set(tokens(d.name));
    return want.every((t) => have.has(t));
  });
  if (within.length === 1) return { state: "matched", id: within[0].id, name: within[0].name };
  if (within.length > 1) return { state: "ambiguous" };
  return { state: "none" };
}

/* -------------------------------------------------------- fill-only-empty */

/**
 * Why a proposal may NOT be applied right now, or null if it may. The rule
 * behind "the assistant never overwrites what a person has typed": a box that
 * already holds anything is left alone, and the sentence for a source's detail
 * says why it waits. Pure, so the card and its test read the same rule.
 */
export function blockedReason(
  fill: Pick<IntakeFill, "key">,
  current: Partial<Record<IntakeFillKey, string>>,
): string | null {
  if ((current[fill.key] ?? "").trim()) return "Already filled — change it yourself if it is wrong.";
  if (fill.key === "sourceDetail" && current.source !== "other") return "Pick Other as the source first.";
  return null;
}

/* ----------------------------------------------------------- observations */

/**
 * DEFENCE IN DEPTH, NOT THE PROTECTION. The protection is that the sales type
 * is in no schema, no prompt and no setter. This drops any observation that
 * reads as an opinion or an instruction about choosing or changing how a
 * customer is classified — so even a model that tried would put nothing on the
 * card — while a plain "buys through a distributor" passes.
 */
const CLASSIFY_WORDS = String.raw`(?:third[\s-]*party|direct(?:\s+customer)?|not\s+decided|undecided|distributor)`;
const FORBIDDEN: RegExp[] = [
  /sales[\s-]*type/i,
  /\bladder\b/i,
  /\bnot\s+decided\b|\bundecided\b/i,
  /\bthird[\s-]*party\s+(?:customer|path|ladder)\b/i,
  /\bdirect\s+customer\b/i,
  new RegExp(String.raw`\b(?:change|switch|select|choose|set|mark|classif\w*|treat|convert|move|recommend\w*|suggest\w*|should|must|ought)\b[^.]{0,60}\b${CLASSIFY_WORDS}\b`, "i"),
  new RegExp(String.raw`\b(?:sounds?|looks?|appears?|seems?)\s+(?:like|to\s+be)\b[^.]{0,40}\b${CLASSIFY_WORDS}\b`, "i"),
  new RegExp(String.raw`\b${CLASSIFY_WORDS}\b[^.]{0,40}\b(?:instead|rather\s+than|would\s+be\s+better|is\s+(?:wrong|incorrect))\b`, "i"),
];

export function isSafeObservation(o: string): boolean {
  const s = o.trim();
  if (s.length < 3 || s.length > 240) return false;
  return !FORBIDDEN.some((re) => re.test(s));
}

/* -------------------------------------------------------------------- fills */

type Slot = { value: unknown; confidence: number; evidence: string };

function make(
  key: IntakeFillKey,
  value: string,
  slot: Slot,
  sure: boolean,
  questions: string[],
  display = value,
): IntakeFill {
  return {
    key,
    label: LABEL[key],
    state: sure ? "ready" : "confirm",
    value,
    display,
    confidence: slot.confidence,
    evidence: slot.evidence?.trim() || null,
    questions,
  };
}

/** A free-text box: trimmed, held to the save's own ceiling, `confirm` when unsure or cut. */
function plain(key: IntakeFillKey, slot: Slot | null | undefined, floor: number): IntakeFill | null {
  const raw = typeof slot?.value === "string" ? slot.value.trim() : "";
  if (!slot || !raw) return null;
  const max = MAX[key] ?? 500;
  const cut = raw.length > max;
  const value = cut ? raw.slice(0, max) : raw;
  const q: string[] = [];
  const sure = slot.confidence >= floor && !cut;
  if (cut) q.push(`That was longer than the box takes (${max}); check what was kept.`);
  else if (!sure) q.push(`Check this — "${value}"?`);
  return make(key, value, slot, sure, q);
}

export function decideIntakeFill(input: IntakeDecideInput): IntakeAnalysis {
  const { reading } = input;
  if (!reading) return { fills: [], observations: [], unclear: [], readByModel: false };

  const floor = input.config.confirmBelow;
  const unclear = [...new Set(reading.unclear ?? [])];
  const fills: IntakeFill[] = [];
  const push = (f: IntakeFill | null) => f && fills.push(f);

  /* Business name — the box a duplicate is judged by, so it is `ready` only
     when the name is actually in the words rather than a model's tidied-up one. */
  if (reading.name?.value?.trim()) {
    const value = reading.name.value.trim().slice(0, MAX.name);
    const inWords = norm(input.text).includes(norm(value));
    const q: string[] = [];
    const sure = reading.name.confidence >= floor && inWords;
    if (!sure) q.push(`Check the shop name — "${value}"?`);
    push(make("name", value, reading.name, sure, q));
  }

  push(plain("contactPerson", reading.contactPerson, floor));
  push(plain("companyName", reading.companyName, floor));
  push(plain("city", reading.city, floor));
  push(plain("address", reading.address, floor));

  /* Mobile — never `ready` on the model's word alone. The digits must be in the
     words themselves, because speech-to-text drops and swaps them silently and
     a wrong number is both a lost lead and a false duplicate. */
  if (reading.phone?.value?.trim()) {
    const mobile = normaliseMobile(reading.phone.value);
    if (!mobile) {
      unclear.push("The mobile number did not come out as ten digits — type it.");
    } else {
      const heard = input.text.replace(/\D/g, "").includes(mobile);
      const q: string[] = [];
      if (!heard) q.push(`Check the number — ${mobile} is not in the words as digits.`);
      else if (reading.phone.confidence < floor) q.push(`Check the number — ${mobile}?`);
      push(make("phone", mobile, reading.phone, heard && reading.phone.confidence >= floor, q));
    }
  }

  const ct = reading.customerType;
  if (ct?.value) {
    const sure = ct.confidence >= floor;
    push(make("customerType", ct.value, ct, sure, sure ? [] : [`Which kind of business — ${ct.value}?`]));
  }

  /* Litres — checked against the numbers in the words. */
  const lit = reading.monthlyLitres;
  if (lit && lit.value != null) {
    const litres = Math.round(lit.value);
    if (Number.isFinite(litres) && litres > 0 && litres <= 1_000_000) {
      const heard = numbersIn(input.text);
      const q: string[] = [];
      let agrees = true;
      if (heard.length && !heard.includes(litres)) {
        agrees = false;
        const other = heard.find((h) => h !== litres);
        q.push(other != null ? `Was it ${litres} or ${other} litres?` : `Check the figure — ${litres} litres.`);
      } else if (lit.confidence < floor) q.push(`Check the monthly requirement — ${litres} litres?`);
      push(make("monthlyLitres", String(litres), lit, agrees && lit.confidence >= floor, q));
    }
  }

  push(plain("competitor", reading.competitor, floor));
  push(plain("requirement", reading.requirement, floor));
  push(plain("application", reading.application, floor));
  push(plain("notes", reading.notes, floor));

  /* Source — only a CONFIGURED one, matched whole; anything else is a question.
     `other` is always checked, because the save refuses it without its sentence. */
  let sourceCode: string | null = null;
  const src = reading.source;
  if (src?.value?.trim()) {
    const said = norm(src.value);
    const hits = input.sources.filter((s) => norm(s.code) === said || norm(s.label) === said);
    if (hits.length === 1) {
      sourceCode = hits[0].code;
      const sure = src.confidence >= floor && sourceCode !== "other";
      const q = sure
        ? []
        : sourceCode === "other"
          ? ["“Other” needs the sentence behind it."]
          : [`Was it ${hits[0].label}?`];
      push(make("source", sourceCode, src, sure, q, hits[0].label));
    } else {
      unclear.push("Which lead source was it? None of the configured ones matched clearly.");
    }
  }
  if (sourceCode === "other") push(plain("sourceDetail", reading.sourceDetail, floor));

  /* Under — only where the form draws the box, and only on a strong match to a
     valid distributor. Always `confirm`: it decides who bills the shop. */
  const dn = reading.distributorName;
  if (input.offerUnder && dn?.value?.trim()) {
    const m = matchDistributor(dn.value, input.distributors);
    if (m.state === "matched") {
      push(make("distributorCustomerId", m.id, dn, false, [`Is the distributor ${m.name}?`], m.name));
    } else if (m.state === "ambiguous") {
      unclear.push(`More than one distributor fits "${dn.value}" — pick it from the list.`);
    } else {
      unclear.push(`"${dn.value}" is not one of the distributors on the list.`);
    }
  }

  const observations = [...new Set((reading.observations ?? []).map((o) => o.trim()))]
    .filter(isSafeObservation)
    .slice(0, 5);

  return { fills, observations, unclear: [...new Set(unclear)], readByModel: true };
}
