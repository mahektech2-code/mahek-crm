import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handsetSampleRefusal,
  salesGateRefusal,
  scopeCovers,
  scopeStanding,
} from "./sales-gate";

/* The rules in `sales-gate.ts`, without a database. Each `test` names the hole
   it closes, because these are permissions and a regression here is somebody
   seeing or deciding something they were never given. */

const gate = (over: Partial<Parameters<typeof salesGateRefusal>[0]>) =>
  salesGateRefusal({
    level: "manager",
    platformAdmin: false,
    needManager: true,
    modulesAsked: ["sales.leave"],
    modulesHeld: ["sales.leave"],
    ...over,
  });

test("a Sales Dashboard manager holding the module may decide", () => {
  assert.equal(gate({}), null);
  assert.equal(gate({ level: "admin" }), null);
});

test("an associate holding the app may not decide", () => {
  assert.match(gate({ level: "associate" }) ?? "", /manager/);
});

test("an associate may still do what asks no level", () => {
  assert.equal(gate({ level: "associate", needManager: false }), null);
});

test("no grant is refused whatever the modules say", () => {
  assert.match(gate({ level: null }) ?? "", /not been granted/);
});

test("a withheld module refuses the action, not only the screen", () => {
  assert.match(gate({ modulesHeld: ["sales.today"] }) ?? "", /screen this belongs to/);
});

test("any one of several owning modules opens it", () => {
  assert.equal(
    gate({ modulesAsked: ["sales.approvals", "sales.leave"], modulesHeld: ["sales.leave"] }),
    null,
  );
});

test("a platform administrator passes the level but not a missing module or grant", () => {
  assert.equal(gate({ level: "associate", platformAdmin: true }), null);
  assert.notEqual(gate({ platformAdmin: true, modulesHeld: [] }), null);
  assert.notEqual(gate({ platformAdmin: true, level: null, modulesAsked: [] }), null);
});

test("an associate is scoped to their own book — the hole that read them as national", () => {
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: "sales", levelInRequestApp: "associate", levelInSales: "associate" }),
    "own",
  );
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: "crm", levelInRequestApp: "associate", levelInSales: "manager" }),
    "own",
    "a CRM telecaller is an associate in the CRM, whatever they hold elsewhere",
  );
});

test("a manager or app admin keeps the territory rule", () => {
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: "sales", levelInRequestApp: "manager", levelInSales: "manager" }),
    "territory",
  );
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: "crm", levelInRequestApp: "admin", levelInSales: null }),
    "territory",
  );
});

test("no app on the request reads the Sales Dashboard level", () => {
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: null, levelInRequestApp: null, levelInSales: "manager" }),
    "territory",
  );
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: null, levelInRequestApp: null, levelInSales: null }),
    "own",
    "somebody with no Sales Dashboard grant sees only themselves",
  );
});

test("the founder's desk and a platform admin are national", () => {
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: "founder", levelInRequestApp: "associate", levelInSales: null }),
    "national",
  );
  assert.equal(
    scopeStanding({ platformAdmin: true, requestApp: "sales", levelInRequestApp: "associate", levelInSales: "associate" }),
    "national",
  );
  assert.equal(
    scopeStanding({ platformAdmin: false, requestApp: "founder", levelInRequestApp: null, levelInSales: null }),
    "own",
    "the founder arm needs a founder grant",
  );
});

test("scopeCovers: national covers everybody, a list covers its members", () => {
  assert.equal(scopeCovers({ salesmanIds: null }, "u1"), true);
  assert.equal(scopeCovers({ salesmanIds: ["u1"] }, "u1"), true);
  assert.equal(scopeCovers({ salesmanIds: ["u2"] }, "u1"), false);
  assert.equal(scopeCovers({ salesmanIds: [] }, "u1"), false);
});

test("scopeCovers: the CRM Sales Manager seat's null is not national", () => {
  assert.equal(scopeCovers({ salesmanIds: null, salesManagerId: "sm" }, "u1"), false);
});

test("a handset cannot approve or refuse a sample", () => {
  assert.notEqual(handsetSampleRefusal({ from: "requested", to: "approved", canApprove: false }), null);
  assert.notEqual(handsetSampleRefusal({ from: "requested", to: "rejected", canApprove: false }), null);
  assert.equal(handsetSampleRefusal({ from: "requested", to: "approved", canApprove: true }), null);
});

test("a handset cannot skip the approval", () => {
  assert.notEqual(handsetSampleRefusal({ from: "requested", to: "dispatched", canApprove: false }), null);
  assert.notEqual(handsetSampleRefusal({ from: "requested", to: "reviewed", canApprove: true }), null);
});

test("the salesman's own moves go through, and a retried mark is accepted", () => {
  assert.equal(handsetSampleRefusal({ from: "approved", to: "dispatched", canApprove: false }), null);
  assert.equal(handsetSampleRefusal({ from: "dispatched", to: "received", canApprove: false }), null);
  assert.equal(handsetSampleRefusal({ from: "received", to: "reviewed", canApprove: false }), null);
  assert.equal(handsetSampleRefusal({ from: "requested", to: "cancelled", canApprove: false }), null);
  assert.equal(handsetSampleRefusal({ from: "approved", to: "approved", canApprove: false }), null);
  assert.equal(handsetSampleRefusal({ from: "received", to: null, canApprove: false }), null);
});

test("nothing comes back from a closed sample", () => {
  assert.notEqual(handsetSampleRefusal({ from: "cancelled", to: "received", canApprove: true }), null);
  assert.notEqual(handsetSampleRefusal({ from: "reviewed", to: "requested", canApprove: true }), null);
});
