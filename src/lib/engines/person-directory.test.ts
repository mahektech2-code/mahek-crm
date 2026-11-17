import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDirectory, personKey, type DirAccount, type DirEmployee } from "./person-directory";

const emp = (id: string, name: string, extra: Partial<DirEmployee> = {}): DirEmployee => ({
  id,
  name,
  email: null,
  companyMobile: null,
  personalMobile: null,
  active: true,
  ...extra,
});
const acc = (id: string, name: string, extra: Partial<DirAccount> = {}): DirAccount => ({
  id,
  name,
  email: null,
  phone: null,
  employeeId: null,
  active: true,
  salesPersonName: null,
  ...extra,
});

test("personKey folds case and whitespace", () => {
  assert.equal(personKey("  prakash   Vasudev prasad "), "PRAKASH VASUDEV PRASAD");
  assert.equal(personKey(null), "");
});

test("a manager is read by id — renaming either side moves nobody", () => {
  const before = buildDirectory({
    employees: [emp("e1", "Rahul Sharma"), emp("e2", "Sunita Rao")],
    accounts: [acc("u1", "Rahul Sharma", { employeeId: "e1" }), acc("u2", "Sunita Rao", { employeeId: "e2" })],
    links: [{ employeeId: "e1", managerId: "e2" }],
  });
  assert.equal(before.managerOfAccount("u1")?.userId, "u2");

  // HR renames both, and the accounts still carry the old names: the answer holds.
  const after = buildDirectory({
    employees: [emp("e1", "Rahul S. Sharma"), emp("e2", "Sunita Iyer")],
    accounts: [acc("u1", "Rahul Sharma", { employeeId: "e1" }), acc("u2", "Sunita Rao", { employeeId: "e2" })],
    links: [{ employeeId: "e1", managerId: "e2" }],
  });
  assert.equal(after.managerOfAccount("u1")?.userId, "u2");
  assert.equal(after.managerOfAccount("u1")?.name, "Sunita Iyer", "the manager's CURRENT name");
});

test("a manager with no login comes back by name, not as nobody", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Rahul"), emp("e2", "Regional Head")],
    accounts: [acc("u1", "Rahul", { employeeId: "e1" })],
    links: [{ employeeId: "e1", managerId: "e2" }],
  });
  assert.deepEqual(d.managerOfAccount("u1"), { userId: null, employeeId: "e2", name: "Regional Head" });
});

test("an old spelling still resolves after a rename", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Prakash V. Prasad")],
    accounts: [acc("u1", "Prakash V. Prasad", { employeeId: "e1" })],
    links: [],
    aliases: [{ key: "PRAKASH VASUDEV PRASAD", employeeId: "e1" }],
  });
  assert.equal(d.employeeByName("Prakash Vasudev Prasad"), "e1");
  assert.equal(d.accountByName("prakash  vasudev prasad"), "u1");
});

test("a name two people answer to resolves to nobody", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Pritesh Doshi"), emp("e2", "Pritesh Doshi")],
    accounts: [acc("u1", "Pritesh Doshi", { employeeId: "e1" }), acc("u2", "Pritesh Doshi", { employeeId: "e2" })],
    links: [],
  });
  assert.equal(d.employeeByName("Pritesh Doshi"), null);
  assert.equal(d.accountByName("Pritesh Doshi"), null);
});

test("an alias that collides with somebody else's name resolves to nobody", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Amit Kumar"), emp("e2", "Amit K")],
    accounts: [],
    links: [],
    aliases: [{ key: "AMIT K", employeeId: "e1" }],
  });
  assert.equal(d.employeeByName("Amit K"), null);
  assert.equal(d.employeeByName("Amit Kumar"), "e1");
});

test("unlinked accounts: email, then mobile, then a name unique on both sides", () => {
  const d = buildDirectory({
    employees: [
      emp("e1", "Asha", { email: "Asha@Gmail.com" }),
      emp("e2", "Bina", { companyMobile: "+91 98200 11002" }),
      emp("e3", "Chetan"),
      emp("e4", "Dev"),
    ],
    accounts: [
      acc("u1", "Asha P", { email: "asha@gmail.com" }),
      acc("u2", "Bina", { phone: "9820011002" }),
      acc("u3", "Chetan"),
      acc("u4", "Dev"),
      acc("u5", "Dev"),
    ],
    links: [],
  });
  assert.equal(d.employeeOfAccount("u1"), "e1");
  assert.equal(d.howLinked("u1"), "email");
  assert.equal(d.howLinked("u2"), "mobile");
  assert.equal(d.howLinked("u3"), "name");
  assert.equal(d.employeeOfAccount("u4"), null, "two accounts named Dev: neither is guessed");
});

test("a stored link wins, and an employee already linked is never inferred onto a second account", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Kiran", { email: "k@x.in" })],
    accounts: [acc("u1", "Kiran S", { employeeId: "e1" }), acc("u2", "Kiran", { email: "k@x.in" })],
    links: [],
  });
  assert.equal(d.employeeOfAccount("u1"), "e1");
  assert.equal(d.howLinked("u1"), "stored");
  assert.equal(d.employeeOfAccount("u2"), null);
  assert.equal(d.accountOfEmployee("e1"), "u1");
});

test("the manager of a sheet's salesperson text, through the person it names", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Western Rep"), emp("e2", "Zonal Manager")],
    accounts: [acc("u1", "Rep", { employeeId: "e1", salesPersonName: "WESTERN LINE REP" }), acc("u2", "Zonal Manager", { employeeId: "e2" })],
    links: [{ employeeId: "e1", managerId: "e2" }],
  });
  assert.equal(d.managerOfName("Western Line Rep")?.userId, "u2");
  assert.equal(d.managerOfName("Company Own"), null, "a name that is no person resolves to nothing");
});

test("an inactive account is never handed a seat", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Left Already")],
    accounts: [acc("u1", "Left Already", { employeeId: "e1", active: false })],
    links: [],
  });
  assert.equal(d.accountOfEmployee("e1"), null);
  assert.equal(d.accountByName("Left Already"), null);
});

test("a self-loop on the chart is no manager", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Solo")],
    accounts: [acc("u1", "Solo", { employeeId: "e1" })],
    links: [{ employeeId: "e1", managerId: "e1" }],
  });
  assert.equal(d.managerOfAccount("u1"), null);
});

test("an account marked not-an-employee is never matched, even on its email", () => {
  const d = buildDirectory({
    employees: [emp("e1", "Desk", { email: "desk@mahek.in" })],
    accounts: [acc("u1", "Desk", { email: "desk@mahek.in", notEmployee: true })],
    links: [],
  });
  assert.equal(d.employeeOfAccount("u1"), null);
  assert.equal(d.howLinked("u1"), null);
});
