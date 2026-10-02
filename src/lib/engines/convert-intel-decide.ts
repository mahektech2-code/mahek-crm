import { parseAmounts } from "@/lib/engines/call-intel-signals";
import type { ProductMatch } from "@/lib/engines/call-intel-decide";
import type { ConvertFieldKey, ConvertReading } from "@/lib/convert-intel-schema";

/* ---------------------------------------------------------------------------
 * WHAT A CONVERT-TO-PROSPECT READING SHOULD FILL IN THE DIALOG, AND WHAT IT
 * MUST NEVER OVERWRITE.
 *
 * Like the other voice engines this turns a reading into proposals a person
 * checks, and saves nothing. What is particular to Convert is what its save
 * does: `convertProspect` writes the dialog's values STRAIGHT INTO THE LEAD'S
 * OWN FIELDS and keeps no record of what was there. A wrong suggestion applied
 * there would silently replace what the salesman collected. So every proposal
 * is exactly one of four things, and only one of them is ever bulk-applied:
 *
 *   ready      — the lead has NOTHING for this fact, the words support it. A
 *                normal fill; part of "Apply all ready".
 *   uncertain  — the words do not support it well enough (low confidence, a
 *                number the words contradict, a product that is not one
 *                answer). For checking; never bulk-applied; a product that is
 *                ambiguous or unknown cannot be applied at all and is chosen by
 *                hand.
 *   conflict   — the lead ALREADY has a different value. Shown beside it, with
 *                a button that is the manager's own act ("Mark as corrected");
 *                never bulk-applied, never a plain fill.
 *   matches    — the shop agrees with what is on file. Nothing to do.
 *
 * THE ENGINE COMPARES, THE MODEL DOES NOT. The model reports what was said and
 * is never shown what is on file; this holds `onFile` and decides which of the
 * four it is.
 *
 * NOTHING HERE CAN CARRY A DECISION. There is no conversion reason, no
 * confirm/correct/unable choice, no sales type, owner, stage or next action in
 * any type in this file.
 *
 * PURE. The reading, the words, the on-file values and the already-resolved
 * product match are arguments.
 * ------------------------------------------------------------------------- */

export type ConvertStatus = "ready" | "uncertain" | "conflict" | "matches";

export type ConvertItem = {
  key: ConvertFieldKey;
  label: string;
  status: ConvertStatus;
  /** What the salesman recorded, as the dialog shows it; null where nothing is on file. */
  onFile: string | null;
  /** What was said, for the card. */
  display: string;
  /**
   * What goes into the dialog to apply it: the type's code, the product's id,
   * digits for a figure, the words for a name. Null where it cannot be applied
   * (a match, or a product that must be picked by hand).
   */
  applyValue: string | null;
  /** The resolved product's name, for the dialog's picker — product only. */
  productName?: string;
  /** Candidate names when a product is ambiguous — read-only, chosen by hand. */
  options?: string[];
  confidence: number;
  evidence: string | null;
  questions: string[];
};

export type ConvertAnalysis = {
  items: ConvertItem[];
  /** Facts the lead has nothing for and this reading did not supply — the manager still has to ask. */
  stillMissing: string[];
  unclear: string[];
  readByModel: boolean;
};

/** What the lead has now, per fact. Null or absent means nothing is on file. */
export type ConvertOnFile = {
  customerType: string | null;
  productId: string | null;
  productName: string | null;
  monthlyLitres: number | null;
  potentialRupees: number | null;
  competitor: string | null;
  contact: string | null;
  decisionMaker: string | null;
};

export type ConvertDecideInput = {
  reading: ConvertReading | null;
  text: string;
  onFile: ConvertOnFile;
  /** The catalogue matcher's answer for the product as it was named; absent if none was named. */
  product: ProductMatch | null;
  config: { confirmBelow: number };
};

const LABEL: Record<ConvertFieldKey, string> = {
  customerType: "Customer type",
  product: "Product",
  monthlyLitres: "Monthly Requirement",
  potentialPaise: "Monthly Potential",
  competitor: "Competitor",
  contact: "Contact Person",
  decisionMaker: "Decision Maker",
};

const TYPE_LABEL: Record<string, string> = {
  dealer: "Dealer",
  manufacturer: "Manufacturer",
  distributor: "Distributor",
  retailer: "Retailer",
};

export const litresText = (n: number) => Math.round(n).toLocaleString("en-IN") + " Litres";
export const rupeesText = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Same value, allowing one name to sit inside the other. */
function sameText(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
}

/** Every number the words contain — bare ones, and Indian number words ("2 hazar"). */
function numbersIn(text: string): number[] {
  const bare = [...text.replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Math.round(Number(m[0])));
  return [...new Set([...bare, ...parseAmounts(text)])].filter((n) => Number.isFinite(n) && n > 0);
}

/* ------------------------------------------------------- fill-only-untouched */

export type ConvertApplyContext = {
  /** Facts the manager has changed by hand, or that voice has already applied. */
  touched: ReadonlySet<string>;
  /** The customer-type select's current value ("" if none). */
  customerType: string;
  /** The product picker's current id. */
  productId: string | null;
  /** The Confirm / Correct / Unable rows, where the lead has a value on file. */
  rows: Partial<Record<ConvertFieldKey, { choice: string; value: string; reason: string }>>;
  /** What has been typed into a fact the lead has nothing for. */
  freeEntry: Partial<Record<ConvertFieldKey, string>>;
};

/**
 * Why a proposal may NOT be applied right now, or null if it may. The rule
 * behind "voice never overrides the manager":
 *
 *   - anything the manager has changed by hand is theirs, whatever it now holds;
 *   - a fact with a row (the lead has a value) is touched only while its row is
 *     still on the starting Confirm — a row marked Correct or Unable To Verify is
 *     a decision;
 *   - a fact with nothing on file is filled only while its box is still empty;
 *   - the customer type and the product are the same, read from their pickers;
 *   - a match has nothing to apply, and a product that is ambiguous or unknown
 *     cannot be applied at all.
 */
export function blockedReason(
  item: ConvertItem,
  ctx: ConvertApplyContext,
  onFile: Pick<ConvertOnFile, "customerType" | "productId">,
): string | null {
  if (item.status === "matches") return "Matches what the salesman entered — nothing to change.";
  if (item.applyValue === null) {
    return item.options?.length
      ? "Several products fit — choose it yourself in the Product box."
      : "Not found in the catalogue — choose it yourself in the Product box.";
  }
  if (ctx.touched.has(item.key)) return "You have already changed this — change it again yourself if it is wrong.";

  if (item.key === "customerType") {
    if (item.status === "conflict") return ctx.customerType !== (onFile.customerType ?? "") ? "You have already changed this." : null;
    return ctx.customerType ? "Already chosen." : null;
  }
  if (item.key === "product") {
    if (item.status === "conflict") return ctx.productId !== onFile.productId ? "You have already changed this." : null;
    return ctx.productId ? "Already chosen." : null;
  }
  if (item.status === "conflict") {
    const row = ctx.rows[item.key];
    if (!row) return "This fact has no row to correct.";
    return row.choice !== "confirm" || row.reason.trim() ? "You have already decided this one." : null;
  }
  return (ctx.freeEntry[item.key] ?? "").trim() ? "Already filled — change it yourself if it is wrong." : null;
}

/* ------------------------------------------------------------------- items */

type Slot = { confidence: number; evidence: string };

function build(
  key: ConvertFieldKey,
  onFile: string | null,
  display: string,
  applyValue: string | null,
  same: boolean,
  slot: Slot,
  floor: number,
  extra: string[],
  more: Partial<ConvertItem> = {},
): ConvertItem {
  const questions = [...extra];
  /* A conflict already SHOWS both values on its own line, so it carries a question only when there is
     something more to say about it — a figure the words do not support, or a name not in the words. */
  if (!questions.length && slot.confidence < floor) questions.push("Not sure — check this.");
  let status: ConvertStatus;
  if (onFile !== null && same) status = "matches";
  else if (onFile !== null) status = "conflict";
  else status = questions.length ? "uncertain" : "ready";
  return {
    key,
    label: LABEL[key],
    status,
    onFile,
    display,
    applyValue: status === "matches" ? null : applyValue,
    confidence: slot.confidence,
    evidence: slot.evidence?.trim() || null,
    questions: status === "matches" ? [] : questions,
    ...more,
  };
}

export function decideConvertFill(input: ConvertDecideInput): ConvertAnalysis {
  const { reading, onFile } = input;
  if (!reading) return { items: [], stillMissing: [], unclear: [], readByModel: false };

  const floor = input.config.confirmBelow;
  const unclear = [...new Set(reading.unclear ?? [])];
  const items: ConvertItem[] = [];
  const supplied = new Set<ConvertFieldKey>();
  const heard = numbersIn(input.text);
  const inWords = (s: string) => norm(input.text).includes(norm(s));

  /* Customer type */
  const ct = reading.customerType;
  if (ct?.value) {
    supplied.add("customerType");
    items.push(
      build(
        "customerType",
        onFile.customerType ? (TYPE_LABEL[onFile.customerType] ?? onFile.customerType) : null,
        TYPE_LABEL[ct.value] ?? ct.value,
        ct.value,
        onFile.customerType === ct.value,
        ct,
        floor,
        ct.confidence < floor ? [`Which kind of business — ${TYPE_LABEL[ct.value] ?? ct.value}?`] : [],
      ),
    );
  }

  /* Product — the catalogue's own matcher decides; an ambiguous or unknown name is never guessed. */
  const prod = reading.product;
  const said = prod?.value?.trim();
  if (prod && said) {
    supplied.add("product");
    const m = input.product;
    if (m?.state === "matched") {
      const same = onFile.productId === m.productId;
      items.push(
        build(
          "product",
          onFile.productId ? (onFile.productName ?? "A product the catalogue could not name") : null,
          m.name,
          m.productId,
          same,
          prod,
          floor,
          prod.confidence < floor ? [`Was the product ${m.name}?`] : [],
          { productName: m.name },
        ),
      );
    } else if (m?.state === "ambiguous") {
      items.push({
        key: "product",
        label: LABEL.product,
        status: "uncertain",
        onFile: onFile.productId ? (onFile.productName ?? "A product the catalogue could not name") : null,
        display: said,
        applyValue: null,
        options: m.options.map((o) => o.name),
        confidence: prod.confidence,
        evidence: prod.evidence?.trim() || null,
        questions: [`"${said}" fits more than one product — choose it yourself.`],
      });
    } else {
      items.push({
        key: "product",
        label: LABEL.product,
        status: "uncertain",
        onFile: onFile.productId ? (onFile.productName ?? "A product the catalogue could not name") : null,
        display: said,
        applyValue: null,
        confidence: prod.confidence,
        evidence: prod.evidence?.trim() || null,
        questions: [`"${said}" is not in the catalogue — choose the product yourself.`],
      });
    }
  }

  /* Monthly litres — cross-checked against the numbers in the words. */
  const lit = reading.monthlyLitres;
  if (lit && lit.value != null) {
    const n = Math.round(lit.value);
    if (Number.isFinite(n) && n > 0 && n <= 1_000_000) {
      supplied.add("monthlyLitres");
      const q: string[] = [];
      if (heard.length && !heard.includes(n)) q.push(`Check the figure — ${n} litres is not in the words as a number.`);
      items.push(
        build(
          "monthlyLitres",
          onFile.monthlyLitres != null ? litresText(onFile.monthlyLitres) : null,
          litresText(n),
          String(n),
          onFile.monthlyLitres != null && Math.round(onFile.monthlyLitres) === n,
          lit,
          floor,
          q,
        ),
      );
    }
  }

  /* Potential — in rupees, including Indian number words. */
  const pot = reading.potentialRupees;
  if (pot && pot.value != null) {
    const n = Math.round(pot.value);
    if (Number.isFinite(n) && n > 0) {
      supplied.add("potentialPaise");
      const q: string[] = [];
      const amounts = parseAmounts(input.text);
      if ((amounts.length || heard.length) && ![...amounts, ...heard].includes(n)) {
        q.push(`Check the amount — ${rupeesText(n)} is not in the words as a figure.`);
      }
      items.push(
        build(
          "potentialPaise",
          onFile.potentialRupees != null ? rupeesText(onFile.potentialRupees) : null,
          rupeesText(n),
          String(n),
          onFile.potentialRupees != null && Math.round(onFile.potentialRupees) === n,
          pot,
          floor,
          q,
        ),
      );
    }
  }

  /* Names — compared loosely; a name that is not in the words is for checking. */
  for (const [key, slot, current] of [
    ["competitor", reading.competitor, onFile.competitor],
    ["contact", reading.contact, onFile.contact],
    ["decisionMaker", reading.decisionMaker, onFile.decisionMaker],
  ] as const) {
    const value = slot?.value?.trim();
    if (!slot || !value) continue;
    supplied.add(key);
    items.push(
      build(
        key,
        current?.trim() ? current.trim() : null,
        value.slice(0, 200),
        value.slice(0, 200),
        Boolean(current?.trim()) && sameText(value, current!),
        slot,
        floor,
        inWords(value) ? [] : [`"${value}" is not in the words exactly — check it.`],
      ),
    );
  }

  /* What the lead still has nothing for, that this reading did not supply. */
  const empty: Array<[ConvertFieldKey, boolean]> = [
    ["customerType", !onFile.customerType],
    ["product", !onFile.productId],
    ["monthlyLitres", onFile.monthlyLitres == null],
    ["potentialPaise", onFile.potentialRupees == null],
    ["competitor", !onFile.competitor?.trim()],
    ["contact", !onFile.contact?.trim()],
  ];
  const stillMissing = empty.filter(([k, isEmpty]) => isEmpty && !supplied.has(k)).map(([k]) => LABEL[k]);

  const order: Record<ConvertStatus, number> = { ready: 0, uncertain: 1, conflict: 2, matches: 3 };
  items.sort((a, b) => order[a.status] - order[b.status]);

  return { items, stillMissing, unclear, readByModel: true };
}
