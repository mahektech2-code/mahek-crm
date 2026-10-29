import { test } from "node:test";
import assert from "node:assert/strict";
import { billKey, confidentPick, duplicateFlags, editDistance, missingFor, normNo, rankForSignedCopy, wrongKind, type DeskCopy } from "./delivery-proof";
import { customerMessage, isMahekVehicle, MAHEK_VEHICLE, phaseOf } from "./logistics";

const base: DeskCopy = { id: "a", kind: "lr", status: "unassigned", lrNo: null, readLrNo: null, readKind: null, transporter: "VRL Logistics", lrDate: "2026-10-28", packages: 12, contentHash: null, billHint: null, partyHint: null, uploadedAt: "2026-10-29T09:00:00Z", dupClearedAt: null };
const at = (m: number) => `2026-10-29T09:${String(m).padStart(2, "0")}:00Z`;

test("our own vehicle goes straight on the road, with no LR to wait for", () => {
  assert.ok(isMahekVehicle(" mahek vehicle "));
  assert.ok(!isMahekVehicle("VRL Logistics"));
  assert.equal(phaseOf({ lrNo: null, materialStage: "Dispatched", transporter: MAHEK_VEHICLE }), "onRoad");
  assert.equal(phaseOf({ lrNo: null, materialStage: "Dispatched", transporter: "VRL" }), "toTransport");
  assert.equal(phaseOf({ lrNo: null, materialStage: "Close - Received to Party", transporter: MAHEK_VEHICLE }), "delivered");
});

test("a Mahek Vehicle update names our vehicle, not a transporter", () => {
  const body = customerMessage("stage", { party: "Shop G", bills: ["1193"], lrNo: null, lrDate: null, transporter: MAHEK_VEHICLE, packages: 8, stage: "In Transit", expectedOn: null, trackUrl: null, vehicleNo: "MH 04 KL 2231", signature: "Mahek" });
  assert.match(body, /in transit in our own vehicle MH 04 KL 2231/);
  assert.doesNotMatch(body, /LR no/);
});

test("numbers compare without spaces, dashes or case; a bill compares on its last digits", () => {
  assert.equal(normNo(" lr-77841 "), "LR77841");
  assert.equal(billKey("MMI/26-27/1188"), "1188");
  assert.equal(billKey("bill no 01188"), "1188");
  assert.equal(billKey(null), "");
  assert.equal(editDistance("33120", "3312"), 1);
  assert.equal(editDistance("77841", "77856", 1), 2);
});

test("the same photo, or the same LR of the same transporter, is a duplicate of the earlier one", () => {
  const flags = duplicateFlags([
    { ...base, id: "a", lrNo: "77841", contentHash: "h1", uploadedAt: at(0) },
    { ...base, id: "b", contentHash: "h1", uploadedAt: at(1) },
    { ...base, id: "c", readLrNo: "77-841", uploadedAt: at(2) },
  ]);
  assert.equal(flags.get("a"), undefined, "the first one is never flagged");
  assert.equal(flags.get("b")?.kind, "duplicate");
  assert.equal(flags.get("b")?.ofId, "a");
  assert.equal(flags.get("c")?.kind, "duplicate", "a number only read, not typed, still counts");
});

test("same transporter different numbers, and same number different transporters, are both unique", () => {
  const flags = duplicateFlags([
    { ...base, id: "a", lrNo: "77841", uploadedAt: at(0) },
    { ...base, id: "b", lrNo: "77856", uploadedAt: at(1) },
    { ...base, id: "c", lrNo: "77841", transporter: "Gati", uploadedAt: at(2) },
  ]);
  assert.equal(flags.size, 0);
});

test("one character apart, or a transporter not read, is a question for a person", () => {
  const flags = duplicateFlags([
    { ...base, id: "a", lrNo: "33120", transporter: "Shree Maruti", packages: 20, uploadedAt: at(0) },
    { ...base, id: "b", readLrNo: "3312", transporter: "Shree Maruti", packages: 20, uploadedAt: at(1) },
    { ...base, id: "c", lrNo: "90812", transporter: "TCI", uploadedAt: at(2) },
    { ...base, id: "d", readLrNo: "90812", transporter: null, uploadedAt: at(3) },
  ]);
  assert.equal(flags.get("b")?.kind, "check");
  assert.equal(flags.get("d")?.kind, "check");
});

test("one already attached is said as such, and a cleared copy is never flagged again", () => {
  const flags = duplicateFlags([
    { ...base, id: "a", lrNo: "77790", status: "assigned", uploadedAt: at(0) },
    { ...base, id: "b", lrNo: "77790", uploadedAt: at(1) },
    { ...base, id: "c", lrNo: "77790", uploadedAt: at(2), dupClearedAt: at(5) },
  ]);
  assert.equal(flags.get("b")?.kind, "attached");
  assert.equal(flags.get("c"), undefined);
});

test("a signed copy of the same bill is a duplicate; different bills of one party are not", () => {
  const sc: DeskCopy = { ...base, kind: "signed_copy", transporter: null, packages: null };
  const flags = duplicateFlags([
    { ...sc, id: "a", billHint: "1188", partyHint: "Shop J Hardware", uploadedAt: at(0) },
    { ...sc, id: "b", billHint: "MMI/26-27/1188", partyHint: "Shop J Hardware", uploadedAt: at(1) },
    { ...sc, id: "c", billHint: "1190", partyHint: "Shop J Hardware", uploadedAt: at(2) },
  ]);
  assert.equal(flags.get("b")?.kind, "duplicate");
  assert.equal(flags.get("c"), undefined);
});

test("an LR uploaded as a signed copy is said, only while it is on the desk", () => {
  assert.equal(wrongKind({ kind: "signed_copy", readKind: "lr", status: "unassigned" }), "lr");
  assert.equal(wrongKind({ kind: "lr", readKind: "lr", status: "unassigned" }), null);
  assert.equal(wrongKind({ kind: "lr", readKind: "signed_copy", status: "assigned" }), null);
});

test("a signed copy is matched on its bill number first, then its party", () => {
  const ranked = rankForSignedCopy({ billHint: "1188", partyHint: "Shop J Hardware" }, [
    { id: "x", billNo: "MMI/26-27/1193", party: "Shop G Traders", vehicleNo: null },
    { id: "y", billNo: "MMI/26-27/1188", party: "Shop J Hardware", vehicleNo: null },
  ]);
  assert.equal(ranked[0].id, "y");
  assert.deepEqual(ranked[0].reasons, ["same bill no.", "same party"]);
});

test("only a clear winner is acted on", () => {
  assert.equal(confidentPick([{ id: "a", score: 9 }, { id: "b", score: 3 }], 7), "a");
  assert.equal(confidentPick([{ id: "a", score: 9 }, { id: "b", score: 9 }], 7), null, "a tie is a question");
  assert.equal(confidentPick([{ id: "a", score: 5 }], 7), null);
});

test("what is still missing is said in the order it is filled", () => {
  assert.deepEqual(missingFor({ kind: "lr", lrNo: null, transporter: null, receivedBy: null }), ["LR no.", "transporter"]);
  assert.deepEqual(missingFor({ kind: "signed_copy", lrNo: null, transporter: null, receivedBy: null }), ["received by"]);
  assert.deepEqual(missingFor({ kind: "signed_copy", lrNo: null, transporter: null, receivedBy: "Contact 2" }), []);
});

test("the customer's page for our own vehicle skips the transporter's steps", async () => {
  const { buildJourney } = await import("./order-tracking");
  const j = buildJourney([{ step: "confirmed", at: "2026-10-28T09:00:00Z" }, { step: "dispatched", at: "2026-10-30T09:00:00Z" }], [], (c) => c, { ownVehicle: true });
  const pending = j.entries.filter((e) => e.type === "step" && e.state === "pending").map((e) => (e.type === "step" ? e.step : ""));
  assert.ok(!pending.includes("at_transport"));
  assert.ok(pending.includes("in_transit") && pending.includes("delivered"));
});
