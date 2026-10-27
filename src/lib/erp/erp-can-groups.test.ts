/**
 * Can photos and can groups, against a real database through the real handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, attachments, erpMaterialGroups, erpRawMaterials, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { canReadErpAttachment } from "@/lib/erp/attachments";
import type { ToolResult } from "@/lib/erp/ui";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD } from "@/lib/impact/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

let admin: typeof users.$inferSelect;

async function ctx() {
  setTestUser(admin);
  return erpContext();
}

async function can(name: string, serialNo: number) {
  const rmId = id("erprm");
  await db.insert(erpRawMaterials).values({ id: rmId, serialNo, name, code: `C${serialNo}`, unit: "Unit", materialType: "Can", testingList: [] });
  return rmId;
}

async function upload(by = admin.id) {
  const aid = id("att");
  await db.insert(attachments).values({ id: aid, filename: "can.jpg", storedRef: `test/${aid}`, contentType: "image/jpeg", sizeBytes: 10, status: "available", uploadedById: by } as never);
  return aid;
}

before(async () => {
  await db.execute(sql`truncate users, erp_raw_materials, erp_material_groups, attachments, audit_log restart identity cascade`);
  [admin] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Kavita Admin", email: "kavita@cans.test", phone: "9820099001", passwordHash: "x", role: "admin", initials: "KA" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: admin.id, app: "erp", role: "admin" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("can photos and groups", () => {
  test("grouping by name fills only ungrouped cans, and says what it left", async () => {
    const c = await ctx();
    const y1 = await can("Packing Material 1 liter Mahek Yellow", 1);
    const y5 = await can("Packing Material 5 liter Mahek Yellow", 2);
    const n1 = await can("Naked 1 Liter", 3);
    const n20 = await can("Naked 20 Liter", 4);
    const lone = await can("1 L Tin Can", 5);
    /* Somebody already put this can in a group of their own — it must stay there. */
    const mine = id("erpmg");
    await db.insert(erpMaterialGroups).values({ id: mine, name: "Special shelf", materialType: "Can" });
    const n5 = await can("Blue Star 5 Liter", 6);
    await db.update(erpRawMaterials).set({ groupId: mine }).where(eq(erpRawMaterials.id, n5));

    const res = await mod("canGroups").tools!.groupByName(c, {});
    assert.ok(res.ok, res.ok ? "" : res.error);
    const dialog = (res.data as ToolResult).dialog!;
    assert.match(dialog.sub ?? "", /4 cans placed, 1 left/);

    const rows = await db.select({ id: erpRawMaterials.id, g: erpRawMaterials.groupId }).from(erpRawMaterials);
    const g = new Map(rows.map((r) => [r.id, r.g]));
    assert.ok(g.get(y1) && g.get(y1) === g.get(y5));
    assert.ok(g.get(n1) && g.get(n1) === g.get(n20));
    assert.notEqual(g.get(y1), g.get(n1));
    assert.equal(g.get(lone), null);
    assert.equal(g.get(n5), mine);
    const names = (await db.select({ n: erpMaterialGroups.name }).from(erpMaterialGroups)).map((x) => x.n).sort();
    assert.deepEqual(names, ["Mahek Yellow", "Naked", "Special shelf"]);

    /* A later Blue Star can joins the group a person put its family in. */
    const b1 = await can("Blue Star 1 Liter", 7);
    const again = await mod("canGroups").tools!.groupByName(c, {});
    assert.ok(again.ok);
    const [b1Row] = await db.select({ g: erpRawMaterials.groupId }).from(erpRawMaterials).where(eq(erpRawMaterials.id, b1));
    assert.equal(b1Row.g, mine);
  });

  test("a group is renamed, its members changed and its photos capped at three", async () => {
    const c = await ctx();
    const [yellow] = await db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.name, "Mahek Yellow"));
    const renamed = await mod("canGroups").actions!.rename(c, yellow.id, { name: "Yellow print" });
    assert.ok(renamed.ok);
    const clash = await mod("canGroups").actions!.rename(c, yellow.id, { name: "naked" });
    assert.equal(clash.ok, false);

    const [a, b, d, e] = [await upload(), await upload(), await upload(), await upload()];
    const tooMany = await mod("canGroups").forms!.edit(c, { name: "Yellow print", members: "", photo1: a, photo2: b, photo3: d, photo4: e }, [], yellow.id);
    assert.equal(tooMany.ok, false);

    const saved = await mod("canGroups").forms!.edit(
      c,
      { name: "Yellow print", members: "Packing Material 1 liter Mahek Yellow|Naked 1 Liter", photo1: a, photo2: b },
      [],
      yellow.id,
    );
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    const members = await db.select({ name: erpRawMaterials.name }).from(erpRawMaterials).where(eq(erpRawMaterials.groupId, yellow.id));
    assert.deepEqual(members.map((m) => m.name).sort(), ["Naked 1 Liter", "Packing Material 1 liter Mahek Yellow"]);
    const bound = await db.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.parentType, "erp_material_group"), eq(attachments.parentId, yellow.id), eq(attachments.status, "available")));
    assert.equal(bound.length, 2);

    /* Taking one off marks it removed, never deletes it. */
    await mod("canGroups").forms!.edit(c, { name: "Yellow print", members: "Packing Material 1 liter Mahek Yellow|Naked 1 Liter", photo1: b }, [], yellow.id);
    const [gone] = await db.select({ status: attachments.status }).from(attachments).where(eq(attachments.id, a));
    assert.equal(gone.status, "removed");
    assert.ok(await canReadErpAttachment(admin.id, "erp_material_group", yellow.id));
  });

  test("a can carries up to three photos, and moves group from its edit form", async () => {
    const c = await ctx();
    const [can1] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, "1 L Tin Can"));
    const p = [await upload(), await upload(), await upload()];
    const res = await mod("rawMaterials").forms!.photos(c, { photo1: p[0], photo2: p[1], photo3: p[2] }, [], can1.id);
    assert.ok(res.ok, res.ok ? "" : res.error);
    const form = await mod("rawMaterials").formLoaders!.photos(c, can1.id);
    assert.deepEqual([form!.init!.photo1, form!.init!.photo2, form!.init!.photo3].sort(), [...p].sort());

    /* Somebody else's upload cannot be claimed by naming its id. */
    const [other] = await db
      .insert(users)
      .values({ id: id("usr"), name: "Other", email: "other@cans.test", phone: "9820099002", passwordHash: "x", role: "associate", initials: "OT" })
      .returning();
    const theirs = await upload(other.id);
    await mod("rawMaterials").forms!.photos(c, { photo1: theirs }, [], can1.id);
    const [still] = await db.select({ parent: attachments.parentId }).from(attachments).where(eq(attachments.id, theirs));
    assert.equal(still.parent, null);

    const moved = await mod("rawMaterials").forms!.edit(c, { name: can1.name, code: "C5", unit: "Unit", materialType: "Can", group: "Naked" }, [], can1.id);
    assert.ok(moved.ok, moved.ok ? "" : moved.error);
    const [naked] = await db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.name, "Naked"));
    const [after1] = await db.select({ g: erpRawMaterials.groupId }).from(erpRawMaterials).where(eq(erpRawMaterials.id, can1.id));
    assert.equal(after1.g, naked.id);

    const load = await mod("rawMaterials").load(c);
    const row = load.rows.find((r) => r.id === can1.id)!;
    assert.equal(row.v.group, "Naked");
    assert.equal(row.panel?.kind, "canPhotos");
  });

  test("deleting a group leaves its cans on the books, not grouped", async () => {
    const c = await ctx();
    const [naked] = await db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.name, "Naked"));
    /* Refused until the impact modal's confirmation comes with it. */
    assert.equal((await mod("canGroups").actions!.delete(c, naked.id, {})).ok, false);
    const report = await impactReport("erp-can-group", naked.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.equal(report.data.confirmWord, "Naked");
    const members = report.data.items.find((i) => i.effect === "unlinked");
    assert.ok(members && members.count >= 1 && members.examples?.includes("Naked 20 Liter"), JSON.stringify(report.data.items));
    const res = await mod("canGroups").actions!.delete(c, naked.id, {
      [IMPACT_FIELD]: JSON.stringify({ typed: "naked", fingerprint: report.data.fingerprint }),
    });
    assert.ok(res.ok, JSON.stringify(res));
    const left = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, "Naked 20 Liter"));
    assert.equal(left[0].groupId, null);
    const view = await mod("canGroups").load(c);
    assert.ok(!view.rows.some((r) => r.id === naked.id));
  });
});
