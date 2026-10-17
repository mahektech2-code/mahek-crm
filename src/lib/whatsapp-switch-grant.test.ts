/**
 * WHO HOLDS THE WHATSAPP SWITCH — the founder's desk, and only there.
 *
 * `whatsapp.activate` decides whether messages leave the building through the
 * API. Mahek's instruction was that only the founder decides it, so this pins
 * the capability to the Founder app and keeps it out of every manager set a
 * later tidy-up might fold it into. (An administrator holds every capability by
 * construction; the service additionally demands the Founder hat — see
 * `requireFounderDesk`.)
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

describe("the WhatsApp switch", () => {
  test("the founder's desk holds it", async () => {
    assert.equal(await can({ app: "founder", role: "associate" }, "whatsapp.activate"), true);
    assert.equal(await can({ app: "founder", role: "manager" }, "whatsapp.activate"), true);
  });

  test("no other app does, at either level", async () => {
    for (const app of ["crm", "sales", "field", "accounts", "reports", "hrms", "people", "enquiries"]) {
      assert.equal(await can({ app, role: "manager" }, "whatsapp.activate"), false, `${app} manager`);
      assert.equal(await can({ app, role: "associate" }, "whatsapp.activate"), false, `${app} associate`);
    }
  });
});
