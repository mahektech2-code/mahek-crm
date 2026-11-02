import type { LeadStage } from "../lead-labels";
import { stageLabel } from "../lead-labels";
import { gateTo, type Condition, type LeadGateInput } from "./lead-gates";
import { foldStage, ladderFor } from "./lead-ladder";

/* ---------------------------------------------------------------------------
 * A SALES MANAGER CHOOSING A LATER STAGE FROM QUALIFICATION — pure.
 *
 * Once the Qualification is complete and the Sales Manager has VERIFIED it, the
 * lead need not climb every rung: Sample / Trial is not compulsory when they
 * decide it does not apply. This file answers one question for the screen that
 * draws the choice and the service that enforces it, so the two cannot differ:
 * from here, which stages are open, which are not and why, and which rungs a
 * move to each would not climb.
 *
 * WHAT IS NEVER LIFTED, and the reason this is not an override:
 *   - the FULL Sample / Trial entry gate must be open first — all eight
 *     answers, GST validated, the review "verified" (an answer changed since
 *     voids it), a distributor named on a third-party lead. Nothing is passed
 *     while shut; the whole of it is a precondition.
 *   - a destination's own FACTS: an order placed, an order delivered, money
 *     confirmed, two orders. Those read real records and lifting them would
 *     mean making the records up.
 * WHAT IS LIFTED, by id, for Negotiation only: the three conditions that ask
 * about the sample (`sample_sent`, `sample_reviewed`, `sample_approved`). They
 * are what "the trial is not compulsory" means.
 * The Verification Call is read nowhere here: it stays optional.
 *
 * It lives beside the gate engine and not inside it on purpose. `lead-gates.ts`
 * is mirrored byte for byte onto the handset; this is a Sales Manager's choice
 * made at a desk, and nothing on a phone asks it.
 * ------------------------------------------------------------------------- */

/** The only rung this choice is made from. */
const SELECT_FROM: LeadStage = "qualification";

/** The conditions that ask about the sample — the ones a skip means "not needed" for. */
const SAMPLE_CONDITION_IDS: readonly string[] = ["sample_sent", "sample_reviewed", "sample_approved"];

/** The next-action condition's id, which `leads.requireNextAction` may lift. */
const NEXT_ACTION_ID = "next_action";

/** Sample states already inside the sample workflow. A request still at `requested` is open and may be skipped; these continue as they are. */
const SAMPLE_IN_PROGRESS: readonly string[] = ["approved", "dispatched", "received", "tried", "trial_done", "reviewed"];
export const SAMPLE_IN_PROGRESS_SAYS = "A sample is already in progress. It continues through the sample workflow.";

export type StageChoice = {
  to: LeadStage;
  /** The rungs between Qualification and `to` that this move does not climb. Empty for Sample / Trial. */
  skips: LeadStage[];
  available: boolean;
  /** What stands in the way, as the gate's own conditions. Empty when it is available. */
  missing: Condition[];
  /** The same, as the sentences the screen prints. */
  reasons: string[];
};

export type StageSelection = {
  /** False where the choice is not offered at all: another rung, another ladder. */
  applies: boolean;
  /** One sentence for why not, where `applies` is false. */
  whyNot: string | null;
  /** What still stands between this lead and being allowed to choose. Empty means the choice is open. */
  entryMissing: Condition[];
  choices: StageChoice[];
};

const NOT_OFFERED: StageSelection = { applies: false, whyNot: null, entryMissing: [], choices: [] };

export function stageSelection(
  gate: LeadGateInput,
  options: { requireNextAction: boolean },
): StageSelection {
  if (gate.stage !== SELECT_FROM) return NOT_OFFERED;
  /* Direct and third-party climb the same rungs. A distributor's Qualification
     leads to management review, not to a sample, so there is nothing to skip. */
  if (gate.salesType !== "direct" && gate.salesType !== "third_party") return NOT_OFFERED;

  const lift = (missing: Condition[]) =>
    options.requireNextAction ? missing : missing.filter((c) => c.id !== NEXT_ACTION_ID);

  const entryMissing = lift(gateTo(gate, "sample_trial").missing);
  const ladder = ladderFor(gate.salesType);
  const here = ladder.indexOf(foldStage(SELECT_FROM));

  const choices: StageChoice[] = [];
  for (const to of ladder.slice(here + 1)) {
    /* `sample_review` is the second half of the trial, not a place to arrive. */
    if (to === "sample_review") continue;
    const skips = ladder.slice(here + 1, ladder.indexOf(to)) as LeadStage[];
    const own = lift(gateTo(gate, to).missing).filter((c) => !SAMPLE_CONDITION_IDS.includes(c.id));
    const inFlight = skips.length > 0 && gate.sample != null && SAMPLE_IN_PROGRESS.includes(gate.sample.state);
    const missing = [...entryMissing, ...own].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
    if (inFlight) {
      choices.push({ to, skips, available: false, missing, reasons: [SAMPLE_IN_PROGRESS_SAYS, ...missing.map((c) => c.says)] });
      continue;
    }
    choices.push({ to, skips, available: missing.length === 0, missing, reasons: missing.map((c) => c.says) });
  }

  return { applies: true, whyNot: null, entryMissing, choices };
}

/** "Sample / Trial and Sample received & review", for a sentence. */
export function skippedSentence(skips: readonly LeadStage[]): string {
  const names = skips.map((s) => stageLabel(s));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
