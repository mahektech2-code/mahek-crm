import { test } from "node:test";
import assert from "node:assert/strict";

import {
  matchEmployee,
  proposeEmployeeLinks,
  type AccountToMatch,
  type EmployeeCandidate,
} from "./employee-match";

/**
 * The cases here are the REAL book, not invented ones.
 *
 * Every field salesman's salary read blank on the Sales Dashboard and on the
 * handset, and the reason was not a bug in a query — it was that the guess
 * those queries make cannot answer this question on this data. These tests pin
 * the shape of that data so the guess is never quietly promoted back into an
 * answer.
 */

const emp = (o: Partial<EmployeeCandidate> & { id: string; employeeCode: string; name: string }): EmployeeCandidate => ({
  email: null,
  companyMobile: null,
  personalMobile: null,
  ...o,
});

/* The two rows the real sheet carries for one man, at two different salaries,
   sharing one company mobile. */
const PRITESH_A = emp({
  id: "e1",
  employeeCode: "EMP-8662",
  name: "Pritesh Doshi",
  companyMobile: "9822824973",
});
const PRITESH_B = emp({
  id: "e2",
  employeeCode: "EMP-5527",
  name: "Pritesh Bipin Doshi",
  email: "mahekmarketingindiaceo@gmail.com",
  companyMobile: "9822824973",
  personalMobile: "1234567898",
});

const ACCOUNT: AccountToMatch = {
  id: "u1",
  name: "Pritesh Bipin Doshi",
  email: "pritesh@mahek.in",
  phone: "9820011006",
};

test("the real account matches nothing on email or number, which is why salary was blank", () => {
  /* `pritesh@mahek.in` is not in the sheet at all, and `9820011006` is a work
     number the sheet has never carried. This is the whole failure, reproduced:
     the account and the payroll row are the same person and share no key. */
  const onlyKeys = [emp({ ...PRITESH_A }), emp({ ...PRITESH_B, name: "Somebody Else" })];
  assert.equal(matchEmployee(ACCOUNT, onlyKeys).status, "unmatched");
});

test("the name resolves it, and is refused the moment two rows share it", () => {
  assert.deepEqual(matchEmployee(ACCOUNT, [PRITESH_B]), {
    status: "matched",
    employeeId: "e2",
    on: "name",
    note: null,
  });

  const twins = [PRITESH_B, emp({ id: "e3", employeeCode: "EMP-9001", name: "PRITESH   BIPIN  DOSHI" })];
  const out = matchEmployee(ACCOUNT, twins);
  assert.equal(out.status, "ambiguous");
  assert.match(out.note ?? "", /EMP-5527/);
  assert.match(out.note ?? "", /EMP-9001/);
});

test("a stronger key wins outright rather than being weighed against a weaker one", () => {
  /* Email says EMP-5527; the name says EMP-8662. That is not a conflict to
     report — it is an email match and a coincidence of names. */
  const account = { ...ACCOUNT, email: "mahekmarketingindiaceo@gmail.com", name: "Pritesh Doshi" };
  assert.deepEqual(matchEmployee(account, [PRITESH_A, PRITESH_B]), {
    status: "matched",
    employeeId: "e2",
    on: "email",
    note: null,
  });
});

test("a number is matched on its last ten digits, however the sheet wrote it", () => {
  const account = { ...ACCOUNT, email: null, name: "No Such Name", phone: "+91 98228 24973" };
  const out = matchEmployee(account, [PRITESH_A]);
  assert.equal(out.status, "matched");
  assert.equal(out.on, "mobile");
});

test("one number on two payroll rows is refused, not split", () => {
  /* Both Pritesh rows carry 9822824973. Picking either decides somebody's pay
     on a coin toss. */
  const account = { ...ACCOUNT, email: null, name: "No Such Name", phone: "9822824973" };
  const out = matchEmployee(account, [PRITESH_A, PRITESH_B]);
  assert.equal(out.status, "ambiguous");
  assert.equal(out.on, "mobile");
});

test("two accounts matching one employee is caught across the whole run, not per account", () => {
  /* Each looks clean from its own side — this is the collision `matchEmployee`
     structurally cannot see, and the one that would hand one payroll row to
     two people. */
  const a: AccountToMatch = { id: "u1", name: "Pritesh Bipin Doshi", email: null, phone: null };
  const b: AccountToMatch = { id: "u2", name: "pritesh bipin doshi", email: null, phone: null };

  assert.equal(matchEmployee(a, [PRITESH_B]).status, "matched");
  assert.equal(matchEmployee(b, [PRITESH_B]).status, "matched");

  const proposals = proposeEmployeeLinks([a, b], [PRITESH_B]);
  assert.equal(proposals.length, 2);
  for (const p of proposals) {
    assert.equal(p.status, "ambiguous", "neither may be written");
    assert.match(p.note ?? "", /cannot belong to two people/);
  }
});

test("an unmatched account stays unmatched rather than being given the nearest row", () => {
  const nobody: AccountToMatch = { id: "u9", name: "Nobody At All", email: "nobody@mahek.in", phone: "9999999999" };
  assert.deepEqual(proposeEmployeeLinks([nobody], [PRITESH_A, PRITESH_B]), [
    { account: nobody, status: "unmatched", employeeId: null, on: null, note: null },
  ]);
});

test("a blank key never matches a blank key", () => {
  /* 56 of 71 employees carry no email. If an empty account email folded onto
     an empty employee email, the first person in the list would be handed to
     everybody. */
  const blank: AccountToMatch = { id: "u0", name: "", email: "", phone: "" };
  assert.equal(matchEmployee(blank, [emp({ id: "x", employeeCode: "E", name: "" })]).status, "unmatched");
});
