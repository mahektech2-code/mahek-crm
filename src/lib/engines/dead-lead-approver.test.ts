/**
 * Who decides a Dead request (pure) and who may ask for one (pure). The data
 * fetching and every write are in `lib/lead-dead.test.ts`, against a database.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decideApprover, type ApproverFacts } from "./dead-lead-approver";
import { deadBadge, deadRequestEligibility, DEAD_REFUSAL } from "../lead-dead";
import { deadLeadRefusalFrom } from "../result";

const good: ApproverFacts = {
  requesterUserId: "u-req",
  requesterEmployeeId: "e-req",
  managerEmployeeId: "e-mgr",
  managerEmployee: { id: "e-mgr", name: "Manoj", active: true },
  managerUsers: [{ id: "u-mgr", name: "Manoj", active: true, canDecide: true }],
};

describe("decideApprover — the Org Chart manager, or a refusal that names the fix", () => {
  test("a complete chain resolves to the manager's own account", () => {
    const r = decideApprover(good);
    assert.deepEqual(r.ok && [r.approverUserId, r.approverName, r.approverEmployeeId], ["u-mgr", "Manoj", "e-mgr"]);
  });

  const refusals: Array<[string, Partial<ApproverFacts>, string]> = [
    ["account not linked to an employee", { requesterEmployeeId: null }, "requester_not_linked"],
    ["no reporting manager", { managerEmployeeId: null, managerEmployee: null, managerUsers: [] }, "no_manager"],
    ["manager is the requester's own employee record", { managerEmployeeId: "e-req" }, "self_manager"],
    ["manager employee record is missing", { managerEmployee: null, managerUsers: [] }, "manager_inactive"],
    ["manager is no longer active", { managerEmployee: { id: "e-mgr", name: "Manoj", active: false } }, "manager_inactive"],
    ["manager has no MahekOne account", { managerUsers: [] }, "manager_no_account"],
    [
      "two accounts are linked to the manager",
      {
        managerUsers: [
          { id: "a", name: "A", active: true, canDecide: true },
          { id: "b", name: "B", active: true, canDecide: true },
        ],
      },
      "manager_ambiguous",
    ],
    ["the manager's account is the requester's", { managerUsers: [{ id: "u-req", name: "Me", active: true, canDecide: true }] }, "self_manager"],
    ["manager's account is disabled", { managerUsers: [{ id: "u-mgr", name: "Manoj", active: false, canDecide: true }] }, "manager_account_disabled"],
    ["manager cannot open the CRM", { managerUsers: [{ id: "u-mgr", name: "Manoj", active: true, canDecide: false }] }, "manager_cannot_decide"],
  ];

  for (const [name, over, code] of refusals) {
    test(`refused: ${name}`, () => {
      const r = decideApprover({ ...good, ...over });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, code);
        assert.match(r.message, /administrator has to correct the Org Chart/i);
      }
    });
  }

  test("it never offers anybody else — a refusal carries no approver at all", () => {
    const r = decideApprover({ ...good, managerEmployee: { id: "e-mgr", name: "Manoj", active: false } });
    assert.equal("approverUserId" in r, false);
  });
});

describe("deadRequestEligibility — what the menu draws and the server enforces", () => {
  test("only a Lost lead that is neither Dead nor pending may be asked about", () => {
    assert.deepEqual(deadRequestEligibility({ stage: "lost", deadAt: null, pending: false }), { offer: true });
  });

  test("every other rung is drawn but disabled, with the reason", () => {
    for (const stage of ["suspect", "prospect", "qualification", "negotiation", "on_hold", "won", "customer", null]) {
      const r = deadRequestEligibility({ stage, deadAt: null, pending: false });
      assert.equal(r.offer, false, String(stage));
      assert.equal(!r.offer && r.show, true);
      assert.match(!r.offer ? r.reason : "", /only a lead that is already Lost/i);
    }
  });

  test("a pending request disables it, and a Dead lead is not offered at all", () => {
    const pending = deadRequestEligibility({ stage: "lost", deadAt: null, pending: true });
    assert.equal(pending.offer, false);
    const dead = deadRequestEligibility({ stage: "lost", deadAt: new Date(), pending: false });
    assert.equal(dead.offer, false);
    assert.equal(!dead.offer && dead.show, false);
  });

  test("the badge says Dead before it says pending", () => {
    assert.equal(deadBadge({ deadAt: new Date(), pending: true }), "dead");
    assert.equal(deadBadge({ deadAt: null, pending: true }), "pending");
    assert.equal(deadBadge({ deadAt: null, pending: false }), null);
  });
});

describe("the database's refusals read as sentences wherever an action catches them", () => {
  test("a DL001 anywhere in the cause chain becomes the Dead refusal", () => {
    const wrapped = Object.assign(new Error("Failed query: update customers …"), {
      cause: Object.assign(new Error("raised"), { code: "DL001" }),
    });
    assert.equal(deadLeadRefusalFrom(wrapped), DEAD_REFUSAL);
  });

  test("other errors are left alone", () => {
    assert.equal(deadLeadRefusalFrom(new Error("boom")), null);
    assert.equal(deadLeadRefusalFrom(Object.assign(new Error("x"), { code: "23505" })), null);
    assert.equal(deadLeadRefusalFrom(null), null);
  });
});
