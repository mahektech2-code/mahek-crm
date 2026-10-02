import { parseAmounts } from "@/lib/engines/call-intel-signals";
import type { VerifyAnswerKey, VerifyFindingKey, VerifyReading } from "@/lib/verify-intel-schema";

/* ---------------------------------------------------------------------------
 * WHAT A VERIFICATION CALL'S READING SHOULD FILL IN THE MANAGER VERIFICATION
 * DIALOG, AND WHAT IT SHOULD LEAVE ALONE.
 *
 * Like the Calling Desk's and the Intake form's engines, this turns a reading
 * into proposals a person checks before anything happens, and it saves nothing.
 * What is particular to verification:
 *
 *   - THE ENGINE COMPARES, THE MODEL DOES NOT. The model reports what the shop
 *     said. This holds the salesman's value (`onFile`) and decides whether the
 *     shop agrees (`matches`) or not (`differs`). A `differs` finding is only
 *     ever a proposal to mark the row Correct; it never changes the row itself,
 *     never fills the reason, and is never part of "Apply all".
 *   - THERE IS NO RESULT HERE. Verified, verified with corrections, follow-up
 *     and verification failed, the failure reason, every note and every
 *     correction reason are the manager's. No type in this file can carry them.
 *   - A "NO" THAT CHANGES THE STORY IS ALWAYS A QUESTION. The dialog starts with
 *     the salesman having visited and explained and the shop being interested,
 *     so a spoken "no" to any of those contradicts the starting point and is
 *     never `ready`.
 *
 * PURE. The reading, the words and the on-file values are arguments.
 * ------------------------------------------------------------------------- */

export type FillState = "ready" | "confirm";

export type VerifyAnswerFill = {
  kind: "answer";
  key: VerifyAnswerKey;
  label: string;
  /** true / false for a yes-no or concern box; the shop's words for the impression. */
  value: boolean | string;
  /** What the card prints. */
  display: string;
  state: FillState;
  confidence: number;
  evidence: string | null;
  questions: string[];
};

export type VerifyFindingFill = {
  kind: "finding";
  key: VerifyFindingKey;
  label: string;
  /** What the salesman recorded, as the row shows it. */
  onFile: string;
  /** What the shop said, in the same format — what a Correct row would hold. */
  shopSays: string;
  /** `matches`: nothing to do. `differs`: a proposal to mark Correct, never applied automatically. */
  relation: "matches" | "differs";
  state: FillState;
  confidence: number;
  evidence: string | null;
  questions: string[];
};

export type VerifyAnalysis = {
  answers: VerifyAnswerFill[];
  findings: VerifyFindingFill[];
  /** Plain statements of what the shop said. Read-only: nothing consumes these but the card. */
  observations: string[];
  unclear: string[];
  readByModel: boolean;
};

/** What the salesman recorded, per finding the dialog has a row for. A missing or null entry means no row. */
export type OnFile = {
  monthlyLitres: number | null;
  potentialRupees: number | null;
  product: string | null;
  competitor: string | null;
  contact: string | null;
  decisionMaker: string | null;
};

export type VerifyDecideInput = {
  reading: VerifyReading | null;
  text: string;
  onFile: OnFile;
  config: { confirmBelow: number };
};

const ANSWER_LABEL: Record<VerifyAnswerKey, string> = {
  visited: "Did the salesman visit?",
  explained: "Did he explain Mahek properly?",
  impression: "Customer's impression of the salesman",
  genuineInterest: "Genuinely interested in trying it?",
  priceConcern: "Price concern",
  qualityConcern: "Quality concern",
  creditConcern: "Credit concern",
  serviceConcern: "Delivery / service concern",
  competitorConcern: "Competitor concern",
  readyForTrial: "Ready for trial",
  readyForCommercial: "Ready for commercial discussion",
  readyForOrder: "Ready for order discussion",
};

const FINDING_LABEL: Record<VerifyFindingKey, string> = {
  monthlyLitres: "Monthly Requirement",
  potentialPaise: "Monthly Potential",
  product: "Product",
  competitor: "Competitor",
  contact: "Contact Person",
  decisionMaker: "Decision Maker",
};

/** The dialog's starting answers — a "no" to one of these contradicts where the dialog starts. */
const STARTS_YES: ReadonlySet<VerifyAnswerKey> = new Set(["visited", "explained", "genuineInterest", "readyForTrial"]);

export const rupeesText = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const litresText = (n: number) => Math.round(n).toLocaleString("en-IN") + " Litres";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Same value, allowing one name to sit inside the other ("Nano Thinner" in "Nano Thinner - 20 Liter"). */
function sameText(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** Every number the words contain — bare ones, and Indian number words ("2 hazar"). */
function numbersIn(text: string): number[] {
  const bare = [...text.replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Math.round(Number(m[0])));
  return [...new Set([...bare, ...parseAmounts(text)])].filter((n) => Number.isFinite(n) && n > 0);
}

/* ----------------------------------------------------------- observations */

/**
 * DEFENCE IN DEPTH. The protection is that there is no result slot, the prompt
 * asks for none, and the card has no way to set one. This drops any observation
 * that reads as a verdict or an instruction about what to do with the lead, so
 * even a model that tried puts nothing of the kind on the card. A plain "the
 * shop says the salesman never came" passes.
 */
const FORBIDDEN: RegExp[] = [
  /\b(?:recommend\w*|suggest\w*|should|must|ought|advise\w*)\b/i,
  /\bverif(?:y|ied|ication)\b[^.]{0,50}\b(?:fail\w*|pass\w*|succe\w*|complete\w*|result|outcome)\b/i,
  /\b(?:mark|marked|set|choose|select|treat|classif\w*|close|closed|reject\w*|approve\w*)\b[^.]{0,50}\b(?:verified|lost|prospect|failed|follow[\s-]?up|lead)\b/i,
  /\bfollow[\s-]?up\b[^.]{0,30}\b(?:required|needed|necessary)\b/i,
  /\b(?:false|fake|dead|bogus)\s+(?:lead|opportunity)\b/i,
  /\bnot\s+a\s+prospect\b/i,
  /sales[\s-]*type|third[\s-]*party|ladder|\bnot\s+decided\b/i,
];

export function isSafeObservation(o: string): boolean {
  const s = o.trim();
  if (s.length < 3 || s.length > 240) return false;
  return !FORBIDDEN.some((re) => re.test(s));
}

/* ------------------------------------------------------- fill-only-untouched */

export type ApplyContext = {
  /** Answers the manager has touched, or that voice has already applied. */
  touched: ReadonlySet<string>;
  /** The dialog's current value of each answer. */
  current: Partial<Record<VerifyAnswerKey, boolean | string>>;
  /** Each finding row's current state; a key is absent where the dialog draws no row. */
  rows: Partial<Record<VerifyFindingKey, { choice: string; value: string; reason: string }>>;
};

/**
 * Why a proposal may NOT be applied right now, or null if it may. The rule
 * behind "the assistant never overrides what the manager has decided":
 *
 *   - an answer the manager has touched is left alone (the dialog's starting
 *     Yes/No values are defaults, not answers, so an untouched one may be set);
 *   - the impression is filled only while empty;
 *   - a finding row is touched only while it is still on its starting Confirm
 *     with no reason typed — a row the manager has marked Correct or Unable, or
 *     written a reason on, is theirs.
 */
export function blockedReason(item: VerifyAnswerFill | VerifyFindingFill, ctx: ApplyContext): string | null {
  if (item.kind === "answer") {
    if (item.key === "impression") {
      return String(ctx.current.impression ?? "").trim() ? "Already filled — change it yourself if it is wrong." : null;
    }
    if (ctx.touched.has(item.key)) return "You have already answered this — change it yourself if it is wrong.";
    if (ctx.current[item.key] === item.value) return "Already set to that.";
    return null;
  }
  if (item.relation === "matches") return "Matches what the salesman entered — nothing to change.";
  const row = ctx.rows[item.key];
  if (!row) return "This finding has no row to correct.";
  if (row.choice !== "confirm" || row.reason.trim()) return "You have already decided this one.";
  return null;
}

/* -------------------------------------------------------------------- fills */

type YesNoSlot = { value: boolean | null; confidence: number; evidence: string } | null;

function yesNoFill(key: VerifyAnswerKey, slot: YesNoSlot, floor: number, concern: boolean): VerifyAnswerFill | null {
  if (!slot || slot.value === null || slot.value === undefined) return null;
  /* A concern is only ever proposed as raised; "no concern" is the starting
     value, and a model saying false adds nothing but a way to be wrong. */
  if (concern && slot.value !== true) return null;
  const q: string[] = [];
  let sure = slot.confidence >= floor;
  if (!sure) q.push(`Check this — ${ANSWER_LABEL[key]}: ${slot.value ? "yes" : "no"}?`);
  if (STARTS_YES.has(key) && slot.value === false) {
    sure = false;
    q.push("This contradicts where the form starts — check the words before applying.");
  }
  return {
    kind: "answer",
    key,
    label: ANSWER_LABEL[key],
    value: slot.value,
    display: concern ? "Concern raised" : slot.value ? "Yes" : "No",
    state: sure ? "ready" : "confirm",
    confidence: slot.confidence,
    evidence: slot.evidence?.trim() || null,
    questions: q,
  };
}

function finding(
  key: VerifyFindingKey,
  onFile: string,
  shopSays: string,
  relation: "matches" | "differs",
  slot: { confidence: number; evidence: string },
  floor: number,
  extra: string[],
): VerifyFindingFill {
  const q = [...extra];
  /* A difference contradicts the salesman, so it is always for checking. */
  if (relation === "differs" && !q.length) q.push(`The shop says ${shopSays}; the salesman entered ${onFile}. Check before correcting.`);
  if (relation === "matches" && slot.confidence < floor) q.push("Not sure — check this.");
  return {
    kind: "finding",
    key,
    label: FINDING_LABEL[key],
    onFile,
    shopSays,
    relation,
    state: relation === "differs" ? "confirm" : q.length ? "confirm" : "ready",
    confidence: slot.confidence,
    evidence: slot.evidence?.trim() || null,
    questions: q,
  };
}

export function decideVerifyFill(input: VerifyDecideInput): VerifyAnalysis {
  const { reading } = input;
  if (!reading) return { answers: [], findings: [], observations: [], unclear: [], readByModel: false };

  const floor = input.config.confirmBelow;
  const unclear = [...new Set(reading.unclear ?? [])];
  const answers: VerifyAnswerFill[] = [];
  const findings: VerifyFindingFill[] = [];

  for (const [key, slot, concern] of [
    ["visited", reading.visited, false],
    ["explained", reading.explained, false],
    ["genuineInterest", reading.genuineInterest, false],
    ["priceConcern", reading.priceConcern, true],
    ["qualityConcern", reading.qualityConcern, true],
    ["creditConcern", reading.creditConcern, true],
    ["serviceConcern", reading.serviceConcern, true],
    ["competitorConcern", reading.competitorConcern, true],
    ["readyForTrial", reading.readyForTrial, false],
    ["readyForCommercial", reading.readyForCommercial, false],
    ["readyForOrder", reading.readyForOrder, false],
  ] as const) {
    const f = yesNoFill(key, slot, floor, concern);
    if (f) answers.push(f);
  }

  const imp = reading.impression;
  if (imp?.value?.trim()) {
    const value = imp.value.trim().slice(0, 1000);
    const sure = imp.confidence >= floor;
    answers.push({
      kind: "answer",
      key: "impression",
      label: ANSWER_LABEL.impression,
      value,
      display: value,
      state: sure ? "ready" : "confirm",
      confidence: imp.confidence,
      evidence: imp.evidence?.trim() || null,
      questions: sure ? [] : ["Check the wording before applying."],
    });
  }

  /* Findings — only where the dialog has a row (the salesman recorded something). */
  const heard = numbersIn(input.text);

  const lit = reading.monthlyLitres;
  if (input.onFile.monthlyLitres != null && lit && lit.value != null) {
    const said = Math.round(lit.value);
    if (Number.isFinite(said) && said > 0 && said <= 1_000_000) {
      const q: string[] = [];
      if (heard.length && !heard.includes(said)) q.push(`Check the figure — ${said} litres is not in the words as a number.`);
      findings.push(
        finding(
          "monthlyLitres",
          litresText(input.onFile.monthlyLitres),
          litresText(said),
          said === Math.round(input.onFile.monthlyLitres) ? "matches" : "differs",
          lit,
          floor,
          q,
        ),
      );
    }
  }

  const pot = reading.potentialRupees;
  if (input.onFile.potentialRupees != null && pot && pot.value != null) {
    const said = Math.round(pot.value);
    if (Number.isFinite(said) && said > 0) {
      const q: string[] = [];
      const amounts = parseAmounts(input.text);
      if ((amounts.length || heard.length) && ![...amounts, ...heard].includes(said)) {
        q.push(`Check the amount — ${rupeesText(said)} is not in the words as a figure.`);
      }
      findings.push(
        finding(
          "potentialPaise",
          rupeesText(input.onFile.potentialRupees),
          rupeesText(said),
          said === Math.round(input.onFile.potentialRupees) ? "matches" : "differs",
          pot,
          floor,
          q,
        ),
      );
    }
  }

  for (const [key, slot, onFile] of [
    ["product", reading.product, input.onFile.product],
    ["competitor", reading.competitor, input.onFile.competitor],
    ["contact", reading.contact, input.onFile.contact],
    ["decisionMaker", reading.decisionMaker, input.onFile.decisionMaker],
  ] as const) {
    const said = slot?.value?.trim();
    if (!slot || !said || !onFile?.trim()) continue;
    const inWords = norm(input.text).includes(norm(said));
    findings.push(
      finding(
        key,
        onFile.trim(),
        said.slice(0, 1000),
        sameText(said, onFile) ? "matches" : "differs",
        slot,
        floor,
        inWords ? [] : [`"${said}" is not in the words exactly — check it.`],
      ),
    );
  }

  const observations = [...new Set((reading.observations ?? []).map((o) => o.trim()))]
    .filter(isSafeObservation)
    .slice(0, 5);

  return { answers, findings, observations, unclear, readByModel: true };
}
