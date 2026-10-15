import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveOrgVerifier, type ChainAccount, type ChainEmployee } from "./org-verifier-chain";

/* A small company: Dev (salesman) → Mira → Seema → Owner. */
const on: ChainEmployee = { onTheBooks: true };
const gone: ChainEmployee = { onTheBooks: false };

function chart(over: {
  links?: Array<[string, string]>;
  employees?: Record<string, ChainEmployee>;
  accounts?: Record<string, ChainAccount[]>;
} = {}) {
  return {
    managerOf: new Map(over.links ?? [["dev", "mira"], ["mira", "seema"], ["seema", "owner"]]),
    employees: new Map(
      Object.entries(over.employees ?? { dev: on, mira: on, seema: on, owner: on }),
    ),
    accountsByEmployee: new Map(
      Object.entries(
        over.accounts ?? {
          dev: [{ userId: "u_dev", active: true, canVerify: false }],
          mira: [{ userId: "u_mira", active: true, canVerify: true }],
          seema: [{ userId: "u_seema", active: true, canVerify: true }],
          owner: [{ userId: "u_owner", active: true, canVerify: true }],
        },
      ),
    ),
  };
}

describe("the nearest eligible manager on the org chart", () => {
  test("the Salesman's own manager, where they can verify", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...chart() });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.verifierUserId, "u_mira");
      assert.equal(r.depth, 1);
    }
  });

  test("a different Salesman's chain gives a different manager — nothing is a fixed account", () => {
    const c = chart({
      links: [["ravi", "seema"], ["dev", "mira"]],
      employees: { ravi: on, dev: on, mira: on, seema: on },
      accounts: {
        mira: [{ userId: "u_mira", active: true, canVerify: true }],
        seema: [{ userId: "u_seema", active: true, canVerify: true }],
      },
    });
    const ravi = resolveOrgVerifier({ subjectEmployeeId: "ravi", ...c });
    const dev = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.ok(ravi.ok && dev.ok);
    if (ravi.ok && dev.ok) {
      assert.equal(ravi.verifierUserId, "u_seema");
      assert.equal(dev.verifierUserId, "u_mira");
    }
  });

  test("a manager change moves the verifier", () => {
    const before = resolveOrgVerifier({ subjectEmployeeId: "dev", ...chart() });
    const after = resolveOrgVerifier({
      subjectEmployeeId: "dev",
      ...chart({ links: [["dev", "seema"], ["seema", "owner"]] }),
    });
    assert.ok(before.ok && after.ok);
    if (before.ok && after.ok) {
      assert.equal(before.verifierUserId, "u_mira");
      assert.equal(after.verifierUserId, "u_seema");
    }
  });
});

describe("an immediate manager who cannot be sent it", () => {
  test("without lead.verify — the next one up is used, and the skip is recorded", () => {
    const c = chart();
    c.accountsByEmployee.set("mira", [{ userId: "u_mira", active: true, canVerify: false }]);
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.verifierUserId, "u_seema");
      assert.equal(r.depth, 2);
      assert.deepEqual(r.skipped, [{ employeeId: "mira", reason: "cannot_verify" }]);
    }
  });

  test("inactive account", () => {
    const c = chart();
    c.accountsByEmployee.set("mira", [{ userId: "u_mira", active: false, canVerify: true }]);
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.verifierUserId, "u_seema");
      assert.equal(r.skipped[0].reason, "inactive");
    }
  });

  test("a leaver or withdrawn employee", () => {
    const c = chart({ employees: { dev: on, mira: gone, seema: on, owner: on } });
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.verifierUserId, "u_seema");
      assert.equal(r.skipped[0].reason, "left");
    }
  });

  test("no account at all", () => {
    const c = chart();
    c.accountsByEmployee.delete("mira");
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.skipped[0].reason, "no_account");
  });

  test("nobody above can — it fails closed, naming nobody", () => {
    const c = chart();
    for (const e of ["mira", "seema", "owner"]) {
      c.accountsByEmployee.set(e, [{ userId: `u_${e}`, active: true, canVerify: false }]);
    }
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "chain_exhausted");
  });
});

describe("a chart that cannot be trusted refuses", () => {
  test("two accounts for one manager is ambiguous, never picked", () => {
    const c = chart();
    c.accountsByEmployee.set("mira", [
      { userId: "u_mira1", active: true, canVerify: true },
      { userId: "u_mira2", active: true, canVerify: true },
    ]);
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ambiguous_account");
  });

  test("a Salesman whose account names no employee", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: null, ...chart() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "subject_unmapped");
  });

  test("an employee id that is not in the master", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: "ghost", ...chart() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "subject_unknown");
  });

  test("no manager recorded", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...chart({ links: [] }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "no_manager");
  });

  test("a cycle terminates and refuses", () => {
    const c = chart({ links: [["dev", "mira"], ["mira", "seema"], ["seema", "mira"]] });
    c.accountsByEmployee.set("mira", [{ userId: "u_mira", active: true, canVerify: false }]);
    c.accountsByEmployee.set("seema", [{ userId: "u_seema", active: true, canVerify: false }]);
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...c });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "cycle");
  });

  test("a self-link does not hang", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", ...chart({ links: [["dev", "dev"]] }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "cycle");
  });
});

describe("the person who raised the lead", () => {
  test("is never chosen as its verifier — the caller is told so", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", creatorUserId: "u_mira", ...chart() });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "creator_is_verifier");
      assert.equal(r.wouldBeUserId, "u_mira");
    }
  });

  test("a creator elsewhere in the chain changes nothing", () => {
    const r = resolveOrgVerifier({ subjectEmployeeId: "dev", creatorUserId: "u_owner", ...chart() });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.verifierUserId, "u_mira");
  });

  test("an excluded account is never chosen", () => {
    const r = resolveOrgVerifier({
      subjectEmployeeId: "dev",
      excludeUserIds: new Set(["u_mira"]),
      ...chart(),
    });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.verifierUserId, "u_seema");
  });
});
