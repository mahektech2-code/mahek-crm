import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, hireBlueprints, hireDocTemplates, hireIncentivePlans, hireUserRoles, trainingModuleVersions, trainingModules, trainingTrackVersions, trainingTracks } from "@/db/schema";
import { hireTrail } from "./services/core";
import { grantAppWithDefaultModules, rederiveAccountLevel } from "@/lib/services/app-provisioning";
import type { BlueprintDefinition } from "./blueprint-types";
import { SALES_EXECUTIVE, SEED_BLUEPRINTS, type SeedBlueprint } from "./seed/blueprints";
import { ACCOUNTS_EXECUTIVE_V3, SALES_EXECUTIVE_V4, SEED_INCENTIVE_PLANS, SEED_MODULES, SEED_TEMPLATES, SEED_TRACKS, TELECALLER_V2 } from "./seed/onboarding";

/* ---------------------------------------------------------------------------
 * INSTALLING HIRE — nothing for anybody to remember.
 *
 * `installHire` puts in what a deployment needs before anybody can use the
 * app: the seeded role blueprints, and Hire itself for every platform
 * administrator, as Admin, so somebody can open it; everybody else is given
 * it, with their Hire role, on the Admin Console's People → Access screen. It is idempotent and runs on every deploy
 * (`npm run deploy:db` → `hire:deploy`). The layout also seeds the blueprints
 * the first time Hire is opened on a database that has none, so a deployment
 * that skipped the step still works rather than showing an empty studio.
 *
 * It never touches a blueprint that exists and never changes a grant that
 * exists: an administrator who was given Hire at another level, or removed
 * from it on the Access screen, keeps that decision only if they still hold the
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

/**
 * The Onboarding & Training PRD's versions of the three roles. A DRAFT on a
 * real deployment: HR fills the bracketed material, publishes the plan,
 * templates, modules and track, and then publishes these from the studio —
 * the validator refuses one that names something unpublished. The demo seed
 * publishes them (`publishOnboardingVersions`).
 */
export function onboardingSeedBlueprints(): SeedBlueprint[] {
  const by = (k: string) => SEED_BLUEPRINTS.find((b) => b.key === k)!;
  return [
    { ...by("sales-executive"), version: 4, status: "draft", definition: SALES_EXECUTIVE_V4, source: "The Onboarding & Training PRD: compensation, documents and verification, employment documents, provision, assets, training." },
    // role-name-ok: "telecaller" here is a blueprint's key, not the retired account role
    { ...by("telecaller"), version: 2, status: "draft", definition: TELECALLER_V2, source: "The Onboarding & Training PRD flow, no incentive." },
    { ...by("accounts-executive"), version: 3, status: "draft", definition: ACCOUNTS_EXECUTIVE_V3, source: "The Onboarding & Training PRD flow — incentive not applicable." },
  ];
}

export async function seedHireBlueprints(actorId: string | null = null): Promise<{ created: string[] }> {
  const created: string[] = [];
  const rows = [
    ...SEED_BLUEPRINTS.map((b) => ({ ...b })),
    { ...SEED_BLUEPRINTS[0], version: 2, status: "retired" as const, definition: salesExecutiveV2(), source: "The AppSheet app as imported, before the D4/D7/D8/D11/D12 fixes." },
    ...onboardingSeedBlueprints(),
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

/**
 * Hire for every active platform administrator who lacks it, as Admin —
 * ONCE per person. This runs on every deploy, and it used to hand Hire back
 * to anybody who lacked it, so a platform admin whose Hire was taken away on
 * the console had it again after the next release. The `installed` line it
 * writes on Hire's own trail is the memory: somebody who was given it here
 * before is not given it again.
 */
export async function grantHireToPlatformAdmins(): Promise<{ granted: string[] }> {
  const rows = (await db.execute(sql`
    select u.id, u.name from users u
    where u.active and exists (select 1 from app_access g where g.user_id = u.id and g.app = 'admin' and g.role = 'admin')
      and not exists (select 1 from app_access h where h.user_id = u.id and h.app = 'hire')
      and not exists (select 1 from hire_audit t where t.entity_type = 'hire_role' and t.entity_id = u.id and t.event_type = 'installed')`)) as unknown as { id: string; name: string }[];
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

/**
 * The incentive plan, document templates, training modules and tracks the
 * PRD's flow names — inserted where missing, never changed where present.
 * `publish` (the demo) publishes them with their questions approved; on a real
 * deployment they arrive as drafts with every question UNAPPROVED, because
 * the material is the business's to write and a person's to approve.
 */
export async function seedOnboardingContent(actorId: string | null, publish: boolean): Promise<{ created: string[] }> {
  const created: string[] = [];
  const status = publish ? ("published" as const) : ("draft" as const);
  const at = publish ? new Date() : null;
  for (const p of SEED_INCENTIVE_PLANS) {
    const [have] = await db.select({ id: hireIncentivePlans.id }).from(hireIncentivePlans).where(eq(hireIncentivePlans.key, p.key)).limit(1);
    if (have) continue;
    await db.insert(hireIncentivePlans).values({ id: `hip_${p.key}_v1`, key: p.key, version: 1, title: p.title, status, designations: p.designations, basis: p.basis, mode: p.mode, slabs: p.slabs, conditions: p.conditions, publishedAt: at, publishedById: publish ? actorId : null, createdById: actorId });
    created.push(`incentive plan ${p.title}`);
  }
  for (const t of SEED_TEMPLATES) {
    const [have] = await db.select({ id: hireDocTemplates.id }).from(hireDocTemplates).where(eq(hireDocTemplates.key, t.key)).limit(1);
    if (have) continue;
    await db.insert(hireDocTemplates).values({ id: `htp_${t.key}_v1`, key: t.key, version: 1, title: t.title, body: t.body, status, publishedAt: at, publishedById: publish ? actorId : null, createdById: actorId });
    created.push(`template ${t.title}`);
  }
  for (const m of SEED_MODULES) {
    const [have] = await db.select({ id: trainingModules.id }).from(trainingModules).where(eq(trainingModules.key, m.key)).limit(1);
    if (have) continue;
    const id = `tmo_${m.key}`;
    const definition = { ...m.definition, questions: m.definition.questions.map((q) => ({ ...q, approved: publish })) };
    await db.insert(trainingModules).values({ id, key: m.key, title: m.title, category: m.category, createdById: actorId });
    await db.insert(trainingModuleVersions).values({ id: `tmv_${m.key}_v1`, moduleId: id, version: 1, status, definition, publishedAt: at, publishedById: publish ? actorId : null, createdById: actorId });
    created.push(`module ${m.title}`);
  }
  for (const t of SEED_TRACKS) {
    const [have] = await db.select({ id: trainingTracks.id }).from(trainingTracks).where(eq(trainingTracks.key, t.key)).limit(1);
    if (have) continue;
    const id = `ttr_${t.key}`;
    await db.insert(trainingTracks).values({ id, key: t.key, title: t.title, createdById: actorId });
    await db.insert(trainingTrackVersions).values({ id: `ttv_${t.key}_v1`, trackId: id, version: 1, status, definition: t.definition, publishedAt: at, publishedById: publish ? actorId : null, createdById: actorId });
    created.push(`track ${t.title}`);
  }
  return { created };
}

/** The demo: publish the PRD versions, retiring what they replace. */
export async function publishOnboardingVersions(actorId: string | null): Promise<void> {
  for (const b of onboardingSeedBlueprints()) {
    const id = `hbp_${b.key}_v${b.version}`;
    await db.update(hireBlueprints).set({ status: "retired", retiredAt: new Date() }).where(and(eq(hireBlueprints.key, b.key), eq(hireBlueprints.status, "published"), sql`${hireBlueprints.id} <> ${id}`));
    await db.update(hireBlueprints).set({ status: "published", publishedAt: new Date(), publishedById: actorId }).where(eq(hireBlueprints.id, id));
  }
}

export async function installHire(): Promise<{ blueprints: string[]; admins: string[]; content: string[] }> {
  const [{ created }, { granted }, content] = [await seedHireBlueprints(null), await grantHireToPlatformAdmins(), await seedOnboardingContent(null, false)];
  return { blueprints: created, admins: granted, content: content.created };
}

let blueprintsChecked = false;

/** Called by the layout: on a database with no blueprints at all, put the seeded ones in. Once per process. */
export async function ensureHireBlueprints(): Promise<void> {
  if (blueprintsChecked) return;
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from hire_blueprints`)) as unknown as { n: number }[];
  if (Number(n) === 0) await seedHireBlueprints(null);
  blueprintsChecked = true;
}


