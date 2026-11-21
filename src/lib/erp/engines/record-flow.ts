import { stamp } from "@/lib/format";
import { nf } from "../ui";
import type { RecordFlow } from "../ui";

/* ---------------------------------------------------------------------------
 * A PURCHASE RECORD'S FLOW, for the pop-up every Purchase page shares
 * (`record-dialog.tsx`): its steps and where it is, what it waits on (the
 * Next step card, beside the row's primary action) and what happened to it.
 * Read from each row's own facts and never typed. Pure, so the rules are
 * pinned by `record-flow.test.ts` without a database.
 * ------------------------------------------------------------------------- */

/** A PO's own steps on its record — raised, approved, shared, goods in. */
export const PO_STEPS = ["Raised", "Approved", "Shared with supplier", "Goods received"];

/**
 * A PO's record flow: where it is in its four steps, what it waits on (the
 * Next step card, beside the row's primary action) and what happened to it,
 * from its own row. Pure over the view, so the list and the record agree.
 */
export type PoFacts = {
  po: { status: string; createdAt: Date; approvedAt: Date | null; sentAt: Date | null; sentVia: string | null; closedAt: Date | null; closeReason: string | null; decisionNote: string | null };
  by: string | null;
  approver: string | null;
};

export function poRecord(p: PoFacts, received: string, shared: string | null): RecordFlow {
  const st = p.po.status;
  const step =
    st === "Pending approval" ? 1 : st === "Approved" ? 2 : st === "Sent" || st === "Partly received" ? 3 : st === "Received" || st === "Closed" ? 4 : -1;
  const history: RecordFlow["history"] = [{ at: stamp(p.po.createdAt), text: `Raised${p.by ? ` by ${p.by}` : ""}` }];
  if (p.po.approvedAt)
    history.push({
      at: stamp(p.po.approvedAt),
      text: `${st === "Rejected" ? "Sent back" : "Approved"}${p.approver ? ` by ${p.approver}` : ""}${p.po.decisionNote ? ` — ${p.po.decisionNote}` : ""}`,
    });
  if (p.po.sentAt) history.push({ at: stamp(p.po.sentAt), text: `Shared with the supplier${p.po.sentVia ? ` on ${p.po.sentVia}` : ""}` });
  if (p.po.closedAt)
    history.push({ at: stamp(p.po.closedAt), text: `${st === "Cancelled" ? "Cancelled" : st === "Closed" ? "Closed short" : "Closed"}${p.po.closeReason ? ` — ${p.po.closeReason}` : ""}` });
  const waiting: Record<string, [string, string | null, string]> = {
    "Pending approval": ["Approve the PO", "Nothing goes to the supplier until it is approved", "approve"],
    Rejected: ["Correct the PO and send it again", p.po.decisionNote ? `Sent back: ${p.po.decisionNote}` : null, "edit"],
    Approved: ["Share the PO with the supplier", "On WhatsApp, by email or as a link", "share"],
    Sent: ["Receive the goods at the gate", `Received ${received}${shared ? ` · shared ${shared}` : ""}`, "receive"],
    "Partly received": ["Receive the rest at the gate", `Received ${received}`, "receive"],
  };
  const w = waiting[st];
  if (w && step >= 0 && step < PO_STEPS.length) history.push({ at: "Waiting", text: w[0], open: true });
  return { steps: PO_STEPS, step: st === "Rejected" ? 1 : step, ...(w ? { next: w[0], nextSub: w[1] ?? undefined, act: w[2] } : {}), history };
}

/**
 * A receipt line's record flow: received at the gate, then sent on — to Lot
 * testing where its material is tested, else to Bills. Read off its own row
 * (`routed`, `routed_at`), so the record says only what the line knows.
 */
export function receiptRecord(
  r: { routed: string | null; routedAt: Date | null; testingRequired: boolean; createdAt: Date },
  by: string | null,
): RecordFlow {
  const toTesting = r.routed ? r.routed === "Testing" : r.testingRequired;
  const onward = toTesting ? "Sent to Lot testing" : "Sent to Bills";
  const history: NonNullable<RecordFlow["history"]> = [{ at: stamp(r.createdAt), text: `Received at the gate${by ? ` by ${by}` : ""}` }];
  if (r.routed) history.push({ at: r.routedAt ? stamp(r.routedAt) : "—", text: onward });
  else history.push({ at: "Waiting", text: toTesting ? "Sending it to Lot testing" : "Sending it to Bills", open: true });
  return {
    steps: ["Received at the gate", onward],
    step: r.routed ? 2 : 1,
    ...(r.routed ? {} : { next: toTesting ? "Send it to Lot testing" : "Send it to Bills", nextSub: "Nothing is tested or billed until it is sent on" }),
    history,
  };
}

/**
 * A lot's record on Lot testing: arrived, test recorded, verified. A lot the
 * verifier marked not verified is a stopped flow. What it waits on follows
 * the sub-tab it sits in — the test, the missing evidence, the verifier.
 */
export function testRecord(t: {
  arrived: Date;
  tests: readonly string[];
  recorded?: { at: Date; by: string | null };
  bucket?: string;
  missing?: readonly string[];
  decidedAt?: Date | null;
  verifier?: boolean;
}): RecordFlow {
  const steps = ["Arrived", "Test recorded", "Verified"];
  const history: NonNullable<RecordFlow["history"]> = [{ at: stamp(t.arrived), text: "Arrived at the gate" }];
  if (t.recorded) history.push({ at: stamp(t.recorded.at), text: `Test recorded${t.recorded.by ? ` by ${t.recorded.by}` : ""}` });
  if (t.decidedAt) history.push({ at: stamp(t.decidedAt), text: t.bucket === "failed" ? "Marked not verified" : "Verified" });
  const tests = t.tests.length ? t.tests.join(", ") : null;
  let next: [string, string] | null = null;
  if (!t.recorded) next = ["Record the test", tests ? `Tests: ${tests}` : "The tests its material needs"];
  else if (t.bucket === "toVerify")
    next = t.missing?.length ? ["Record the missing evidence", `Missing: ${t.missing.join(", ")}`] : ["Verify the test", t.verifier ? "Evidence complete" : "Evidence complete · the verifier decides"];
  if (next) history.push({ at: "Waiting", text: next[0], open: true });
  const step = t.bucket === "failed" ? -1 : t.bucket === "verified" ? 3 : t.recorded ? 2 : 1;
  return { steps, step, ...(next ? { next: next[0], nextSub: next[1] } : {}), history };
}

/**
 * A lot's record flow on Bills: arrived (or tested), the supplier's bill,
 * matched to the PO, verified — `purchaseStage`'s progress (passed in) as steps. A lot
 * with no rate waits on the rate first: it is held out of stock until then.
 * Said only to somebody who may see purchase money, as the Stage column is.
 */
export function billRecord(
  p: { testId: string | null; ratePaise: number | null; billNumber: string | null; createdAt: Date },
  stage: string,
  by: string | null,
): RecordFlow {
  const steps = [p.testId ? "Tested" : "Arrived", "Bill received", "Matched", "Verified"];
  const step = stage === "Verified" ? 4 : stage === "Matched" ? 3 : stage === "Bill received" ? 2 : 1;
  const rated = !!p.ratePaise && p.ratePaise > 0;
  const waiting: [string, string, string] | null = !rated
    ? ["Enter the purchase rate", "Held out of stock until the rate is entered", "rate"]
    : step === 1
      ? ["Record the supplier's bill", "The bill number, once the bill is in hand", "billReceived"]
      : step === 2
        ? ["Match the bill to the PO", `Bill ${p.billNumber ?? "received"} · check its rate against the PO`, "status"]
        : step === 3
          ? ["Verify the purchase", "The last check before the lot is closed", "status"]
          : null;
  /* The register keeps no time for the bill or the match, so the steps say how far it got and the history only what has a time. */
  const history: NonNullable<RecordFlow["history"]> = [{ at: stamp(p.createdAt), text: `Lot made${by ? ` by ${by}` : ""}${p.billNumber ? ` · bill ${p.billNumber}` : ""}` }];
  if (waiting) history.push({ at: "Waiting", text: waiting[0], open: true });
  return { steps, step: waiting && step === 4 ? 3 : step, ...(waiting ? { next: waiting[0], nextSub: waiting[1], act: waiting[2] } : {}), history };
}

/**
 * A lot's record on Drum labels: made, then its labels printed. Its history is
 * every print in the log — reprints included, who and how many — so the pop-up
 * answers "were these printed, and by whom" without opening anything else.
 */
export function labelRecord(made: Date, by: string | null, labels: number, prints: readonly PrintEntry[]): RecordFlow {
  const history: NonNullable<RecordFlow["history"]> = [{ at: stamp(made), text: `Lot made${by ? ` by ${by}` : ""}` }];
  for (const p of prints)
    history.push({ at: stamp(p.at), text: `${p.reprint ? "Reprinted" : "Printed"} ${nf(p.copies)} label${p.copies === 1 ? "" : "s"}${p.by ? ` by ${p.by}` : ""}` });
  if (!prints.length) history.push({ at: "Waiting", text: "Its drum labels", open: true });
  return {
    steps: ["Lot made", "Labels printed"],
    step: prints.length ? 2 : 1,
    ...(prints.length ? {} : { next: "Print the drum labels", nextSub: `${nf(labels)} label${labels === 1 ? "" : "s"} · one for every drum` }),
    history,
  };
}

export type PrintEntry = { at: Date; by: string | null; copies: number; reprint: boolean };

