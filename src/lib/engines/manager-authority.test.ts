import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorityChain, ownerHasLeft, type AuthorityAccount, type AuthorityEmployee } from "./manager-authority";

/* Bharat -> Seema -> Pritesh, as on production. */
const emp = (status: AuthorityEmployee["status"] = "active"): AuthorityEmployee => ({ status });
function chart(opts: {
  managerOf?: [string, string][];
  employees?: Record<string, AuthorityEmployee>;
  accounts?: Record<string, AuthorityAccount[]>;
}) {
  return {
    managerOf: new Map(opts.managerOf ?? [["bharat", "seema"], ["seema", "pritesh"]]),
    employees: new Map(
      Object.entries(opts.employees ?? { bharat: emp("inactive"), seema: emp(), pritesh: emp() }),
    ),
    accountsByEmployee: new Map(
      Object.entries(
        opts.accounts ?? {
          bharat: [{ userId: "u_bharat", active: false }],
          seema: [{ userId: "u_seema", active: true }],
          pritesh: [{ userId: "u_pritesh", active: true }],
        },
      ),
    ),
  };
}
const ids = (r: ReturnType<typeof authorityChain>) => r.ancestors.map((a) => a.userId);

describe("authorityChain", () => {
  it("names every active manager above the owner, nearest first", () => {
    const r = authorityChain({ ownerEmployeeId: "bharat", ...chart({}) });
    assert.deepEqual(ids(r), ["u_seema", "u_pritesh"]);
    assert.equal(r.stoppedBy, null);
  });

  it("names nobody where the owner has no stored employee link", () => {
    assert.deepEqual(ids(authorityChain({ ownerEmployeeId: null, ...chart({}) })), []);
  });

  it("names nobody where the owner's employee is not on the books at all", () => {
    assert.deepEqual(ids(authorityChain({ ownerEmployeeId: "ghost", ...chart({}) })), []);
  });

  it("skips a manager who has left and carries on to the one above", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({ employees: { bharat: emp("inactive"), seema: emp("inactive"), pritesh: emp() } }),
    });
    assert.deepEqual(ids(r), ["u_pritesh"]);
  });

  it("does not treat an unknown status as Active", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({ employees: { bharat: emp("inactive"), seema: emp("unknown"), pritesh: emp() } }),
    });
    assert.deepEqual(ids(r), ["u_pritesh"]);
  });

  it("skips a manager with no account, or only an inactive one", () => {
    const noAccount = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({ accounts: { bharat: [{ userId: "u_bharat", active: false }], pritesh: [{ userId: "u_pritesh", active: true }] } }),
    });
    assert.deepEqual(ids(noAccount), ["u_pritesh"]);
    const inactive = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({
        accounts: {
          bharat: [{ userId: "u_bharat", active: false }],
          seema: [{ userId: "u_seema", active: false }],
          pritesh: [{ userId: "u_pritesh", active: true }],
        },
      }),
    });
    assert.deepEqual(ids(inactive), ["u_pritesh"]);
  });

  it("stops at two accounts on one manager and names nobody at or above them", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({
        accounts: {
          bharat: [{ userId: "u_bharat", active: false }],
          seema: [{ userId: "u_seema", active: true }, { userId: "u_seema2", active: true }],
          pritesh: [{ userId: "u_pritesh", active: true }],
        },
      }),
    });
    assert.deepEqual(ids(r), []);
    assert.equal(r.stoppedBy, "ambiguous");
  });

  it("keeps what was collected below an ambiguous rung", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({
        accounts: {
          bharat: [{ userId: "u_bharat", active: false }],
          seema: [{ userId: "u_seema", active: true }],
          pritesh: [{ userId: "p1", active: true }, { userId: "p2", active: true }],
        },
      }),
    });
    assert.deepEqual(ids(r), ["u_seema"]);
    assert.equal(r.stoppedBy, "ambiguous");
  });

  it("names nobody at all on a loop", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({ managerOf: [["bharat", "seema"], ["seema", "pritesh"], ["pritesh", "seema"]] }),
    });
    assert.deepEqual(ids(r), []);
    assert.equal(r.stoppedBy, "cycle");
  });

  it("never names the owner, even where the chart points back at them", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({ managerOf: [["bharat", "seema"], ["seema", "bharat"]] }),
    });
    assert.deepEqual(ids(r), []);
    assert.equal(r.stoppedBy, "cycle");
  });

  it("does not name an unrelated manager", () => {
    const r = authorityChain({
      ownerEmployeeId: "bharat",
      ...chart({
        employees: { bharat: emp("inactive"), seema: emp(), pritesh: emp(), other: emp() },
        accounts: {
          bharat: [{ userId: "u_bharat", active: false }],
          seema: [{ userId: "u_seema", active: true }],
          pritesh: [{ userId: "u_pritesh", active: true }],
          other: [{ userId: "u_other", active: true }],
        },
      }),
    });
    assert.ok(!ids(r).includes("u_other"));
  });

  it("stops when the chart ends", () => {
    const r = authorityChain({ ownerEmployeeId: "bharat", ...chart({ managerOf: [["bharat", "seema"]] }) });
    assert.deepEqual(ids(r), ["u_seema"]);
  });
});

describe("ownerHasLeft", () => {
  it("is true for a switched-off account", () => {
    assert.equal(ownerHasLeft({ accountActive: false, employeeStatus: "active" }), true);
  });
  it("is true for an Inactive employee on an account still on", () => {
    assert.equal(ownerHasLeft({ accountActive: true, employeeStatus: "inactive" }), true);
  });
  it("is false for somebody plainly working", () => {
    assert.equal(ownerHasLeft({ accountActive: true, employeeStatus: "active" }), false);
  });
  it("is false where nothing is known", () => {
    assert.equal(ownerHasLeft({ accountActive: null, employeeStatus: null }), false);
    assert.equal(ownerHasLeft({ accountActive: true, employeeStatus: "unknown" }), false);
  });
});
