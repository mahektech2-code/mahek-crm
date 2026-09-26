/**
 * The calling desk's three calls and its request, pinned.
 *
 * The things worth failing the build over are the ones that were asked for in
 * as many words: ready as soon as the five answers are in (never forcing the
 * next call), Call 3 becoming available, a Call 3 that finishes short ending
 * the lead with no Call 4, no question being asked twice — and, above all, that
 * ASKING for a Prospect is not being one.
 *
 * Pure, like the engine: no database, no clock.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CALL_OUTCOMES,
  DESK_FIELDS,
  DESK_LOST_REASONS,
  MAX_QUALIFICATION_CALLS,
  afterCall,
  crmOutcomeFor,
  deskLadderSalesType,
  deskLostFiledAs,
  inView,
  isAnswered,
  isPending,
  isWorking,
  ladderKeyOf,
  ladderKeyOfLost,
  lostCodeForCause,
  nextActionKindOf,
  nextActionTypeLabel,
  nextActionText,
  nextCallNumber,
  parseLostNote,
  phaseOf,
  questionsForCall,
  requiredProgress,
  suggestedLostCode,
  type DeskLeadFacts,
  type DeskValues,
} from "./lead-calling-desk";
import { deskReference, displayAnswer, shortDay } from "../calling-desk-labels";
import { DESK_LIST_CAP, deskSummary, type DeskLeadRow } from "../calling-desk-summary";
import { ladderFor } from "./lead-ladder";

const call1Answers: DeskValues = {
  monthlyLitres: 200,
  requiredProductId: "prd_1",
  competitor: "Local thinner",
};
const all5: DeskValues = { ...call1Answers, decisionMaker: "Owner", potentialPaise: 6_000_000 };

describe("the twelve answers, five of them required", () => {
  test("the five that make a lead ready are the five the funnel already stores", () => {
    assert.deepEqual(
      DESK_FIELDS.filter((f) => f.required).map((f) => f.key).sort(),
      ["competitor", "decisionMaker", "monthlyLitres", "potentialPaise", "requiredProductId"],
    );
  });

  test("there are twelve, in the manager's own Opportunity order", () => {
    assert.equal(DESK_FIELDS.length, 12);
    assert.deepEqual(
      DESK_FIELDS.map((f) => f.label),
      [
        "Customer type", "Decision maker", "Buyer", "GST", "Monthly requirement", "Expected monthly sales",
        "Credit days", "Product", "Competitor", "Application", "Address", "Email",
      ],
    );
  });

  test("progress counts what is on the record and names what is missing", () => {
    const p = requiredProgress(call1Answers);
    assert.equal(p.done, 3);
    assert.equal(p.total, 5);
    assert.equal(p.complete, false);
    assert.deepEqual(p.missing.map((f) => f.key).sort(), ["decisionMaker", "potentialPaise"]);
    assert.equal(requiredProgress(all5).complete, true);
  });

  test("blank text, zero litres and zero rupees are not answers; zero credit days is", () => {
    assert.equal(isAnswered("competitor", "   "), false);
    assert.equal(isAnswered("monthlyLitres", 0), false);
    assert.equal(isAnswered("potentialPaise", 0), false);
    assert.equal(isAnswered("competitor", "Asian"), true);
    assert.equal(isAnswered("creditDaysWanted", 0), true);
    assert.equal(isAnswered("creditDaysWanted", null), false);
  });
});

describe("Test A — ready as soon as the five are in, without forcing another call", () => {
  test("Call 1 partial, Call 2 completes: ready after two calls, not three", () => {
    assert.equal(phaseOf("suspect", {}, 0), "call1");
    assert.equal(phaseOf("suspect", call1Answers, 1), "call2");
    assert.equal(phaseOf("suspect", all5, 2), "ready");
  });

  test("all five on Call 1 is ready straight away — no Call 2 is owed", () => {
    assert.equal(phaseOf("suspect", all5, 1), "ready");
    assert.equal(nextCallNumber("ready"), null);
    assert.deepEqual(
      afterCall({ callNumber: 1, outcome: "spoke_collected", merged: all5, priorOutcomes: [] }),
      { kind: "ready" },
    );
  });

  test("the last answer arriving on Call 3 is ready, not lost", () => {
    assert.deepEqual(
      afterCall({ callNumber: 3, outcome: "spoke_collected", merged: all5, priorOutcomes: ["spoke_callback", "spoke_callback"] }),
      { kind: "ready" },
    );
    assert.equal(phaseOf("suspect", all5, 3), "ready");
  });

  test("the legacy spellings of a suspect are worked the same way", () => {
    assert.equal(phaseOf("new", {}, 0), "call1");
    assert.equal(phaseOf("contacted", call1Answers, 1), "call2");
  });
});

describe("A request is not a Prospect", () => {
  test("a lead that has asked stays on the Suspect rung of the ladder", () => {
    for (const state of ["awaiting", "followup", "returned"] as const) {
      const phase = phaseOf("suspect", all5, 2, state);
      assert.equal(ladderKeyOf(phase), "suspect", state);
    }
  });

  test("each request state is its own phase and outranks the calls and readiness", () => {
    assert.equal(phaseOf("suspect", all5, 2, "awaiting"), "requested");
    assert.equal(phaseOf("suspect", all5, 2, "followup"), "followup");
    assert.equal(phaseOf("suspect", all5, 2, "returned"), "returned");
    /* Even a lead that would otherwise be owed a call. */
    assert.equal(phaseOf("suspect", {}, 0, "awaiting"), "requested");
  });

  test("while the manager has it, the desk is offered no call", () => {
    assert.equal(nextCallNumber(phaseOf("suspect", all5, 2, "awaiting")), null);
    assert.equal(nextCallNumber(phaseOf("suspect", all5, 2, "followup")), null);
    assert.equal(nextCallNumber(phaseOf("suspect", all5, 2, "returned")), null);
    assert.equal(isPending("requested"), true);
    assert.equal(isPending("followup"), true);
    assert.equal(isPending("returned"), false, "returned is with the desk, not the manager");
  });

  test("it becomes a Prospect only when the stage itself has moved", () => {
    assert.equal(phaseOf("prospect", all5, 2, null), "prospect");
    assert.equal(ladderKeyOf("prospect"), "prospect");
    /* A stale request state on a lead that already moved is not read. */
    assert.equal(phaseOf("prospect", all5, 2, "awaiting"), "prospect");
  });

  test("a returned lead is resubmitted or closed, never rung", () => {
    assert.equal(isWorking("returned"), false);
    assert.equal(nextCallNumber("returned"), null);
  });
});

describe("Test B — Call 3 becomes available", () => {
  test("two incomplete calls make the third the one owed", () => {
    assert.equal(phaseOf("suspect", call1Answers, 2), "call3");
    assert.equal(nextCallNumber("call3"), 3);
  });

  test("after an incomplete Call 1 or Call 2 the next call is named", () => {
    assert.deepEqual(
      afterCall({ callNumber: 1, outcome: "spoke_callback", merged: call1Answers, priorOutcomes: [] }),
      { kind: "next", callNumber: 2 },
    );
    assert.deepEqual(
      afterCall({ callNumber: 2, outcome: "no_answer", merged: call1Answers, priorOutcomes: ["spoke_callback"] }),
      { kind: "next", callNumber: 3 },
    );
  });
});

describe("Test C — lost after Call 3, and there is no Call 4", () => {
  test("Call 3 finished and still short is lost", () => {
    assert.deepEqual(
      afterCall({ callNumber: 3, outcome: "spoke_callback", merged: call1Answers, priorOutcomes: ["spoke_callback", "spoke_callback"] }),
      { kind: "lost", cause: "information_missing" },
    );
  });

  test("three calls nobody answered is a different loss from three that would not say", () => {
    assert.deepEqual(
      afterCall({ callNumber: 3, outcome: "no_answer", merged: {}, priorOutcomes: ["no_answer", "no_answer"] }),
      { kind: "lost", cause: "no_response" },
    );
  });

  test("no phase ever offers a call above the third", () => {
    assert.equal(MAX_QUALIFICATION_CALLS, 3);
    assert.equal(phaseOf("suspect", call1Answers, 3), "exhausted");
    assert.equal(phaseOf("suspect", call1Answers, 9), "exhausted");
    assert.equal(nextCallNumber("exhausted"), null);
    for (const n of [0, 1, 2, 3, 4, 10]) {
      const next = nextCallNumber(phaseOf("suspect", {}, n));
      assert.ok(next === null || next <= 3, `call ${next} offered at ${n} made`);
    }
  });

  test("a Call 3 can never be answered with a Call 4 disposition", () => {
    for (const outcome of CALL_OUTCOMES.map((o) => o.code)) {
      const d = afterCall({ callNumber: 3, outcome, merged: {}, priorOutcomes: [] });
      assert.notEqual(d.kind, "next", `${outcome} on Call 3 asked for another call`);
    }
  });

  test("somebody saying no, or a wrong number, ends it at any call", () => {
    assert.deepEqual(
      afterCall({ callNumber: 1, outcome: "not_interested", merged: {}, priorOutcomes: [] }),
      { kind: "lost", cause: "not_interested" },
    );
    assert.deepEqual(
      afterCall({ callNumber: 2, outcome: "wrong_number", merged: call1Answers, priorOutcomes: [] }),
      { kind: "lost", cause: "wrong_number" },
    );
  });
});

describe("Test D — no question is asked twice", () => {
  test("what Call 1 captured is not offered on Call 2", () => {
    const q = questionsForCall(call1Answers, 2);
    const offered = [...q.askNow, ...q.later].map((f) => f.key);
    for (const key of Object.keys(call1Answers)) assert.ok(!offered.includes(key as never), `${key} was asked again`);
    assert.deepEqual(q.answered.map((f) => f.key).sort(), ["competitor", "monthlyLitres", "requiredProductId"]);
  });

  test("what Call 2 captured is not offered on Call 3, and what is left of the five is what Call 3 is for", () => {
    const q = questionsForCall({ ...call1Answers, decisionMaker: "Owner" }, 3);
    const offered = [...q.askNow, ...q.later].map((f) => f.key);
    assert.ok(!offered.includes("decisionMaker"));
    assert.deepEqual(q.askNow.filter((f) => f.required).map((f) => f.key), ["potentialPaise"]);
  });

  test("a question is either asked, deferred or answered — never two of them", () => {
    for (const call of [1, 2, 3]) {
      const q = questionsForCall(call1Answers, call);
      const all = [...q.askNow, ...q.later, ...q.answered].map((f) => f.key);
      assert.equal(new Set(all).size, all.length);
      assert.equal(all.length, DESK_FIELDS.length);
    }
  });

  test("the required ones lead, and the last call asks every one still missing", () => {
    const q = questionsForCall({}, 3);
    const firstOptional = q.askNow.findIndex((f) => !f.required);
    assert.ok(firstOptional === -1 || q.askNow.map((f) => f.required).lastIndexOf(true) < firstOptional);
    for (const f of DESK_FIELDS.filter((x) => x.required)) assert.ok(q.askNow.includes(f), f.key);
  });
});

describe("where a lead stands outside the suspect rung", () => {
  test("a lead past the desk is not the desk's work, and each rung is its own phase", () => {
    for (const rung of [
      "prospect", "qualification", "sample_trial", "sample_received", "sample_review", "negotiation",
      "first_order", "delivery", "payment", "second_order", "customer",
    ] as const) {
      assert.equal(phaseOf(rung, all5, 2), rung);
      assert.equal(nextCallNumber(phaseOf(rung, {}, 0)), null, rung);
    }
    assert.equal(phaseOf("lost", {}, 3), "lost");
    assert.equal(phaseOf("on_hold", {}, 1), "parked");
  });

  test("the legacy rungs fold onto the ones the desk draws", () => {
    assert.equal(phaseOf("qualified", all5, 2), "qualification");
    assert.equal(phaseOf("won", all5, 2), "customer");
  });
});

describe("the desk's outcomes and words", () => {
  test("every desk outcome maps onto one the call reports already count", () => {
    const legal = new Set(["follow_up", "no_answer", "not_interested"]);
    for (const o of CALL_OUTCOMES) assert.ok(legal.has(crmOutcomeFor(o.code)), o.code);
  });

  test("a next action is a call only when it says Call <n>, and the dialog's text round-trips", () => {
    assert.equal(nextActionKindOf("Call 2 — the remaining questions"), "call");
    assert.equal(nextActionKindOf("call 3: last attempt"), "call");
    assert.equal(nextActionKindOf("Send information on WhatsApp, then ring back"), "message");
    assert.equal(nextActionKindOf(""), null);
    assert.equal(nextActionKindOf(null), null);
    assert.equal(nextActionKindOf(nextActionText("call", 2, "ask about credit")), "call");
    assert.equal(nextActionKindOf(nextActionText("message", 2, "Call 2 — send the brochure")), "message");
    assert.equal(nextActionKindOf(nextActionText("message", 2, "")), "message");
  });

  test("the desk's six lost reasons all file under codes that exist in the default configuration", async () => {
    const { LOST_REASONS } = await import("../lead-labels");
    const configured = new Set(LOST_REASONS.map((r) => r.code));
    for (const r of DESK_LOST_REASONS) {
      assert.ok(configured.has(r.filedAs), `${r.code} files under ${r.filedAs}, which is not a configured code`);
      assert.equal(deskLostFiledAs(r.code), r.filedAs);
    }
    for (const cause of ["wrong_number", "not_interested", "no_response", "information_missing"] as const) {
      assert.ok(DESK_LOST_REASONS.some((r) => r.code === lostCodeForCause(cause)), cause);
    }
  });

  test("the lost reason is suggested from how the calls went", () => {
    assert.equal(suggestedLostCode([], "not_interested"), "not_interested");
    assert.equal(suggestedLostCode([], "wrong_number"), "wrong_lead");
    assert.equal(suggestedLostCode(["no_answer", "no_answer"], "no_answer"), "no_response_3");
    assert.equal(suggestedLostCode(["spoke_callback"], "no_answer"), "info_not_obtained");
  });
});

describe("the desk's lists and tiles", () => {
  const day = "2026-09-24";
  const lead = (over: Partial<DeskLeadFacts>): DeskLeadFacts => ({
    phase: "call1",
    callCount: 0,
    source: "Website / Online Enquiry",
    nextActionDate: day,
    nextActionKind: "call",
    requested: false,
    ...over,
  });

  test("new online leads are the ones nobody has rung yet, read off the words a source is typed in", () => {
    for (const s of ["Website / Online Enquiry", "IndiaMART", "Google Ads", "WhatsApp Enquiry"]) {
      assert.equal(inView(lead({ source: s }), "new", day), true, s);
    }
    for (const s of ["Salesman Prospecting", "Walk-in", "Exhibition / Trade Fair", "", null]) {
      assert.equal(inView(lead({ source: s }), "new", day), false, String(s));
    }
    assert.equal(inView(lead({ callCount: 1, phase: "call2" }), "new", day), false);
  });

  test("calls due today are calls owed exactly today; overdue is anything before", () => {
    assert.equal(inView(lead({ nextActionDate: day }), "today", day), true);
    assert.equal(inView(lead({ nextActionDate: "2026-09-20" }), "today", day), false);
    assert.equal(inView(lead({ nextActionDate: "2026-09-20" }), "overdue", day), true);
    assert.equal(inView(lead({ nextActionDate: "2026-09-26" }), "overdue", day), false);
    assert.equal(inView(lead({ phase: "ready" }), "overdue", day), false);
  });

  test("a message follow-up is a follow-up, not a call", () => {
    const m = lead({ callCount: 1, phase: "call2", nextActionKind: "message" });
    assert.equal(inView(m, "followups", day), true);
    assert.equal(inView(m, "today", day), false);
  });

  test("a fresh lead with nothing scheduled is owed its first call today", () => {
    const fresh = lead({ nextActionDate: null, nextActionKind: null });
    assert.equal(inView(fresh, "today", day), true);
    assert.equal(inView(fresh, "queue", day), true);
    /* But a lead already rung and left unscheduled is not silently due. */
    assert.equal(inView(lead({ callCount: 1, phase: "call2", nextActionDate: null, nextActionKind: null }), "queue", day), false);
  });

  test("the three call tiles each hold only their own phase", () => {
    assert.equal(inView(lead({ phase: "call2", callCount: 1 }), "call2", day), true);
    assert.equal(inView(lead({ phase: "call2", callCount: 1 }), "call1", day), false);
    assert.equal(inView(lead({ phase: "call3", callCount: 2 }), "call3", day), true);
  });

  test("today's queue holds what is ready or returned plus what is due, and not what is pending or resting", () => {
    assert.equal(inView(lead({ phase: "ready", callCount: 2 }), "queue", day), true);
    assert.equal(inView(lead({ phase: "returned", callCount: 2 }), "queue", day), true);
    assert.equal(inView(lead({ phase: "requested", callCount: 2 }), "queue", day), false);
    assert.equal(inView(lead({ nextActionDate: "2026-10-05" }), "queue", day), false);
  });

  test("verification, returned and handed-over each read the request", () => {
    assert.equal(inView(lead({ phase: "requested", requested: true }), "verify", day), true);
    assert.equal(inView(lead({ phase: "followup", requested: true }), "verify", day), true);
    assert.equal(inView(lead({ phase: "returned", requested: true }), "verify", day), false);
    assert.equal(inView(lead({ phase: "returned", requested: true }), "returned", day), true);
    assert.equal(inView(lead({ phase: "requested", requested: true }), "requested", day), true);
    /* "With the Sales Manager" is everything the desk ever asked for, until lost. */
    assert.equal(inView(lead({ phase: "prospect", requested: true }), "handed", day), true);
    assert.equal(inView(lead({ phase: "lost", requested: true }), "handed", day), false);
    assert.equal(inView(lead({ phase: "prospect", requested: false }), "handed", day), false);
  });

  test("stage tiles and the two roll-ups read the phase", () => {
    assert.equal(inView(lead({ phase: "sample_received" }), "sample", day), true);
    assert.equal(inView(lead({ phase: "negotiation" }), "sample", day), false);
    assert.equal(inView(lead({ phase: "second_order" }), "orders", day), true);
    assert.equal(inView(lead({ phase: "prospect" }), "prospect", day), true);
    assert.equal(inView(lead({ phase: "lost" }), "lost", day), true);
    assert.equal(inView(lead({ phase: "lost" }), "all", day), true);
  });

  test("the suspect view holds every phase that is still on the Suspect rung", () => {
    for (const phase of ["call1", "call2", "call3", "ready", "exhausted", "requested", "followup", "returned"] as const) {
      assert.equal(inView(lead({ phase }), "suspect", day), true, phase);
    }
    assert.equal(inView(lead({ phase: "prospect" }), "suspect", day), false);
  });
});

describe("round three: where a lead stands, said the way V6 says it", () => {
  test("an undecided sales type is drawn on the Direct ladder, never the six-rung legacy one", () => {
    assert.equal(deskLadderSalesType(null), "direct");
    assert.equal(deskLadderSalesType(undefined), "direct");
    assert.equal(deskLadderSalesType("third_party"), "third_party");
    assert.ok(ladderFor(deskLadderSalesType(null)).includes("prospect"), "the legacy ladder has no Prospect rung");
    assert.ok(ladderFor(deskLadderSalesType(null)).includes("qualification"));
  });

  test("a lost lead keeps the rung it was lost on", () => {
    assert.equal(ladderKeyOfLost("suspect", call1Answers, 2), "suspect");
    assert.equal(ladderKeyOfLost("new", {}, 3), "suspect");
    assert.equal(ladderKeyOfLost("qualification", {}, 3), "qualification");
    assert.equal(ladderKeyOfLost("sample_review", {}, 3), "sample_review");
    /* No move on record, or a move from nowhere: it was a Suspect. */
    assert.equal(ladderKeyOfLost(null, {}, 0), "suspect");
    assert.equal(ladderKeyOfLost("lost", {}, 0), "suspect");
  });

  test("the next action's type follows where the lead stands before it reads the sentence", () => {
    assert.equal(nextActionTypeLabel("ready", "call"), "Follow-up", "stale 'Call 2' text on a Ready lead is not a phone call");
    assert.equal(nextActionTypeLabel("ready", null), "Follow-up");
    assert.equal(nextActionTypeLabel("returned", "call"), "Follow-up");
    assert.equal(nextActionTypeLabel("requested", "message"), "Verification review");
    assert.equal(nextActionTypeLabel("followup", "call"), "Verification review");
    assert.equal(nextActionTypeLabel("call2", "call"), "Phone call");
    assert.equal(nextActionTypeLabel("call2", "message"), "Message (no call used)");
    assert.equal(nextActionTypeLabel("call1", null), "Message (no call used)");
    assert.equal(nextActionTypeLabel("prospect", "message"), "Follow-up");
  });

  test("the desk's lost label is read back off the note it was written into", () => {
    for (const r of DESK_LOST_REASONS) {
      assert.deepEqual(parseLostNote(`${r.label} — spoke to his brother`), { label: r.label, detail: "spoke to his brother" });
      assert.deepEqual(parseLostNote(r.label), { label: r.label, detail: null });
    }
    assert.deepEqual(parseLostNote("Closed by the manager"), { label: null, detail: "Closed by the manager" });
    assert.deepEqual(parseLostNote(null), { label: null, detail: null });
  });

  test("a reference is TC- and a number, never a slice of an id", () => {
    assert.equal(deskReference(0), "TC-1000");
    assert.equal(deskReference(42), "TC-1042");
    assert.match(deskReference(5926), /^TC-\d{4,}$/);
  });

  test("a GST number says whether anybody has checked it", () => {
    assert.equal(displayAnswer("gstin", "27ABCDE1234F1Z5", null, false), "27ABCDE1234F1Z5 (Awaiting check)");
    assert.equal(displayAnswer("gstin", "27ABCDE1234F1Z5", null, true), "27ABCDE1234F1Z5 (Verified)");
    assert.equal(displayAnswer("gstin", null, null, true), "—");
  });

  test("dates are the desk's one short shape", () => {
    assert.equal(shortDay("2026-09-23"), "23 Sep");
    assert.equal(shortDay("2026-09-23T20:00:00.000Z"), "24 Sep", "an instant is read in IST: 01:30 on the 24th");
    assert.equal(shortDay(null), "—");
  });
});

describe("the dashboard filters in the page", () => {
  const day = "2026-09-24";
  const row = (over: Partial<DeskLeadRow> & { id: string }): DeskLeadRow => ({
    name: over.id,
    city: null,
    source: "Website enquiry",
    stage: "suspect",
    salesType: null,
    priority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    nextAction: null,
    nextActionDate: null,
    nextActionKind: null,
    responsible: null,
    callCount: 0,
    callOutcomes: [],
    phase: "call1",
    nextCall: 1,
    answered: 0,
    required: 5,
    ladderKey: "suspect",
    requestedAt: null,
    ...over,
  });
  const book: DeskLeadRow[] = [
    row({ id: "a" }),
    row({ id: "b", phase: "call2", callCount: 1, nextCall: 2, nextActionDate: day, nextActionKind: "call" }),
    row({ id: "c", phase: "ready", callCount: 2, nextCall: null }),
    row({ id: "d", phase: "requested", callCount: 2, nextCall: null, requestedAt: "2026-09-20T00:00:00.000Z", responsible: "Vikram" }),
    row({ id: "e", phase: "lost", stage: "lost", callCount: 3, nextCall: null, ladderKey: "suspect" }),
    row({ id: "f", phase: "qualification", stage: "qualification", ladderKey: "qualification", callCount: 2, nextCall: null }),
  ];

  test("every tile counts what its list holds", () => {
    const s = deskSummary(book, "all", day);
    for (const [view, n] of Object.entries(s.tiles)) {
      assert.equal(deskSummary(book, view as never, day).total, n, view);
    }
    assert.equal(s.tiles.all, 6);
    assert.equal(s.tiles.ready, 1);
    assert.equal(s.tiles.verify, 1);
    assert.equal(s.tiles.lost, 1);
  });

  test("changing the view changes the list and not the tiles", () => {
    const a = deskSummary(book, "ready", day);
    const b = deskSummary(book, "lost", day);
    assert.deepEqual(a.tiles, b.tiles);
    assert.deepEqual(a.rows.map((r) => r.id), ["c"]);
    assert.deepEqual(b.rows.map((r) => r.id), ["e"]);
  });

  test("the lifecycle counts a lost lead nowhere, and shows the manager's waiting on the Prospect rung", () => {
    const s = deskSummary(book, "queue", day);
    assert.equal(s.lifecycle.find((c) => c.key === "suspect")?.count, 4, "a, b, c and d — not the lost one");
    assert.equal(s.lifecycle.find((c) => c.key === "prospect")?.waiting, 1);
    assert.equal(s.lifecycle.find((c) => c.key === "qualification")?.count, 1);
  });

  test("the side cards are the ready and the pending, whatever the view", () => {
    const s = deskSummary(book, "lost", day);
    assert.deepEqual(s.ready.map((r) => r.id), ["c"]);
    assert.deepEqual(s.pending.map((r) => r.id), ["d"]);
    assert.ok(DESK_LIST_CAP >= 100);
  });
});
