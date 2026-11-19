import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireBlueprints } from "@/db/schema";
import { HireNotPermitted, requireHireCap } from "@/lib/hire/access";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * DELETING A DRAFT BLUEPRINT, said before it happens. Only a draft that was
 * never published goes: nobody entered under it, so nobody was scored against
 * it. What a person might fear goes with it — the published version it was
 * drafted from, the candidates on that version — stays, and is said to.
 * ------------------------------------------------------------------------- */

export const hireBlueprintDraftImpact: ImpactSource = {
  authorize: async () => {
    const ctx = await requireHireCap();
    if (!ctx.can("editBp") && !ctx.can("proposeBp")) throw new HireNotPermitted("Editing a blueprint needs a Hiring Manager, HR Head or Admin.");
  },

  async report(id) {
    const [b] = await db.select().from(hireBlueprints).where(eq(hireBlueprints.id, id)).limit(1);
    if (!b) return null;
    const [applied, others] = await Promise.all([
      db.select({ id: hireApplications.id }).from(hireApplications).where(eq(hireApplications.blueprintId, id)),
      db
        .select({ version: hireBlueprints.version, status: hireBlueprints.status })
        .from(hireBlueprints)
        .where(and(eq(hireBlueprints.key, b.key), ne(hireBlueprints.id, id))),
    ]);
    const blockers: string[] = [];
    if (b.status !== "draft" || b.publishedAt) blockers.push(`v${b.version} has been published. A published or retired version is kept for the candidates scored under it; edit it as a new version instead.`);
    if (applied.length) blockers.push(`${applied.length} ${many(applied.length, "application")} entered under this version, so it is kept.`);
    const items: ImpactItem[] = [
      {
        app: "Hire",
        label: `unpublished draft, with its stages, questions, rubrics and critic findings`,
        effect: "deleted",
        count: 1,
        note: "Hire's trail keeps a line saying it was deleted, and by whom.",
      },
      {
        app: "Hire",
        label: `other ${many(others.length, "version")} of ${b.title}`,
        effect: "kept",
        count: others.length,
        examples: others.map((o) => `v${o.version} · ${o.status}`),
        note: "Untouched, and so is every candidate on them.",
      },
    ];
    return {
      title: `${b.title} v${b.version} (draft)`,
      verb: "Delete draft",
      confirmWord: b.title.length <= 40 ? b.title : "DELETE",
      items: present(items),
      blockers,
    };
  },
};
