import "server-only";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpMaterialGroups, erpRawMaterials } from "@/db/schema";
import { err, fieldErr, ok, okVoid } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpAudit, erpId, multi, text, type ScreenModule } from "../server";
import type { ActionSpec, FieldSpec, FormSpec, ListRow, ToolResult } from "../ui";
import { MAX_GROUP_PHOTOS, planCanGroups } from "../engines/can-groups";
import { groupsWithMembers, photoUrl, photosOf, setPhotos } from "../can-photos";
import { confirmImpact } from "@/lib/impact/registry";
import { readConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * CAN GROUPS: the Raw materials screen's second tab. Each group is a set of
 * look-alike cans — one print in several sizes — drawn as a card with its own
 * photo, so the floor recognises a can by sight rather than by reading a size
 * off a label.
 *
 * "Group cans by name" fills groups from the names, but only for cans nobody
 * has grouped: a can somebody moved stays where they put it. Everything it
 * does can be undone here — rename a group, change its members, delete it.
 * ------------------------------------------------------------------------- */

const TYPE = "Can";

async function canOptions(): Promise<{ id: string; name: string; groupId: string | null }[]> {
  return db
    .select({ id: erpRawMaterials.id, name: erpRawMaterials.name, groupId: erpRawMaterials.groupId })
    .from(erpRawMaterials)
    .where(and(eq(erpRawMaterials.materialType, TYPE), eq(erpRawMaterials.active, true)))
    .orderBy(erpRawMaterials.name);
}

function photoFields(): FieldSpec[] {
  return Array.from({ length: MAX_GROUP_PHOTOS }, (_, i) => ({
    k: `photo${i + 1}`,
    l: `Group photo ${i + 1}`,
    t: "photo" as const,
    upload: "material-photo" as const,
    wide: true,
    sec: i === 0 ? "Group photos" : undefined,
    ...(i === 0 ? { hint: `Up to ${MAX_GROUP_PHOTOS}: the cans of this group side by side is the most useful one.` } : {}),
  }));
}

function photosFrom(h: Record<string, string>): string[] {
  return [...new Set(Object.keys(h).filter((k) => /^photo\d+$/.test(k)).sort().map((k) => text(h[k])).filter((x): x is string => !!x))];
}

async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: erpMaterialGroups.id })
    .from(erpMaterialGroups)
    .where(and(eq(erpMaterialGroups.materialType, TYPE), sql`lower(${erpMaterialGroups.name}) = lower(${name})`, ...(exceptId ? [ne(erpMaterialGroups.id, exceptId)] : [])));
  return rows.length > 0;
}

/** The cans named on a form, by name; an unknown one is refused rather than dropped. */
function resolveMembers(picked: string[], cans: { id: string; name: string }[]): { ids: string[] } | { unknown: string } {
  const byName = new Map(cans.map((c) => [c.name, c.id]));
  const unknown = picked.find((p) => !byName.has(p));
  if (unknown) return { unknown };
  return { ids: picked.map((p) => byName.get(p)!) };
}

async function groupForm(id?: string): Promise<FormSpec | null> {
  const cans = await canOptions();
  let init: Record<string, string> | undefined;
  let title = "New can group";
  if (id) {
    const [g] = await db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.id, id));
    if (!g) return null;
    const photos = (await photosOf("erp_material_group", [id])).get(id) ?? [];
    init = {
      name: g.name,
      members: cans.filter((c) => c.groupId === id).map((c) => c.name).join("|"),
      remark: g.remark ?? "",
      ...Object.fromEntries(Array.from({ length: MAX_GROUP_PHOTOS }, (_, i) => [`photo${i + 1}`, photos[i] ?? ""])),
    };
    title = `Edit group · ${g.name}`;
  }
  return {
    screen: "canGroups",
    id: id ? "edit" : "new",
    recordId: id,
    title,
    sub: "Cans that look alike — one print in several sizes. Ticking a can that is in another group moves it here.",
    submit: id ? "Save group" : "Add group",
    init,
    header: [
      { k: "name", l: "Group name", t: "text", req: true, wide: true },
      { k: "members", l: "Cans in this group", t: "multi", wide: true, opts: cans.map((c) => c.name) },
      { k: "remark", l: "Remark", t: "area" },
      ...photoFields(),
    ],
  };
}

async function saveGroup(ctx: ErpContext, h: Record<string, string>, id?: string) {
  const name = text(h.name);
  if (!name) return fieldErr("name", "Group name is required");
  if (await nameTaken(name, id)) return fieldErr("name", "There is already a group of that name");
  const cans = await canOptions();
  const members = resolveMembers(multi(h.members), cans);
  if ("unknown" in members) return fieldErr("members", `${members.unknown} is no longer an active can`);
  const photos = photosFrom(h);
  if (photos.length > MAX_GROUP_PHOTOS) return err(`A group takes up to ${MAX_GROUP_PHOTOS} photos.`);
  const groupId = id ?? erpId("erpmg");
  if (id) {
    const [g] = await db.select({ id: erpMaterialGroups.id }).from(erpMaterialGroups).where(eq(erpMaterialGroups.id, id));
    if (!g) return err("That group no longer exists.", "not_found");
  }
  const membersBefore = id ? cans.filter((c) => c.groupId === id).map((c) => c.id) : [];
  await db.transaction(async (tx) => {
    if (id) {
      await tx.update(erpMaterialGroups).set({ name, remark: text(h.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpMaterialGroups.id, id));
    } else {
      await tx.insert(erpMaterialGroups).values({ id: groupId, name, materialType: TYPE, remark: text(h.remark), createdById: ctx.user.id, updatedById: ctx.user.id });
    }
    /* Members are the whole list: unticked cans leave (to no group), ticked ones join. Only
       ACTIVE cans are offered, so a retired can keeps the group it had. */
    const leaving = membersBefore.filter((m) => !members.ids.includes(m));
    if (leaving.length) await tx.update(erpRawMaterials).set({ groupId: null, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpRawMaterials.id, leaving));
    if (members.ids.length) await tx.update(erpRawMaterials).set({ groupId, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpRawMaterials.id, members.ids));
    await setPhotos(tx as unknown as typeof db, "erp_material_group", groupId, photos, ctx.actor.id);
  });
  await erpAudit(ctx, id ? "erp.canGroup.edit" : "erp.canGroup.create", "erp_material_group", groupId, id ? { members: membersBefore } : null, { name, members: members.ids, photos });
  return okVoid(`${name} · ${members.ids.length} can${members.ids.length === 1 ? "" : "s"}`);
}

const canGroups: ScreenModule = {
  key: "canGroups",
  async load() {
    const groups = await groupsWithMembers(TYPE);
    const ids = groups.map((g) => g.id);
    const memberIds = groups.flatMap((g) => g.members.map((m) => m.id));
    const [groupPhotos, canPhotos, ungrouped] = await Promise.all([
      photosOf("erp_material_group", ids),
      photosOf("erp_raw_material", memberIds),
      db
        .select({ id: erpRawMaterials.id })
        .from(erpRawMaterials)
        .where(and(eq(erpRawMaterials.materialType, TYPE), eq(erpRawMaterials.active, true), isNull(erpRawMaterials.groupId))),
    ]);
    const form = await groupForm();
    return {
      spec: {
        screen: "canGroups",
        cols: [
          { k: "name", l: "Group", t: "b" },
          { k: "count", l: "Cans", t: "n" },
          { k: "members", l: "Cans in it", t: "t" },
          { k: "photos", l: "Group photos", t: "n" },
          { k: "state", l: "Photos", t: "s" },
        ],
        hidden: [],
        chips: "state",
        sortDefault: ["name", 1],
        cards: { img: "img", title: "name", lines: ["countLine", "members"], empty: "No photo yet" },
        newForm: form ?? undefined,
        newLabel: "New group",
        tools: [
          {
            id: "groupByName",
            l: ungrouped.length ? `Group cans by name (${ungrouped.length} not grouped)` : "Group cans by name",
            why: ungrouped.length ? undefined : "Every active can is already in a group",
            confirm: "Put every can that is not in a group into a group of look-alikes, read from its name? Cans already in a group are left where they are, and every group can be renamed or changed afterwards.",
          },
        ],
        noDataLine: "No can groups yet. “Group cans by name” makes them from the names, or add one by hand.",
      },
      rows: groups.map((g): ListRow => {
        const gp = groupPhotos.get(g.id) ?? [];
        const firstMemberPhoto = g.members.map((m) => canPhotos.get(m.id)?.[0]).find(Boolean);
        const img = gp[0] ?? firstMemberPhoto;
        const actions: ActionSpec[] = [
          { id: "edit", l: "Edit group", primary: true, loadsForm: true },
          {
            id: "rename",
            l: "Rename",
            prompt: { title: "Rename group", sub: g.name, submit: "Rename", init: { name: g.name }, fields: [{ k: "name", l: "Group name", t: "text", req: true }] },
          },
          {
            id: "delete",
            l: "Delete group",
            /* Its cans stay on the books, ungrouped; its photos come off. */
            impact: { kind: "erp-can-group", id: g.id },
          },
        ];
        return {
          id: g.id,
          v: {
            name: g.name,
            count: g.members.length,
            countLine: `${g.members.length} can${g.members.length === 1 ? "" : "s"} · ${gp.length} group photo${gp.length === 1 ? "" : "s"}`,
            members: g.members.map((m) => m.name).join(", ") || "—",
            photos: gp.length,
            state: gp.length ? "Has photos" : "No photo",
            img: img ? photoUrl(img) : "",
          },
          flags: [],
          title: g.name,
          header: `${g.members.length} can${g.members.length === 1 ? "" : "s"}`,
          fields: g.remark ? [{ l: "Remark", v: g.remark }] : undefined,
          actions,
          panel: {
            kind: "canGroup",
            data: {
              photos: gp.map(photoUrl),
              max: MAX_GROUP_PHOTOS,
              members: g.members.map((m) => ({ name: m.name, active: m.active, photos: (canPhotos.get(m.id) ?? []).map(photoUrl) })),
            },
          },
        };
      }),
    };
  },
  formLoaders: {
    edit: (_ctx, id) => groupForm(id),
  },
  forms: {
    new: (ctx, h) => saveGroup(ctx, h),
    edit: (ctx, h, _l, id) => saveGroup(ctx, h, id),
  },
  actions: {
    async rename(ctx, id, values) {
      const name = text(values.name);
      if (!name) return fieldErr("name", "Group name is required");
      const [g] = await db.select({ name: erpMaterialGroups.name }).from(erpMaterialGroups).where(eq(erpMaterialGroups.id, id));
      if (!g) return err("That group no longer exists.", "not_found");
      if (await nameTaken(name, id)) return fieldErr("name", "There is already a group of that name");
      await db.update(erpMaterialGroups).set({ name, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpMaterialGroups.id, id));
      await erpAudit(ctx, "erp.canGroup.rename", "erp_material_group", id, { name: g.name }, { name });
      return okVoid(`Renamed to ${name}`);
    },
    async delete(ctx, id, values) {
      const [g] = await db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.id, id));
      if (!g) return err("That group no longer exists.", "not_found");
      const refusal = await confirmImpact("erp-can-group", id, readConfirmation(values));
      if (refusal) return refusal;
      await db.transaction(async (tx) => {
        await tx.update(erpRawMaterials).set({ groupId: null, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRawMaterials.groupId, id));
        await setPhotos(tx as unknown as typeof db, "erp_material_group", id, [], ctx.actor.id);
        await tx.delete(erpMaterialGroups).where(eq(erpMaterialGroups.id, id));
      });
      await erpAudit(ctx, "erp.canGroup.delete", "erp_material_group", id, g, null);
      return okVoid(`${g.name} deleted · its cans are now not grouped`);
    },
  },
  tools: {
    async groupByName(ctx) {
      const [existing, loose] = await Promise.all([
        groupsWithMembers(TYPE),
        db
          .select({ id: erpRawMaterials.id, name: erpRawMaterials.name })
          .from(erpRawMaterials)
          .where(and(eq(erpRawMaterials.materialType, TYPE), eq(erpRawMaterials.active, true), isNull(erpRawMaterials.groupId))),
      ]);
      if (!loose.length) return err("Every active can is already in a group.");
      const plan = planCanGroups(loose, existing.map((g) => ({ id: g.id, name: g.name, memberNames: g.members.map((m) => m.name) })));
      await db.transaction(async (tx) => {
        for (const c of plan.create) {
          const gid = erpId("erpmg");
          await tx.insert(erpMaterialGroups).values({ id: gid, name: c.name, materialType: TYPE, createdById: ctx.user.id, updatedById: ctx.user.id });
          /* `group_id is null` again under the write: a can somebody grouped a moment ago keeps it. */
          await tx.update(erpRawMaterials).set({ groupId: gid, updatedAt: new Date(), updatedById: ctx.user.id }).where(and(inArray(erpRawMaterials.id, c.memberIds), isNull(erpRawMaterials.groupId)));
        }
        for (const j of plan.join)
          await tx.update(erpRawMaterials).set({ groupId: j.groupId, updatedAt: new Date(), updatedById: ctx.user.id }).where(and(inArray(erpRawMaterials.id, j.memberIds), isNull(erpRawMaterials.groupId)));
      });
      await erpAudit(ctx, "erp.canGroup.byName", "erp_material_group", null, null, plan);
      const placed = plan.create.reduce((n, c) => n + c.memberIds.length, 0) + plan.join.reduce((n, j) => n + j.memberIds.length, 0);
      const lines: NonNullable<ToolResult["dialog"]>["lines"] = [
        ...plan.create.map((c) => ({ text: `New group ${c.name}: ${c.memberIds.length} cans`, tone: "success" as const })),
        ...plan.join.map((j) => ({ text: `Added to ${j.groupName}: ${j.memberIds.length} can${j.memberIds.length === 1 ? "" : "s"}`, tone: "info" as const })),
        ...plan.left.map((l) => ({
          text: `${l.name} — not grouped: ${l.why === "no_family" ? "its name is only a size" : "no other can shares its name"}`,
          tone: "muted" as const,
        })),
      ];
      const data: ToolResult = {
        dialog: {
          title: "Cans grouped by name",
          sub: `${placed} can${placed === 1 ? "" : "s"} placed${plan.left.length ? `, ${plan.left.length} left for you to place` : ""}. Rename a group or change its cans from its card; a can's own group is on its Edit form.`,
          lines,
        },
      };
      return ok(data, placed ? `${placed} can${placed === 1 ? "" : "s"} grouped` : "Nothing to group by name");
    },
  },
};

export const CAN_GROUP_SCREENS: ScreenModule[] = [canGroups];
