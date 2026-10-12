import "server-only";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments, erpMaterialGroups, erpRawMaterials } from "@/db/schema";
import { bindErpFiles } from "./attachments";

/* ---------------------------------------------------------------------------
 * The photographs on a can and on a can group. They are ordinary attachments
 * under `erp_raw_material` / `erp_material_group`, read under the Raw
 * materials screen, and a photo taken off is marked removed — never deleted —
 * like every other attachment here.
 * ------------------------------------------------------------------------- */

export type PhotoParent = "erp_raw_material" | "erp_material_group";

/** The photos each parent carries, oldest first. */
export async function photosOf(parentType: PhotoParent, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: attachments.id, parent: attachments.parentId })
    .from(attachments)
    .where(and(eq(attachments.parentType, parentType), inArray(attachments.parentId, ids), eq(attachments.status, "available")))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  for (const r of rows) {
    if (!r.parent) continue;
    const list = out.get(r.parent) ?? [];
    list.push(r.id);
    out.set(r.parent, list);
  }
  return out;
}

/**
 * Makes a parent's photos exactly `keep`: new uploads are bound, photos no
 * longer named are marked removed. Only this person's own fresh uploads can be
 * bound — an id typed into a request cannot claim somebody else's file.
 */
export async function setPhotos(tx: typeof db, parentType: PhotoParent, parentId: string, keep: string[], userId: string): Promise<void> {
  await bindErpFiles(tx, keep, parentType, parentId, userId);
  const stale = and(
    eq(attachments.parentType, parentType),
    eq(attachments.parentId, parentId),
    eq(attachments.status, "available"),
    ...(keep.length ? [notInArray(attachments.id, keep)] : []),
  );
  await tx.update(attachments).set({ status: "removed", removedAt: new Date(), updatedAt: new Date() }).where(stale);
}

/** The groups of a material type, with their members' names — what "Group by name" plans against. */
export async function groupsWithMembers(materialType = "Can") {
  const [groups, members] = await Promise.all([
    db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.materialType, materialType)).orderBy(asc(erpMaterialGroups.name)),
    db
      .select({ id: erpRawMaterials.id, name: erpRawMaterials.name, groupId: erpRawMaterials.groupId, active: erpRawMaterials.active })
      .from(erpRawMaterials)
      .where(eq(erpRawMaterials.materialType, materialType))
      .orderBy(asc(erpRawMaterials.name)),
  ]);
  return groups.map((g) => ({ ...g, members: members.filter((m) => m.groupId === g.id) }));
}

/** The photo URL a screen draws. */
export const photoUrl = (id: string) => `/api/attachments/${id}`;
