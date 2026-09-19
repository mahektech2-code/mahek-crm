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
  /*
   * GRANTED BY APP AND NOT BY LEVEL, which is Mahek's own instruction: whoever
   * holds the Sales Dashboard, the CRM or the Accounts desk may check a GSTIN,
   * and an associate is not held to be too junior for it. So both levels of
   * all three are asserted rather than just the senior one — the first attempt
   * at this grant reached every MANAGER in the building and still missed the
   * accounts clerk who does this work all day.
   */
  for (const app of ["crm", "sales", "accounts"] as const) {
    for (const role of ["associate", "manager"] as const) {
      test(`${app} / ${role} may validate`, async () => {
        assert.equal(await can({ app, role }, "lead.gstValidate"), true);
      });
    }
  }

  /*
   * THE ONE THAT MATTERS, and the reason the capability is withheld by default
   * rather than left in no set at all.
   *
   * MBOS is the field salesman's app — the man who typed the number into his
   * phone standing in the shop. He is refused the capability outright, at both
   * levels, and refused a second time by `validateGstin`, which turns away the
   * lead's own owner whatever hat he holds. A capability in none of the
   * restricted sets is one everybody holds, which is exactly how an earlier
   * attempt handed this back to him with nothing going red.
   */
  test("the field salesman may NOT, at either level", async () => {
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
