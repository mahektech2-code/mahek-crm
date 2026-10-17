/**
 * WHO MAY CHANGE A PRICE LIST — the accounts team and the founder's desk.
 *
 * `pricelist.manage` shipped in `ACCOUNTS_OR_MANAGER`, which spreads into
 * `BOOK_MANAGEMENT` and so reached every CRM manager and every Sales Dashboard
 * manager. Mahek's instruction was that those two apps READ price lists and
 * never write them. This file is what stops somebody later "tidying" the grant
 * back into a shared set and undoing the control without anything going red.
 *
 * `access-control` refuses to load without a `DATABASE_URL`, so a placeholder
 * is set before the import. Nothing connects.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://unused/unused";

async function can(hat: { app: string | null; role: string }, capability: string): Promise<boolean> {
  const m = await import("./access-control");
  return m.can(hat as never, capability as never);
}

describe("the price desk", () => {
  test("the accounts team holds it at both levels", async () => {
    assert.equal(await can({ app: "accounts", role: "associate" }, "pricelist.manage"), true);
    assert.equal(await can({ app: "accounts", role: "manager" }, "pricelist.manage"), true);
  });

  test("the founder's desk holds it at both levels", async () => {
    assert.equal(await can({ app: "founder", role: "associate" }, "pricelist.manage"), true);
    assert.equal(await can({ app: "founder", role: "manager" }, "pricelist.manage"), true);
  });

  test("a CRM manager and a Sales Dashboard manager do NOT — they quote prices, they do not set them", async () => {
    for (const app of ["crm", "sales", "field", "reports", "hrms"]) {
      assert.equal(await can({ app, role: "manager" }, "pricelist.manage"), false, `${app} manager`);
      assert.equal(await can({ app, role: "associate" }, "pricelist.manage"), false, `${app} associate`);
    }
  });

  test("everybody who quotes a price can still read one, and so can the desk that issues them", async () => {
    for (const app of ["crm", "sales", "field", "accounts", "founder"]) {
      assert.equal(await can({ app, role: "associate" }, "pricelist.read"), true, app);
    }
  });

  test("an administrator holds it, as they hold everything", async () => {
    assert.equal(await can({ app: "admin", role: "admin" }, "pricelist.manage"), true);
  });
});
