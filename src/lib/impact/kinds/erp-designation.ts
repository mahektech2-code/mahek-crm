import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { erpUserDesignations, users } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { getModule } from "@/lib/modules";
import { ERP_POWER_LABEL, type ErpPower } from "@/lib/erp/powers";
import { SEAT_LABEL } from "@/lib/erp/departments";
import { getErpDesignation } from "@/lib/services/erp-designation-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * AN ERP DESIGNATION is a job title with access behind it, and deleting one
 * is the act most likely to be misread: the person pressing it fears it takes
 * screens away from everybody who holds it. It does not — each holder's
 * access is stored on them, and they keep it whole — so the report says that
 * first, as something that stays.
 *
 * What DOES move is the one fact a designation carries that is not stored on
 * the person: its production department. Holders of a departmental one stop
 * being narrowed to their team's purchase requirements, which is a real
 * widening and is said as one.
 *
 * Platform administrators only, the same door the delete itself uses.
 * ------------------------------------------------------------------------- */

export const erpDesignationImpact: ImpactSource = {
  authorize: async () => {
    await requirePlatformAdminUser();
  },

  async report(id) {
    const d = await getErpDesignation(id);
    if (!d) return null;
    const holders = await db
      .select({ name: users.name })
      .from(erpUserDesignations)
      .innerJoin(users, eq(users.id, erpUserDesignations.userId))
      .where(eq(erpUserDesignations.designationId, id))
      .orderBy(asc(users.name));
    const names = holders.map((h) => h.name);

    const items: ImpactItem[] = [
      d.allScreens
        ? { app: "Admin Console", label: "rule that it opens every ERP screen", effect: "deleted", count: 1 }
        : {
            app: "Admin Console",
            label: d.modules.length === 1 ? "screen it lists" : "screens it lists",
            effect: "deleted",
            count: d.modules.length,
            examples: d.modules.slice(0, 5).map((k) => getModule(k)?.label ?? k),
          },
      {
        app: "Admin Console",
        label: d.powers.length === 1 ? "power it lists" : "powers it lists",
        effect: "deleted",
        count: d.powers.length,
        examples: d.powers.slice(0, 5).map((p) => ERP_POWER_LABEL[p as ErpPower]?.label ?? p),
      },
      {
        app: "Admin Console",
        label: names.length === 1 ? "person who holds it" : "people who hold it",
        effect: "unlinked",
        count: names.length,
        examples: names.slice(0, 5),
        note: "They stop holding the name, and a later edit to it can no longer move them. It leaves the Access screen's list of designations.",
      },
    ];
    if (names.length) {
      items.push({
        app: "ERP",
        label: names.length === 1 ? "person's ERP screens and powers" : "people's ERP screens and powers",
        effect: "kept",
        count: names.length,
        note: "Kept exactly as they are. Deleting a job title never takes a screen or a power away from anybody.",
      });
    }
    if (d.department && names.length) {
      items.push({
        app: "ERP",
        label: `${names.length === 1 ? "person" : "people"} working as ${SEAT_LABEL[d.department]}`,
        effect: "changed",
        count: names.length,
        examples: names.slice(0, 5),
        note:
          d.department === "head"
            ? "The ERP stops treating them as the Production Head: they see every purchase requirement, not only production's."
            : `The ERP stops narrowing them to ${SEAT_LABEL[d.department]}: they see every team's purchase requirements and may raise one for any of the four.`,
      });
    }

    return { title: d.name, verb: "Delete", confirmWord: d.name, items, blockers: [] };
  },
};
