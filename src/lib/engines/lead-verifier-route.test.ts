import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chooseVerifierRoute, NO_CREATOR, type CreatorFacts } from "./lead-verifier-route";

const FIELD = "usr_field";
const desk = (id = "usr_tele"): CreatorFacts => ({ actorUserId: id, eventSourceApp: "crm", capturedAsRole: null });
const handset = (role: string | null, id = "usr_salesman"): CreatorFacts => ({
  actorUserId: id,
  eventSourceApp: "mbos",
  capturedAsRole: role,
});
const route = (creator: CreatorFacts, assigned = false) =>
  chooseVerifierRoute({ creator, assignedToSalesman: assigned, fieldVerifierId: FIELD });

describe("who raised the lead", () => {
  test("a desk lead — Telecaller or Sales Manager — is the desk verifier's", () => {
    const r = route(desk());
    assert.equal(r.route, "desk");
    assert.equal(r.fallback, false);
    assert.equal(r.creatorId, "usr_tele");
  });

  test("a lead a Salesman raised on the handset is the field verifier's", () => {
    const r = route(handset("associate"));
    assert.equal(r.route, "field");
    assert.equal(r.viaAssignment, false);
  });

  test("a manager or administrator raising on the handset is a Sales Manager: desk", () => {
    for (const role of ["manager", "admin"]) assert.equal(route(handset(role)).route, "desk", role);
  });
});

describe("a lead currently assigned to a Salesman overrides the creator", () => {
  test("Telecaller-created", () => {
    const r = route(desk(), true);
    assert.equal(r.route, "field");
    assert.equal(r.viaAssignment, true);
    assert.equal(r.creatorId, "usr_tele");
  });

  test("Sales Manager-created, on the desk or on the handset", () => {
    assert.equal(route(desk("usr_sm"), true).route, "field");
    assert.equal(route(handset("manager", "usr_sm"), true).route, "field");
  });

  test("a Salesman's own lead is not 'via assignment' — rule 3 already decides it", () => {
    const r = route(handset("associate"), true);
    assert.equal(r.route, "field");
    assert.equal(r.viaAssignment, false);
  });

  test("not assigned to a Salesman: the creator decides", () => {
    assert.equal(route(desk(), false).route, "desk");
  });
});

describe("the field verifier's own lead is never hers to verify", () => {
  test("the desk verifier has it, with or without a Salesman holding it", () => {
    for (const assigned of [false, true]) {
      const r = route(desk(FIELD), assigned);
      assert.equal(r.route, "desk", `assigned=${assigned}`);
      assert.equal(assigned ? r.creatorIsFieldVerifier : true, true);
      assert.equal(r.fallback, false, "a known creator is not a fallback");
    }
  });

  test("another Salesman-created lead is still hers", () => {
    assert.equal(route(handset("associate", "usr_other")).route, "field");
  });
});

describe("a creator that cannot be established falls back to the desk verifier", () => {
  test("no record at all", () => {
    const r = route(NO_CREATOR);
    assert.equal(r.route, "desk");
    assert.equal(r.fallback, true);
    assert.equal(r.creatorId, null, "no creator is invented");
  });

  test("a handset lead whose level was never recorded is not classified from today's role", () => {
    const r = route(handset(null));
    assert.equal(r.route, "desk");
    assert.equal(r.fallback, true);
    assert.equal(r.creatorId, "usr_salesman", "who is known is kept; what they were is not guessed");
  });

  test("an unrecognised source app", () => {
    assert.equal(route({ actorUserId: "u", eventSourceApp: "sheet", capturedAsRole: null }).fallback, true);
  });

  test("an unknown creator whom a Salesman holds is decided by ASSIGNMENT, not a fallback", () => {
    const r = route(NO_CREATOR, true);
    assert.equal(r.route, "field");
    assert.equal(r.fallback, false);
    assert.equal(r.viaAssignment, true);
  });
});
