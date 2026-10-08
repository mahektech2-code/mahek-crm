import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, erpDesignations, erpMaterialDuties, erpRawMaterials, erpUserDesignations, users } from "@/db/schema";
import type { ErpContext } from "./access";
import { erpAudit, erpId } from "./server";
import {
  DUTY_LABEL,
  MATERIAL_DUTIES,
  dutyAllows,
  dutyAllowsAll,
  dutyApplies,
  dutyBookFrom,
  dutyRefusal,
  holderNames,
  isConfigured,
  type DutyActor,
  type DutyBook,
  type DutyHolders,
  type MaterialDuty,
} from "./material-duties";

/* ---------------------------------------------------------------------------
 * The material duties wired to data: read once per screen load, asked per
 * record. The rule itself is `material-duties.ts`.
 * ------------------------------------------------------------------------- */

export type DutyKit = {
  book: DutyBook;
  actor: DutyActor;
  /** May this person do `duty` for the material? `fallback` answers where it is not configured. */
  allows: (materialId: string, duty: MaterialDuty, fallback?: boolean) => boolean;
  /** The same over several materials — all must allow it. */
  allowsAll: (materialIds: readonly string[], duty: MaterialDuty, fallback?: boolean) => boolean;
  /** "Raising a PO for Mix Xylene is set to …" — null where the duty is not configured. */
  refusal: (material: { id: string; name: string }, duty: MaterialDuty) => string | null;
};

/** Names for people and departments, so a refusal and the drawer can say who. */
async function dutyNames() {
  const [u, d] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users),
    db.select({ id: erpDesignations.id, name: erpDesignations.name }).from(erpDesignations),
  ]);
  return { users: new Map(u.map((x) => [x.id, x.name])), designations: new Map(d.map((x) => [x.id, x.name])) };
}

/**
 * Who is asking, as the duties read it. While an administrator previews the
 * ERP as a designation, the designation is the one in force — so the preview
 * shows exactly which buttons that department would get.
 */
async function actorOf(ctx: ErpContext): Promise<DutyActor> {
  if (ctx.viewingAs?.kind === "designation") return { userId: "", designationIds: [ctx.viewingAs.id], administrator: ctx.administrator };
  const rows = await db.select({ id: erpUserDesignations.designationId }).from(erpUserDesignations).where(eq(erpUserDesignations.userId, ctx.user.id));
  return { userId: ctx.user.id, designationIds: rows.map((r) => r.id), administrator: ctx.administrator };
}

export async function dutyKit(ctx: ErpContext): Promise<DutyKit> {
  const [rows, actor, names] = await Promise.all([db.select().from(erpMaterialDuties), actorOf(ctx), dutyNames()]);
  const book = dutyBookFrom(rows);
  return {
    book,
    actor,
    allows: (id, duty, fallback = true) => dutyAllows(book, id, duty, actor, fallback),
    allowsAll: (ids, duty, fallback = true) => dutyAllowsAll(book, ids, duty, actor, fallback),
    refusal: (m, duty) => dutyRefusal(book, m, duty, names),
  };
}

/* ---------------------------------------------------------- the drawer */

/** The four lines the material's record shows: who holds each duty, in words. */
export async function dutyFieldsFor(materials: readonly { id: string; materialType: string }[]): Promise<Map<string, { l: string; v: string }[]>> {
  const [rows, names] = await Promise.all([db.select().from(erpMaterialDuties), dutyNames()]);
  const book = dutyBookFrom(rows);
  const out = new Map<string, { l: string; v: string }[]>();
  for (const m of materials) {
    out.set(
      m.id,
      MATERIAL_DUTIES.filter((d) => dutyApplies(d, m.materialType)).map((d) => {
        const h = book.get(m.id)?.[d];
        return { l: DUTY_LABEL[d].label, v: isConfigured(h) ? holderNames(h, names).join(", ") || "—" : `${DUTY_LABEL[d].open} (not set)` };
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------- the form */

/**
 * Who can be named: people who hold the ERP (a duty given to somebody who
 * cannot open it is a button nobody can press), and every designation.
 * People are labelled by name, with the email added only where two share one.
 */
export async function dutyCandidates(): Promise<{ people: { id: string; label: string }[]; departments: { id: string; label: string }[] }> {
  const [ppl, deps] = await Promise.all([
    db
      .selectDistinct({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "erp")))
      .where(eq(users.active, true))
      .orderBy(asc(users.name)),
    db.select({ id: erpDesignations.id, name: erpDesignations.name }).from(erpDesignations).orderBy(asc(erpDesignations.sortOrder), asc(erpDesignations.name)),
  ]);
  const count = new Map<string, number>();
  ppl.forEach((p) => count.set(p.name, (count.get(p.name) ?? 0) + 1));
  return {
    people: ppl.map((p) => ({ id: p.id, label: (count.get(p.name) ?? 0) > 1 ? `${p.name} (${p.email})` : p.name })),
    departments: deps.map((d) => ({ id: d.id, label: d.name })),
  };
}

export async function dutiesOf(materialId: string): Promise<Partial<Record<MaterialDuty, DutyHolders>>> {
  const rows = await db.select().from(erpMaterialDuties).where(eq(erpMaterialDuties.rawMaterialId, materialId));
  return dutyBookFrom(rows).get(materialId) ?? {};
}

/**
 * Replaces every duty of one material with what the form sent. The whole set
 * is written in one transaction, so a half-saved set — a requester with no
 * approver yet because the second half failed — is not a state anybody sees.
 */
export async function replaceMaterialDuties(ctx: ErpContext, materialId: string, next: Partial<Record<MaterialDuty, DutyHolders>>): Promise<void> {
  const [mat] = await db.select({ type: erpRawMaterials.materialType }).from(erpRawMaterials).where(eq(erpRawMaterials.id, materialId));
  const before = await dutiesOf(materialId);
  await db.transaction(async (tx) => {
    await tx.delete(erpMaterialDuties).where(eq(erpMaterialDuties.rawMaterialId, materialId));
    const values = MATERIAL_DUTIES.filter((d) => !mat || dutyApplies(d, mat.type)).flatMap((duty) => [
      ...[...new Set(next[duty]?.userIds ?? [])].map((userId) => ({ id: erpId("mdt"), rawMaterialId: materialId, duty, userId, designationId: null, createdById: ctx.user.id })),
      ...[...new Set(next[duty]?.designationIds ?? [])].map((designationId) => ({ id: erpId("mdt"), rawMaterialId: materialId, duty, userId: null, designationId, createdById: ctx.user.id })),
    ]);
    if (values.length) await tx.insert(erpMaterialDuties).values(values);
  });
  await erpAudit(ctx, "erp.rawMaterial.duties", "erp_raw_material", materialId, before, next);
}
