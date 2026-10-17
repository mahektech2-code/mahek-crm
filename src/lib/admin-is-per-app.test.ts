/**
 * ADMIN ON AN APP IS ADMIN OF THAT APP — and only Admin on the Admin Console is
 * a platform administrator.
 *
 * Until `0197_admin_is_per_app`, `can()` answered yes to every capability for
 * any hat whose level was `admin`, whatever app it was worn in, and the account
 * level copied the widest level onto `users.role`. So "HRMS admin" approved
 * orders, confirmed payments and could sign in as anybody. These tests are what
 * stop the short-circuit being "simplified" back to `hat.role === "admin"`.
 *
 * Imports the PURE matrix, so nothing here needs a database.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES,
  MATRIX,
  can,
  widestRole,
  type Capability,
  type Hat,
} from "./capability-matrix";
import { conflictsFor } from "./role-conflicts";
import type { AppId } from "./apps";

const LEDGER: Capability[] = ["order.approve", "payment.confirm", "creditnote.issue", "customer.reassign"];
const PLATFORM: Capability[] = ["access.manage", "expense.policy.publish", "lead.restore", "distributor.approve"];

describe("an admin hat on one app", () => {
  test("holds nothing at the ledger desk", () => {
    for (const app of ["hrms", "erp", "enquiries", "reports", "crm", "sales", "founder", "field"] as AppId[]) {
      for (const cap of LEDGER) {
        assert.equal(can({ app, role: "admin" }, cap), false, `${app} admin → ${cap}`);
      }
    }
  });

  test("holds none of the platform administrator's capabilities", () => {
    for (const app of ["hrms", "erp", "crm", "accounts", "sales"] as AppId[]) {
      for (const cap of PLATFORM) {
        assert.equal(can({ app, role: "admin" }, cap), false, `${app} admin → ${cap}`);
      }
    }
  });

  test("holds exactly that app's manager list", () => {
    for (const app of Object.keys(MATRIX) as AppId[]) {
      if (app === "admin") continue;
      for (const cap of CAPABILITIES) {
        assert.equal(
          can({ app, role: "admin" }, cap),
          can({ app, role: "manager" }, cap),
          `${app} admin vs manager on ${cap}`,
        );
      }
    }
  });

  test("an Accounts admin approves orders, because Accounts managers do", () => {
    assert.equal(can({ app: "accounts", role: "admin" }, "order.approve"), true);
  });
});

describe("the platform administrator", () => {
  test("Admin on the Admin Console holds every capability", () => {
    for (const cap of CAPABILITIES) {
      assert.equal(can({ app: "admin", role: "admin" }, cap), true, cap);
    }
  });

  test("a manager of the console writes settings and nothing else of the platform's", () => {
    assert.equal(can({ app: "admin", role: "manager" }, "config.write"), true);
    for (const cap of [...PLATFORM, ...LEDGER]) {
      assert.equal(can({ app: "admin", role: "manager" }, cap), false, cap);
    }
  });

  test("the account level is admin ONLY for Admin on the Admin Console", () => {
    const hats = (...h: Array<[AppId, Hat["role"]]>) => h.map(([app, role]) => ({ app, role }));
    assert.equal(widestRole(hats(["admin", "admin"])), "admin");
    assert.equal(widestRole(hats(["hrms", "admin"])), "manager");
    assert.equal(widestRole(hats(["erp", "admin"], ["crm", "associate"])), "manager");
    assert.equal(widestRole(hats(["admin", "manager"])), "manager");
    assert.equal(widestRole(hats(["crm", "associate"])), "associate");
    assert.equal(widestRole([]), "associate");
  });

  test("the retired app counts for nothing", () => {
    assert.equal(widestRole([{ app: "people", role: "admin" }]), "associate");
  });
});

describe("a field manager", () => {
  /* The handset is all that grant opens; capabilities are a union over hats,
     so anything here reaches every web action too. */
  test("does not hold the console's or the team's levers", () => {
    for (const cap of ["config.write", "sheet.import", "target.set", "whatsapp.bulk", "customer.assignSalesManager", "lead.trash"] as Capability[]) {
      assert.equal(can({ app: "field", role: "manager" }, cap), false, cap);
    }
  });

  test("does hold what a senior person decides in a shop", () => {
    for (const cap of ["lead.verify", "lead.override", "sample.approve", "distributor.terms"] as Capability[]) {
      assert.equal(can({ app: "field", role: "manager" }, cap), true, cap);
    }
  });
});

describe("conflicts", () => {
  test("an app administrator is warned like anybody else", () => {
    const got = conflictsFor([
      { app: "crm", role: "associate" },
      { app: "accounts", role: "admin" },
    ]);
    assert.ok(got.length >= 1, "CRM + Accounts admin is the ledger conflict");
  });

  test("a platform administrator is told none", () => {
    assert.deepEqual(
      conflictsFor([
        { app: "admin", role: "admin" },
        { app: "crm", role: "manager" },
        { app: "accounts", role: "manager" },
      ]),
      [],
    );
  });

  test("CRM and an Accounts manager is ONE warning, not three", () => {
    const got = conflictsFor([
      { app: "crm", role: "manager" },
      { app: "accounts", role: "manager" },
    ]);
    assert.equal(got.length, 1);
  });

  test("the price desk clashes with whoever quotes prices", () => {
    assert.equal(
      conflictsFor([
        { app: "crm", role: "associate" },
        { app: "accounts", role: "associate" },
      ]).length,
      1,
    );
  });
});
