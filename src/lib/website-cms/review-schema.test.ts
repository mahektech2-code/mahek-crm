/**
 * The review workflow's tables, against the real migration and a real database.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test`, created by `npm run test:db` from the committed
 * migrations — which is the point: these are the constraints the migration
 * itself declares, not a copy of them. It truncates between tests; never point
 * it at a database anybody is using.
 *
 * What it proves is the part of the workflow that must hold WHATEVER code writes
 * a row: nobody reviews their own submission, a rejection carries a reason, an
 * item is in at most one open request, an add has no base and an edit has one,
 * and the enforcement setting exists, off.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  users,
  websiteAssignment,
  websiteChangeItem,
  websiteChangeRequest,
  websiteContent,
  websiteReviewSetting,
} from "@/db/schema";
import { proposedHash } from "./review-hash";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test. Run `npm run test:db` first.");
});

after(async () => {
  await db.$client.end();
});

beforeEach(async () => {
  // website_content cascades into website_assignment; the change tables are listed so the order is not left to the cascade.
  await db.execute(sql`
    truncate table
      website_change_item, website_change_request, website_assignment,
      website_publish_log, website_content, users
    restart identity cascade
  `);
  // `users` cascades into the setting row (its updated_by_id points at a user), so the row is put back the way the migration leaves it.
  await db.insert(websiteReviewSetting).values({ id: "site", enforceAssignments: false }).onConflictDoNothing();
});

type Person = typeof users.$inferSelect;

async function person(name: string): Promise<Person> {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row;
}

async function content(slug = "thinner", data: Record<string, unknown> = { name: "Thinner" }) {
  const [row] = await db
    .insert(websiteContent)
    .values({ id: id("wc"), kind: "product", slug, sort: 10, state: "draft", data })
    .returning();
  return row;
}

async function request(submitter: Person, over: Partial<typeof websiteChangeRequest.$inferInsert> = {}) {
  const [row] = await db.insert(websiteChangeRequest).values({ id: id("wr"), submitterId: submitter.id, ...over }).returning();
  return row;
}

async function item(req: { id: string }, row: { id: string; slug: string }, over: Partial<typeof websiteChangeItem.$inferInsert> = {}) {
  const data = { name: "Thinner" };
  const [made] = await db
    .insert(websiteChangeItem)
    .values({
      id: id("wi"),
      requestId: req.id,
      contentId: row.id,
      kind: "product",
      slug: row.slug,
      action: "add",
      baseData: null,
      proposedData: data,
      proposedHash: proposedHash(data),
      submittedVersion: 1,
      ...over,
    })
    .returning();
  return made;
}

/** The database refuses the write, and it is THIS constraint that does it — not some other failure that happens to throw. */
async function refuses(run: () => Promise<unknown>, constraint: string) {
  try {
    await run();
  } catch (e) {
    const cause = ((e as { cause?: unknown }).cause ?? e) as { constraint_name?: string; message?: string };
    assert.equal(cause.constraint_name, constraint, `expected ${constraint}, got ${cause.constraint_name ?? cause.message}`);
    return;
  }
  assert.fail(`expected ${constraint} to refuse the write`);
}

/* ---------------------------------------------------------------- setting */

describe("the enforcement setting", () => {
  test("exists after the migration, is off, and is a single row", async () => {
    const rows = await db.select().from(websiteReviewSetting);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "site");
    assert.equal(rows[0].enforceAssignments, false, "off by default: nobody who can edit today loses that");
  });

  test("cannot be given a second row", async () => {
    await refuses(() => db.insert(websiteReviewSetting).values({ id: "other" }), "website_review_setting_single_row");
  });
});

/* ------------------------------------------------------------ assignments */

describe("assignments", () => {
  test("a person can be given a kind, and a kind-wide assignment has no content", async () => {
    const admin = await person("Admin One");
    const emp = await person("Emp One");
    const [a] = await db
      .insert(websiteAssignment)
      .values({ id: id("wa"), employeeId: emp.id, kind: "product", assignedById: admin.id })
      .returning();
    assert.equal(a.contentId, null);
    assert.equal(a.revokedAt, null);
  });

  test("assigning the same scope twice is refused while the first is live", async () => {
    const admin = await person("Admin One");
    const emp = await person("Emp One");
    const row = await content();
    for (const contentId of [null, row.id]) {
      await db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "product", contentId, assignedById: admin.id });
      await refuses(
        () => db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "product", contentId, assignedById: admin.id }),
        "website_assignment_active_key",
      );
    }
  });

  test("a revoked assignment does not block assigning again", async () => {
    const admin = await person("Admin One");
    const emp = await person("Emp One");
    const [first] = await db
      .insert(websiteAssignment)
      .values({ id: id("wa"), employeeId: emp.id, kind: "seo", assignedById: admin.id })
      .returning();
    await db.update(websiteAssignment).set({ revokedAt: new Date(), revokedById: admin.id }).where(eq(websiteAssignment.id, first.id));
    await db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "seo", assignedById: admin.id });
    const all = await db.select().from(websiteAssignment).where(eq(websiteAssignment.employeeId, emp.id));
    assert.equal(all.length, 2, "the revoked one stays as history");
  });

  test("two people can hold the same scope", async () => {
    const admin = await person("Admin One");
    const a = await person("Emp A");
    const b = await person("Emp B");
    for (const p of [a, b]) {
      await db.insert(websiteAssignment).values({ id: id("wa"), employeeId: p.id, kind: "gallery", assignedById: admin.id });
    }
    assert.equal((await db.select().from(websiteAssignment)).length, 2);
  });

  test("media can be assigned, an unknown kind cannot", async () => {
    const admin = await person("Admin One");
    const emp = await person("Emp One");
    await db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "media", assignedById: admin.id });
    await refuses(
      () => db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "blog", assignedById: admin.id }),
      "website_assignment_kind_check",
    );
  });

  test("a revocation names who did it, or is not a revocation", async () => {
    const admin = await person("Admin One");
    const emp = await person("Emp One");
    await refuses(
      () => db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "job", assignedById: admin.id, revokedAt: new Date() }),
      "website_assignment_revoked_pair",
    );
  });

  test("an assignment to one item goes when a never-published draft is deleted", async () => {
    const admin = await person("Admin One");
    const emp = await person("Emp One");
    const row = await content();
    await db.insert(websiteAssignment).values({ id: id("wa"), employeeId: emp.id, kind: "product", contentId: row.id, assignedById: admin.id });
    await db.delete(websiteContent).where(eq(websiteContent.id, row.id));
    assert.equal((await db.select().from(websiteAssignment)).length, 0, "it must not turn into a kind-wide assignment");
  });
});

/* --------------------------------------------------------------- requests */

describe("change requests", () => {
  test("start submitted", async () => {
    const emp = await person("Emp One");
    const r = await request(emp);
    assert.equal(r.status, "submitted");
    assert.equal(r.reviewerId, null);
  });

  test("an unknown status is refused", async () => {
    const emp = await person("Emp One");
    await refuses(() => request(emp, { status: "pending" }), "website_change_request_status_check");
  });

  test("nobody can be recorded as the reviewer of their own submission", async () => {
    const emp = await person("Emp One");
    await refuses(
      () =>
        request(emp, {
          status: "approved",
          reviewerId: emp.id,
          approvedAt: new Date(),
          approvalExpiresAt: new Date(Date.now() + 864e5),
        }),
      "website_change_request_not_self_reviewed",
    );
    // …and not by an update to an existing row either.
    const r = await request(emp);
    await refuses(
      () => db.update(websiteChangeRequest).set({ reviewerId: emp.id }).where(eq(websiteChangeRequest.id, r.id)),
      "website_change_request_not_self_reviewed",
    );
  });

  test("a rejection needs a reason — empty and blank are not reasons", async () => {
    const emp = await person("Emp One");
    const rev = await person("Rev One");
    for (const reason of [null, "", "   "]) {
      await refuses(
        () => request(emp, { status: "rejected", reviewerId: rev.id, reviewedAt: new Date(), rejectReason: reason }),
        "website_change_request_reject_has_reason",
      );
    }
    const ok = await request(emp, { status: "rejected", reviewerId: rev.id, reviewedAt: new Date(), rejectReason: "Wrong price." });
    assert.equal(ok.rejectReason, "Wrong price.");
  });

  test("an approval carries its reviewer, its time and its expiry", async () => {
    const emp = await person("Emp One");
    const rev = await person("Rev One");
    await refuses(() => request(emp, { status: "approved", reviewerId: rev.id, approvedAt: new Date() }), "website_change_request_approved_has_expiry");
    await refuses(() => request(emp, { status: "approved", approvedAt: new Date(), approvalExpiresAt: new Date() }), "website_change_request_approved_has_expiry");
    const ok = await request(emp, {
      status: "approved",
      reviewerId: rev.id,
      approvedAt: new Date(),
      approvalExpiresAt: new Date(Date.now() + 7 * 864e5),
    });
    assert.equal(ok.status, "approved");
  });

  test("a published request says who published it and when", async () => {
    const emp = await person("Emp One");
    await refuses(() => request(emp, { status: "published" }), "website_change_request_published_has_stamp");
    await refuses(() => request(emp, { status: "published", publishedAt: new Date() }), "website_change_request_published_has_stamp");
    const ok = await request(emp, { status: "published", publishedAt: new Date(), publishedById: emp.id });
    assert.equal(ok.status, "published");
  });

  test("a resubmission links to the request it follows", async () => {
    const emp = await person("Emp One");
    const rev = await person("Rev One");
    const first = await request(emp, { status: "rejected", reviewerId: rev.id, reviewedAt: new Date(), rejectReason: "No." });
    const second = await request(emp, { resubmissionOf: first.id });
    assert.equal(second.resubmissionOf, first.id);
  });
});

/* ------------------------------------------------------------------ items */

describe("change items", () => {
  test("an add has no base and an edit has one", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    await refuses(() => item(r, row, { action: "add", baseData: { name: "Old" } }), "website_change_item_add_has_no_base");
    await refuses(() => item(r, row, { action: "edit", baseData: null }), "website_change_item_add_has_no_base");
    const edit = await item(r, row, { action: "edit", baseData: { name: "Old" }, baseVersion: 3 });
    assert.equal(edit.action, "edit");
  });

  test("there is no remove in v1, and media is not a content kind", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    await refuses(() => item(r, row, { action: "remove" }), "website_change_item_action_check");
    await refuses(() => item(r, row, { kind: "media" }), "website_change_item_kind_check");
  });

  test("the hash is the full sha256", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    await refuses(() => item(r, row, { proposedHash: "abc123" }), "website_change_item_hash_check");
    const made = await item(r, row);
    assert.equal(made.proposedHash.length, 64);
  });

  test("the same content can be in a request only once", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    await item(r, row);
    await refuses(() => item(r, row), "website_change_item_request_content_key");
  });

  test("an item can be in at most ONE open request, and is free again when that request closes", async () => {
    const emp = await person("Emp One");
    const other = await person("Emp Two");
    const row = await content();
    const first = await request(emp);
    const firstItem = await item(first, row, { openContentId: row.id });

    const second = await request(other);
    await refuses(() => item(second, row, { openContentId: row.id }), "website_change_item_open_key");

    // Closing the first request frees the item…
    await db.update(websiteChangeItem).set({ openContentId: null }).where(eq(websiteChangeItem.id, firstItem.id));
    const secondItem = await item(second, row, { openContentId: row.id });
    assert.equal(secondItem.openContentId, row.id);
    // …and any number of CLOSED items for it may exist as history.
    const third = await request(emp);
    await item(third, row, { openContentId: null });
    const fourth = await request(emp);
    await item(fourth, row, { openContentId: null });
  });

  test("different items can be open at the same time", async () => {
    const emp = await person("Emp One");
    const a = await content("a");
    const b = await content("b");
    const r1 = await request(emp);
    const r2 = await request(emp);
    await item(r1, a, { openContentId: a.id });
    await item(r2, b, { openContentId: b.id });
  });

  test("a request keeps its items as history after the draft they were for is deleted", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    await item(r, row);
    await db.delete(websiteContent).where(eq(websiteContent.id, row.id));
    const left = await db.select().from(websiteChangeItem).where(eq(websiteChangeItem.requestId, r.id));
    assert.equal(left.length, 1, "no foreign key on content_id, on purpose");
    assert.equal(left[0].slug, "thinner");
  });

  test("deleting a request deletes its items", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    await item(r, row);
    await db.delete(websiteChangeRequest).where(eq(websiteChangeRequest.id, r.id));
    assert.equal((await db.select().from(websiteChangeItem)).length, 0);
  });

  test("the frozen content and the media lists round-trip exactly", async () => {
    const emp = await person("Emp One");
    const row = await content();
    const r = await request(emp);
    const data = { name: "Thinner", tag: "", specs: { Appearance: "Clear" }, benefits: ["Fast", "Cheap"] };
    const made = await item(r, row, {
      proposedData: data,
      proposedHash: proposedHash(data),
      mediaBefore: ["wm_aaaaaaaaaaaa"],
      mediaAfter: ["wm_bbbbbbbbbbbb"],
    });
    const [back] = await db.select().from(websiteChangeItem).where(eq(websiteChangeItem.id, made.id));
    assert.deepEqual(back.proposedData, data);
    assert.equal(proposedHash(back.proposedData), back.proposedHash, "the hash still matches what the database hands back");
    assert.deepEqual(back.mediaBefore, ["wm_aaaaaaaaaaaa"]);
    assert.deepEqual(back.mediaAfter, ["wm_bbbbbbbbbbbb"]);
  });
});
