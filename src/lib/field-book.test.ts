/**
 * A field salesman's book, which he did not have.
 *
 * `scopedToUsers` asks which customers carry somebody in one of the two
 * manager seats. For a field salesman the answer is none: those seats hold
 * account managers, and a field salesman is named — as free text off the party
 * sheet — in `customers.sales_person_name`. So MBOS sent his handset an empty
 * book, correctly, and nothing on any screen could say why.
 *
 * Four things are worth pinning, and every one of them is a rule a later
 * change could break without a type error:
 *
 *   THE NAME IS FOLDED, not compared. Sheets produce "  mahesh   PARAB ", and
 *   a link that only matched an exact string would be a feature that works in
 *   a test and never once in production.
 *
 *   IT IS DELIBERATE. An account with no link gets nothing, however well its
 *   `users.name` happens to match. A scope rule that turns itself on when
 *   somebody is renamed is the one kind this codebase cannot have.
 *
 *   IT DOES NOT LEAK. One salesman's name must never reach another's handset,
 *   and the CRM's own definition of whose book a customer is in must not move
 *   at all.
 *
 *   AN ADMIN IS STILL UNRESTRICTED. The widening is an `or` over a scope that
 *   can be null, and null means everything — a mistake there would narrow an
 *   admin to the name match instead.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { scopedToUsers } from "@/lib/access-control";
import { customerIdsInScope, type MbosPrincipal } from "@/lib/services/mbos-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** How the party sheet actually spells it, doubled spaces and all. */
const AS_THE_SHEET_HAS_IT = "  mahesh   PARAB ";
/** How a person would type it into the console. Same name, tidy. */
const AS_A_PERSON_TYPES_IT = "Mahesh Parab";

let salesman: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let hisShops: string[];
let herShop: string;

function principalFor(user: typeof users.$inferSelect): MbosPrincipal {
  return {
    user,
    deviceId: "dev_test",
    role: "telecaller",
    scope: { kind: "own", userIds: [user.id] },
  };
}

async function makeUser(name: string, email: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email,
      passwordHash: "x",
      role: "telecaller",
      initials: "XX",
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: row.id, app: "field" });
  return row;
}

let phoneCounter = 9820000000;

async function makeShop(name: string, salesPersonName: string | null) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      /* Both NOT NULL: a shop is something somebody rings and delivers to, so
         the schema refuses one without a number or a town. */
      phone: String(++phoneCounter),
      city: "Nagpur",
      kind: "customer",
      salesPersonName,
    })
    .returning();
  return row.id;
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

/* Without this the pool holds the event loop open, the process never exits,
   and node:test's output is never flushed — a green suite that looks like a
   hang. Every other integration suite here ends the same way. */
after(async () => {
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh Parab", "mahesh@test.local");
  other = await makeUser("Rahul Richhariya", "rahul@test.local");

  hisShops = [
    await makeShop("Sadar Paints", AS_THE_SHEET_HAS_IT),
    await makeShop("Itwari Hardware", "MAHESH PARAB"),
  ];
  herShop = await makeShop("Dharampeth Colour", "Rahul Richhariya");
  await makeShop("Nobody's Shop", null);
});

describe("a field salesman's book", () => {
  test("is empty until somebody links the login to the name", async () => {
    const ids = await customerIdsInScope(principalFor(salesman));
    assert.deepEqual(ids, [], "an unlinked account must hold no shops, however well the name matches");
  });

  test("the link is what fills it, and the name is folded not matched", async () => {
    await db
      .update(users)
      .set({ salesPersonName: AS_A_PERSON_TYPES_IT })
      .where(eq(users.id, salesman.id));

    const linked = { ...salesman, salesPersonName: AS_A_PERSON_TYPES_IT };
    const ids = await customerIdsInScope(principalFor(linked));

    assert.deepEqual(
      [...ids].sort(),
      [...hisShops].sort(),
      "both spellings should fold onto the typed name — doubled spaces and wrong case included",
    );
  });

  test("one salesman's shops never reach another's handset", async () => {
    await db
      .update(users)
      .set({ salesPersonName: AS_A_PERSON_TYPES_IT })
      .where(eq(users.id, salesman.id));

    const ids = await customerIdsInScope(
      principalFor({ ...salesman, salesPersonName: AS_A_PERSON_TYPES_IT }),
    );
    assert.ok(!ids.includes(herShop), "Rahul's shop must not be in Mahesh's book");

    await db
      .update(users)
      .set({ salesPersonName: "Rahul Richhariya" })
      .where(eq(users.id, other.id));
    const hers = await customerIdsInScope(
      principalFor({ ...other, salesPersonName: "Rahul Richhariya" }),
    );
    assert.deepEqual(hers, [herShop]);
  });

  test("the link is read from the database, never from the principal", async () => {
    /*
     * The principal is assembled from a token on every request, and this asks
     * the question in SQL against `users` rather than trusting the object it
     * was handed. So a principal carrying a link the account does not actually
     * hold widens nothing — which is the difference between a scope rule and a
     * suggestion.
     */
    const pretending = principalFor({ ...salesman, salesPersonName: AS_A_PERSON_TYPES_IT });
    const ids = await customerIdsInScope(pretending);
    assert.deepEqual(ids, [], "an unlinked account must stay empty however its principal is dressed up");
  });

  test("a manager on the handset sees the shops his team is named on", async () => {
    await db
      .update(users)
      .set({ salesPersonName: AS_A_PERSON_TYPES_IT })
      .where(eq(users.id, salesman.id));
    await db
      .update(users)
      .set({ salesPersonName: "Rahul Richhariya" })
      .where(eq(users.id, other.id));

    const [manager] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Vikram",
        email: "vikram@test.local",
        passwordHash: "x",
        role: "manager",
        initials: "V",
      })
      .returning();

    /* Team scope is the two reports plus the manager himself, which is what
       `loadPrincipal` resolves for a manager on the field app. */
    const ids = await customerIdsInScope({
      user: manager,
      deviceId: "dev_test",
      role: "manager",
      scope: { kind: "team", userIds: [manager.id, salesman.id, other.id] },
    });

    assert.deepEqual(
      [...ids].sort(),
      [...hisShops, herShop].sort(),
      "a manager and his salesmen must not hold two different books",
    );
  });

  test("an admin is still unrestricted, not narrowed to the name match", async () => {
    const [admin] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Root",
        email: "root@test.local",
        passwordHash: "x",
        role: "admin",
        initials: "R",
      })
      .returning();

    const ids = await customerIdsInScope({
      user: admin,
      deviceId: "dev_test",
      role: "admin",
      scope: { kind: "all", userIds: null },
    });

    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers);
    assert.equal(ids.length, n, "an unrestricted scope must return every customer, name link or not");
  });

  test("an empty link matches nothing, rather than every unnamed shop", async () => {
    /* The dangerous shape: a blank string folds to a blank string, and a shop
       with no salesperson folds to the same. Without the guard, giving one
       person an empty link would hand them every unassigned shop in the book. */
    await db.update(users).set({ salesPersonName: "   " }).where(eq(users.id, salesman.id));

    const ids = await customerIdsInScope(principalFor({ ...salesman, salesPersonName: "   " }));
    assert.deepEqual(ids, []);
  });

  test("the CRM's own definition of whose book it is does not move", async () => {
    await db
      .update(users)
      .set({ salesPersonName: AS_A_PERSON_TYPES_IT })
      .where(eq(users.id, salesman.id));

    /* `scopedToUsers` is what thirty-one CRM screens read. Widening MBOS must
       leave it exactly as it was: the name link is MBOS's question, and a
       salesperson's name has never put a customer on a calling queue. */
    const rows = await db
      .select({ id: customers.id })
      .from(customers)
      .where(scopedToUsers([salesman.id]));

    assert.deepEqual(rows, [], "the CRM must still see no book for a seatless salesman");
  });
});
