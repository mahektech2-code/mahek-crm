import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, hireBlueprints, hireUserRoles } from "@/db/schema";
import { hireTrail } from "./services/core";
import { grantAppWithDefaultModules, rederiveAccountLevel } from "@/lib/services/app-provisioning";
import type { BlueprintDefinition } from "./blueprint-types";
import { SALES_EXECUTIVE, SEED_BLUEPRINTS } from "./seed/blueprints";

/* ---------------------------------------------------------------------------
 * INSTALLING HIRE — nothing for anybody to remember.
 *
 * `installHire` puts in what a deployment needs before anybody can use the
 * app: the seeded role blueprints, and Hire itself for every platform
 * administrator, as Admin, so somebody can open it and hand out the rest from
 * its own Team screen. It is idempotent and runs on every deploy
 * (`npm run deploy:db` → `hire:deploy`). The layout also seeds the blueprints
 * the first time Hire is opened on a database that has none, so a deployment
 * that skipped the step still works rather than showing an empty studio.
 *
 * It never touches a blueprint that exists and never changes a grant that
 * exists: an administrator who was given Hire at another level, or removed
 * from it on the Team screen, keeps that decision only if they still hold the
 * app — a platform administrator with NO Hire grant is granted again, because
 * they are the people who can always grant it to themselves anyway.
 * ------------------------------------------------------------------------- */

/** Sales Executive v2 — the AppSheet app as it was, defects and all, so the diff has something real to show. */
function salesExecutiveV2(): BlueprintDefinition {
  const v2 = structuredClone(SALES_EXECUTIVE);
  for (const st of v2.stages) {
    if (st.key === "l1") {
      const q4 = st.questions.find((q) => q.key === "q4")!;
      if (q4.calc?.kind === "bands") {
        q4.calc.bands = q4.calc.bands.filter((b) => b.min != null);
        q4.calc.uncovered = null;
      }
      q4.note = "Salary below ₹15,000 has no score (D7).";
    }
    if (st.key === "l2") {
      const q7 = st.questions.find((q) => q.key === "q7")!;
      q7.options = q7.options!.map((o) => (o.key === "c" ? { ...o, points: null } : o));
      q7.note = "“Ask the team for help” scores nothing (D7).";
      for (const q of st.questions.filter((x) => x.mode === "ai_rubric")) q.mode = "fixed_choice";
    }
    if (st.key === "l3") {
      const q6 = st.questions.find((q) => q.key === "q6")!;
      if (q6.calc?.kind === "bands") q6.calc.bands = [{ min: null, max: 90, points: 0 }, { min: 90, max: null, points: 10 }];
      q6.note = "60–90% scores zero while above 90% scores 10 (D7).";
      const q8 = st.questions.find((q) => q.key === "q8")!;
      if (q8.calc?.kind === "formula") q8.calc.cap = null;
      for (const q of st.questions.filter((x) => x.mode === "ai_rubric")) q.mode = "fixed_choice";
    }
    if (st.key === "brf") st.briefing = st.briefing!.map((p) => ({ ...p, blocking: false }));
  }
  v2.stages = v2.stages.filter((s) => s.key !== "scr" && s.key !== "gate");
  v2.offer.growth = [
    { fromGrade: "S1", toGrade: "S2", criterion: "Cumulative sales of ₹10,00,000", incrementType: "fixed_amount", value: 200000 },
    { fromGrade: "S2", toGrade: "S3", criterion: "Cumulative sales of ₹25,00,000", incrementType: "fixed_amount", value: 250000 },
  ];
  v2.openQuestions = ["Level 2 passes at 70 for status but the result message fires from 63 (D4)."];
  return v2;
}

export async function seedHireBlueprints(actorId: string | null = null): Promise<{ created: string[] }> {
  const created: string[] = [];
  const rows = [
    ...SEED_BLUEPRINTS.map((b) => ({ ...b })),
    { ...SEED_BLUEPRINTS[0], version: 2, status: "retired" as const, definition: salesExecutiveV2(), source: "The AppSheet app as imported, before the D4/D7/D8/D11/D12 fixes." },
  ];
  for (const b of rows) {
    const [have] = await db.select({ id: hireBlueprints.id }).from(hireBlueprints).where(and(eq(hireBlueprints.key, b.key), eq(hireBlueprints.version, b.version))).limit(1);
    if (have) continue;
    const at = b.status === "draft" ? null : new Date(Date.now() - (b.version === 2 ? 120 : b.key === "sales-executive" ? 50 : 20) * 86_400_000);
    await db.insert(hireBlueprints).values({
      id: `hbp_${b.key}_v${b.version}`,
      key: b.key,
      version: b.version,
      status: b.status,
      title: b.title,
      family: b.family,
      department: b.department,
      level: b.level,
      employmentType: b.employmentType,
      locations: b.locations,
      headcount: b.headcount,
      descriptionSource: b.source,
      aiGenerated: b.ai,
      generationPromptVersion: b.ai ? "blueprint/v1" : null,
      parentId: b.version > 1 ? `hbp_${b.key}_v${b.version - 1}` : null,
      definition: b.definition,
      publishedAt: at,
      publishedById: b.status === "draft" ? null : actorId,
      retiredAt: b.status === "retired" ? new Date(Date.now() - 50 * 86_400_000) : null,
      createdById: actorId,
    });
    created.push(`${b.title} v${b.version}`);
  }
  return { created };
}

/** Hire for every active platform administrator who lacks it, as Admin. */
export async function grantHireToPlatformAdmins(): Promise<{ granted: string[] }> {
  const rows = (await db.execute(sql`
    select u.id, u.name from users u
    where u.active and exists (select 1 from app_access g where g.user_id = u.id and g.app = 'admin' and g.role = 'admin')
      and not exists (select 1 from app_access h where h.user_id = u.id and h.app = 'hire')`)) as unknown as { id: string; name: string }[];
  for (const u of rows) {
    await db.transaction(async (tx) => {
      await grantAppWithDefaultModules(tx, { userId: u.id, app: "hire", grantedById: null, level: "admin" });
      await tx.insert(hireUserRoles).values({ userId: u.id, role: "admin" }).onConflictDoNothing();
      const accountLevel = await rederiveAccountLevel(tx, u.id);
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: null,
        action: "set-app-access",
        entityType: "user",
        entityId: u.id,
        afterState: { detail: "granted hire (1/1 modules) · admin · hire (1/1)", reason: "Installing Hire: every platform administrator holds it", accountLevel } as never,
      });
      await hireTrail(null, { entityType: "hire_role", entityId: u.id, event: "installed", summary: `${u.name} given Hire as Admin — a platform administrator` }, tx);
    });
  }
  return { granted: rows.map((r) => r.name) };
}

export async function installHire(): Promise<{ blueprints: string[]; admins: string[] }> {
  const [{ created }, { granted }] = [await seedHireBlueprints(null), await grantHireToPlatformAdmins()];
  return { blueprints: created, admins: granted };
}

let blueprintsChecked = false;

/** Called by the layout: on a database with no blueprints at all, put the seeded ones in. Once per process. */
export async function ensureHireBlueprints(): Promise<void> {
  if (blueprintsChecked) return;
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from hire_blueprints`)) as unknown as { n: number }[];
  if (Number(n) === 0) await seedHireBlueprints(null);
  blueprintsChecked = true;
}


