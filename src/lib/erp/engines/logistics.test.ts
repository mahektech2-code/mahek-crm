import { test } from "node:test";
import assert from "node:assert/strict";
import { attachRefusal, callDue, cleanCities, cleanPlace, freightWord, isPaidFreight, lrRowHasAnything, lrUploadName, customerMessage, dueWord, MAX_CITIES_PER_UPDATE, packagesOf, phaseOf, rankForLr, routeSentence, runningLate, trackingLink, waLink, watiParams, type MessageFacts } from "./logistics";

test("the phase is the stage and the LR together, never stored", () => {
  assert.equal(phaseOf({ lrNo: null, materialStage: "Dispatched" }), "toTransport");
  assert.equal(phaseOf({ lrNo: null, materialStage: "At transport" }), "lrPending");
  assert.equal(phaseOf({ lrNo: "", materialStage: "In Transit" }), "lrPending", "a stage moved with no LR still waits for the LR");
  assert.equal(phaseOf({ lrNo: "LR1", materialStage: "Dispatched" }), "onRoad");
  assert.equal(phaseOf({ lrNo: null, materialStage: "Close - Received to Party" }), "delivered");
});

test("due words are the floor's words", () => {
  assert.equal(dueWord("2026-10-10", "2026-10-10")?.word, "Today");
  assert.equal(dueWord("2026-10-11", "2026-10-10")?.word, "Tomorrow");
  assert.equal(dueWord("2026-10-08", "2026-10-10")?.word, "Late by 2 days");
  assert.equal(dueWord("2026-10-08", "2026-10-10")?.tone, "danger");
  assert.equal(dueWord(null, "2026-10-10"), null);
});

test("a call is due on its day and never after delivery; late is past the expected day or the limit", () => {
  assert.ok(callDue({ reminderDate: "2026-10-10", materialStage: "In Transit" }, "2026-10-10"));
  assert.ok(!callDue({ reminderDate: "2026-10-10", materialStage: "Close - Received to Party" }, "2026-10-12"));
  assert.ok(runningLate({ expectedDeliveryOn: "2026-10-09", billDate: "2026-10-08", materialStage: "In Transit" }, "2026-10-10", 7));
  assert.ok(!runningLate({ expectedDeliveryOn: null, billDate: "2026-10-05", materialStage: "In Transit" }, "2026-10-10", 7));
  assert.ok(runningLate({ expectedDeliveryOn: null, billDate: "2026-10-01", materialStage: "In Transit" }, "2026-10-10", 7));
});

test("an LR suggests the bills it most likely carries, and attaches none", () => {
  const ranked = rankForLr({ transporter: "VRL Logistics", packages: 12, destination: "Pune" }, [
    { id: "a", transporter: "Shree Transport", packages: 12, area: "Nagpur", party: "Om Paints", atTransport: true },
    { id: "b", transporter: "VRL", packages: 12, area: "Pune", party: "Shree Paints", atTransport: true },
    { id: "c", transporter: "VRL Logistics", packages: 3, area: "Pune", party: "Sai Hardware", atTransport: false },
  ]);
  assert.equal(ranked[0].id, "b");
  assert.deepEqual(ranked[0].reasons, ["same transporter", "destination matches", "12 boxes", "at the transporter"]);
  assert.equal(ranked[ranked.length - 1].id, "a");
});

test("one LR is one party; a bill under another LR or delivered cannot be attached", () => {
  const b = (id: string, party: string, lrId: string | null = null, stage = "At transport") => ({ id, orderNo: Number(id.slice(1)), deliveryPartyId: party, lrId, materialStage: stage });
  assert.equal(attachRefusal([b("o1", "p1"), b("o2", "p1")], "lr1"), null);
  assert.match(attachRefusal([b("o1", "p1"), b("o2", "p2")], "lr1")!, /different parties/);
  assert.match(attachRefusal([b("o1", "p1", "lr9")], "lr1")!, /already under another LR/);
  assert.equal(attachRefusal([b("o1", "p1", "lr1")], "lr1"), null, "re-attaching to its own LR is fine");
  assert.match(attachRefusal([b("o1", "p1", null, "Close - Received to Party")], "lr1")!, /reached the party/);
  assert.match(attachRefusal([], "lr1")!, /Tick/);
});

const facts: MessageFacts = {
  party: "Shree Paints",
  bills: ["MMI/26-27/1", "MMI/26-27/2"],
  lrNo: "LR-7781",
  lrDate: "2026-10-09",
  transporter: "VRL",
  packages: 12,
  stage: "In Transit",
  expectedOn: "2026-10-14",
  trackUrl: "https://one.example/track/abc",
  signature: "Mahek Marketing India",
};

test("the customer is told only what is on the record", () => {
  const lr = customerMessage("lr", facts);
  assert.match(lr, /bills MMI\/26-27\/1 and MMI\/26-27\/2 have been booked with VRL/);
  assert.match(lr, /LR no LR-7781 dated Fri 9 Oct · 12 boxes\./);
  assert.match(lr, /Expected delivery: Wed 14 Oct\./);
  assert.match(lr, /Track it: https:\/\/one.example\/track\/abc/);
  const bare = customerMessage("lr", { ...facts, packages: null, expectedOn: null, trackUrl: null });
  assert.doesNotMatch(bare, /box|Expected|Track/, "nothing nobody entered is guessed");
  assert.match(customerMessage("stage", { ...facts, stage: "Reached Destination Area" }), /has reached your area/);
  assert.match(customerMessage("issue", { ...facts, issue: "Delayed", issueNote: "lorry broke down" }), /is delayed — lorry broke down/);
  const done = customerMessage("delivered", { ...facts, deliveredOn: "2026-10-13", receivedBy: "Ramesh" });
  assert.match(done, /delivered on Tue 13 Oct, received by Ramesh/);
  assert.doesNotMatch(done, /Track it/);
});

test("wati params, wa.me links, tracking links and packages", () => {
  const p = watiParams("lr", facts, customerMessage("lr", facts));
  assert.equal(p.lr_no, "LR-7781");
  assert.equal(p.boxes, "12");
  assert.doesNotMatch(p.message, /\n/);
  assert.equal(waLink("98765 00001", "hi"), "https://wa.me/919876500001?text=hi");
  assert.equal(waLink("123", "hi"), null);
  assert.equal(trackingLink("https://vrl.example/t?lr={lr}", "LR 1"), "https://vrl.example/t?lr=LR%201");
  assert.equal(trackingLink("javascript:alert(1)", "x"), null);
  assert.equal(packagesOf([{ qtyCans: 13, cansPerBox: 6, boxed: true }, { qtyCans: 4, cansPerBox: null, boxed: false }]), 7);
});

test("no upload field is required: any one detail makes a row an LR, and an empty row is skipped", () => {
  assert.equal(lrRowHasAnything({}), false);
  assert.equal(lrRowHasAnything({ lrNo: "  ", note: "" }), false);
  assert.equal(lrRowHasAnything({ fileId: "f1" }), true, "a photo alone is enough");
  assert.equal(lrRowHasAnything({ transporter: "VRL" }), true);
  assert.equal(lrRowHasAnything({ packages: 0 }), true, "zero boxes is still something typed");
  assert.equal(lrUploadName("7781"), "LR 7781");
  assert.equal(lrUploadName(null), "LR (number not typed)");
});

test("paid freight is read however it was stored", () => {
  for (const v of ["paid", "Paid", " PAID "]) assert.ok(isPaidFreight(v), v);
  for (const v of ["to_pay", "To Pay", "TO-PAY", "TBB", "", null]) assert.ok(!isPaidFreight(v), String(v));
  assert.equal(freightWord("paid"), "Paid");
  assert.equal(freightWord("to_pay"), "To Pay");
  assert.equal(freightWord("To Pay"), "To Pay");
  assert.equal(freightWord("Courier"), "Courier", "anything else is shown as stored");
  assert.equal(freightWord(null), null);
});

test("cities reached: a place and a day each, never in the future or before the goods left, oldest first (0296)", () => {
  const ok = cleanCities(
    [
      { city: "  indore ", on: "2026-10-30" },
      { city: "Nashik", on: "2026-10-29" },
      { city: "", on: "" },
      { city: "Indore", on: "2026-10-30" },
    ],
    "2026-10-30",
    "2026-10-28",
  );
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.cities, [
    { city: "Nashik", on: "2026-10-29" },
    { city: "indore", on: "2026-10-30" },
  ]);
  assert.match((cleanCities([{ city: "Pune", on: "2026-10-31" }], "2026-10-30", null) as { error: string }).error, /future/);
  assert.match((cleanCities([{ city: "Pune", on: "2026-10-20" }], "2026-10-30", "2026-10-28") as { error: string }).error, /left on/);
  assert.match((cleanCities([{ city: "", on: "2026-10-30" }], "2026-10-30", null) as { error: string }).error, /Name the city/);
  assert.match((cleanCities([{ city: "Pune", on: "" }], "2026-10-30", null) as { error: string }).error, /day it reached Pune/);
  const many = Array.from({ length: MAX_CITIES_PER_UPDATE + 1 }, (_, i) => ({ city: `Town ${i}`, on: "2026-10-30" }));
  assert.ok(!cleanCities(many, "2026-10-30", null).ok);
  assert.equal(cleanPlace("   "), null);
  assert.equal(cleanPlace("  Bhiwandi   booking  office "), "Bhiwandi booking office");
});

test("the route line says only what was reported, and a ready-for-pickup message says where to collect (0296)", () => {
  assert.equal(routeSentence({ stage: "In Transit", dispatchedFrom: "Bhiwandi", city: "Bhiwandi", cityOn: null, destination: "Indore" }), "Dispatched from Bhiwandi · going to Indore.");
  assert.equal(routeSentence({ stage: "In Transit", dispatchedFrom: "Bhiwandi", city: "Nashik", cityOn: "2026-10-29", destination: "Indore" }), "Reached Nashik on Thu 29 Oct · going to Indore.");
  assert.equal(routeSentence({ stage: "Reached Destination Area", city: "Indore", cityOn: "2026-10-30", destination: "Indore" }), "Reached Indore on Fri 30 Oct.");
  assert.equal(routeSentence({ stage: "In Transit" }), null);
  const f: MessageFacts = { party: "ADYESH", bills: ["MMI/26-27/1868"], lrNo: "956149749", lrDate: null, transporter: "Kerala Roadways", packages: null, stage: "Ready for Pickup", expectedOn: null, trackUrl: null, signature: "Mahek", pickupPoint: "Kerala Roadways, Vadakara office", pickupContact: "Suresh 98xxxxxx" };
  const body = customerMessage("stage", f);
  assert.match(body, /ready for you to collect from Kerala Roadways/);
  assert.match(body, /Collect it from: Kerala Roadways, Vadakara office \(Suresh 98xxxxxx\)/);
});
