/**
 * §11.6 — WHO MAY SAY A GST NUMBER IS REAL.
 *
 * Three assertions, and the middle one is the whole reason this file exists.
 *
 * The check was a tick inside `lead_qualification`, saved through an action
 * requiring `lead.work` — which the field salesman holds. So the man who typed
 * the number into his handset standing in the shop was also the man certifying
 * it was a business we could invoice. Mahek's answer to who should do it
 * instead was ACCOUNTS AND THE CALLING DESK, and the salesman is precisely who
 * it must stay away from.
 *
 * That is one grant the matrix cannot express through a shared set: `BOOK_WORK`
 * is held by the CRM, the handset and the Sales Dashboard alike, because
 * working a book is the same job in all three — so adding it there would hand
 * it straight back to the salesman. It is added to the CRM's associate level by
 * name, and this test is what stops somebody later "tidying" that into the set
 * and undoing the control without anything going red.
 *
 * The matrix is a table and `can()` is a pure read of it, but it lives in a
 * module that refuses to load without a `DATABASE_URL` — so one is set here
 * before the import. Nothing connects: the client is lazy and no assertion
 * below reaches it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://unused/unused";

/** Imported inside the tests rather than at the top, because the placeholder
 *  above has to be in place before the module is evaluated. */
async function can(
  hat: { app: string | null; role: string },
  capability: string,
): Promise<boolean> {
  const m = await import("./access-control");
  return m.can(hat as never, capability as never);
}

describe("§11.6 — the GST check is not the collector's", () => {
  test("the calling desk may validate", async () => {
    assert.equal(await can({ app: "crm", role: "associate" }, "lead.gstValidate"), true);
  });

  test("accounts may validate, clerk and manager alike", async () => {
    /* The CLERK especially. This is the desk that finds out the hard way that
       a GSTIN is wrong, and the first attempt at this grant reached every
       manager in the building while missing them. */
    assert.equal(await can({ app: "accounts", role: "associate" }, "lead.gstValidate"), true);
    assert.equal(await can({ app: "accounts", role: "manager" }, "lead.gstValidate"), true);
  });

  test("the calling desk's manager may too", async () => {
    assert.equal(await can({ app: "crm", role: "manager" }, "lead.gstValidate"), true);
  });

  /* THE ONE THAT MATTERS. A field associate is the salesman who collected the
     number. He is refused the capability outright — and refused a second time
     by `validateGstin`, which turns away the lead's own owner whatever hat he
     holds, so a salesman who is also a manager somewhere cannot come in the
     side door either. */
  test("the field salesman may NOT", async () => {
    assert.equal(await can({ app: "field", role: "associate" }, "lead.gstValidate"), false);
    assert.equal(await can({ app: "field", role: "manager" }, "lead.gstValidate"), false);
  });

  /* Admin holds everything everywhere by construction; asserted so the test
     reads as a complete statement rather than an omission somebody has to
     wonder about. */
  test("admin holds it, like everything", async () => {
    assert.equal(await can({ app: null, role: "admin" }, "lead.gstValidate"), true);
  });
});
