import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireBlueprints, type HireBlueprint } from "@/db/schema";
import type { BlueprintDefinition } from "../blueprint-types";
import { MASKABLE } from "../blueprint-types";
import { approvalCount, type StudioDefinition } from "../engines/diff";

export { approvalCount, studioIssues, type StudioDefinition } from "../engines/diff";

/* ---------------------------------------------------------------------------
 * The blueprint studio's reads, and the rules that sit on top of the shared
 * validator: approval of the competency model (which the definition records
 * as `competenciesApproved`, beside the per-element `approved` flags), and
 * the "N of M approved" count the studio draws.
 * ------------------------------------------------------------------------- */


export type BlueprintListRow = {
  id: string;
  key: string;
  title: string;
  family: string;
  department: string;
  version: number;
  status: string;
  inFlight: number;
  createdBy: string | null;
  publishedAt: string | null;
  updatedAt: string;
  aiGenerated: boolean;
  approved: number;
  total: number;
  locations: string[];
};

export async function listBlueprints(): Promise<BlueprintListRow[]> {
  const rows = (await db.execute(sql`
    select b.id, b.key, b.title, b.family, b.department, b.version, b.status, b.published_at, b.updated_at, b.ai_generated, b.locations, b.definition,
           u.name as created_by,
           (select count(*)::int from hire_applications a where a.blueprint_id = b.id and a.status in ('in_progress','on_hold')) as in_flight
    from hire_blueprints b left join users u on u.id = b.created_by_id
    order by b.title, b.version desc`)) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const a = approvalCount(r.definition as StudioDefinition);
    return {
      id: String(r.id),
      key: String(r.key),
      title: String(r.title),
      family: String(r.family),
      department: String(r.department),
      version: Number(r.version),
      status: String(r.status),
      inFlight: Number(r.in_flight ?? 0),
      createdBy: (r.created_by as string) ?? null,
      publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : null,
      updatedAt: new Date(r.updated_at as string).toISOString(),
      aiGenerated: Boolean(r.ai_generated),
      approved: a.approved,
      total: a.total,
      locations: (r.locations as string[]) ?? [],
    };
  });
}

export async function getBlueprintRow(id: string): Promise<HireBlueprint | null> {
  const [b] = await db.select().from(hireBlueprints).where(eq(hireBlueprints.id, id)).limit(1);
  return b ?? null;
}

export async function versionsOf(key: string) {
  return db
    .select({ id: hireBlueprints.id, version: hireBlueprints.version, status: hireBlueprints.status })
    .from(hireBlueprints)
    .where(eq(hireBlueprints.key, key))
    .orderBy(desc(hireBlueprints.version));
}

export async function previousVersion(b: HireBlueprint): Promise<HireBlueprint | null> {
  const [p] = await db
    .select()
    .from(hireBlueprints)
    .where(and(eq(hireBlueprints.key, b.key), sql`${hireBlueprints.version} < ${b.version}`))
    .orderBy(desc(hireBlueprints.version))
    .limit(1);
  return p ?? null;
}

export async function inFlightOn(blueprintId: string): Promise<number> {
  const [r] = (await db.execute(sql`select count(*)::int as n from hire_applications a where a.blueprint_id = ${blueprintId} and a.status in ('in_progress','on_hold')`)) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

export async function publishedForCopy() {
  return db
    .select({ id: hireBlueprints.id, key: hireBlueprints.key, title: hireBlueprints.title, family: hireBlueprints.family, version: hireBlueprints.version })
    .from(hireBlueprints)
    .where(eq(hireBlueprints.status, "published"))
    .orderBy(hireBlueprints.title);
}

export type QuestionBankRow = {
  blueprintId: string;
  blueprintTitle: string;
  version: number;
  status: string;
  stage: string;
  key: string;
  text: string;
  competencies: string[];
  mode: string;
  max: number;
  ai: boolean;
  approved: boolean;
  critic: string[];
};

/** Every question in the latest version of every blueprint. */
export async function questionBank(): Promise<QuestionBankRow[]> {
  const rows = (await db.execute(sql`
    select distinct on (b.key) b.id, b.title, b.version, b.status, b.definition, b.critic
    from hire_blueprints b order by b.key, b.version desc`)) as unknown as Record<string, unknown>[];
  const out: QuestionBankRow[] = [];
  for (const r of rows) {
    const def = r.definition as StudioDefinition;
    const critic = (r.critic as { where: string; message: string }[] | null) ?? [];
    const comp = new Map(def.competencies.map((c) => [c.key, c.name]));
    for (const s of def.stages)
      for (const q of s.questions)
        out.push({
          blueprintId: String(r.id),
          blueprintTitle: String(r.title),
          version: Number(r.version),
          status: String(r.status),
          stage: s.name,
          key: `${s.key}.${q.key}`,
          text: q.text,
          competencies: q.competencyKeys.map((k) => comp.get(k) ?? k),
          mode: q.mode,
          max: q.maxPoints,
          ai: q.ai,
          approved: q.approved,
          critic: critic.filter((c) => c.where === `${s.key}.${q.key}`).map((c) => c.message),
        });
  }
  return out.sort((a, b) => a.blueprintTitle.localeCompare(b.blueprintTitle));
}

export type TeamRow = { userId: string; name: string; email: string | null; level: string; role: string | null; active: boolean };

export async function hireTeam(): Promise<TeamRow[]> {
  const rows = (await db.execute(sql`
    select u.id, u.name, u.email, u.active, coalesce(g.role, 'associate') as level, r.role
    from app_access g join users u on u.id = g.user_id left join hire_user_roles r on r.user_id = u.id
    where g.app = 'hire' order by u.name`)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({ userId: String(r.id), name: String(r.name), email: (r.email as string) ?? null, level: String(r.level), role: (r.role as string) ?? null, active: r.active !== false }));
}

/** A starting skeleton: every section present, nothing approved, nothing AI. */
export function blankDefinition(): StudioDefinition {
  const stage = (key: string, name: string, type: BlueprintDefinition["stages"][number]["type"], extra: Partial<BlueprintDefinition["stages"][number]> = {}) => ({
    key,
    name,
    type,
    maxPoints: 0,
    passThreshold: 70,
    autoRejectFloor: null,
    strongSignal: null,
    graceRange: 5,
    slaHours: 48,
    questions: [],
    approved: false,
    ai: false,
    ...extra,
  });
  return {
    competencies: [],
    competenciesApproved: false,
    stages: [
      stage("app", "Application", "application", { slaHours: 24 }),
      stage("int", "Interview", "scored_interview", { slaHours: 72 }),
      stage("gate", "Decision gate", "decision_gate", { slaHours: 24, gateRole: "Hiring Manager" }),
      stage("doc", "Documents & offer", "document_collection", { slaHours: 120 }),
      stage("kit", "Induction", "checklist", { slaHours: 72 }),
      stage("setup", "System setup", "system_setup", { slaHours: 24 }),
    ],
    documents: [],
    offer: { currency: "INR", grades: [], incentive: "", growth: [], approved: false, ai: false },
    onboarding: { assets: [], modules: [], setup: [], approved: false, ai: false },
    provisioning: { apps: ["hrms"], level: "associate", roleLabel: "", device: false, approved: false, ai: false },
    fairness: {
      masked: [...MASKABLE],
      unmaskedJustification: {},
      monitor: { gender: true, age: true, location: true },
      adverseImpactThreshold: 0.8,
      redactBeforeTransmission: true,
      approved: false,
      ai: false,
    },
    coolingOff: [{ reasonCode: "below_pass", days: 90 }],
    openQuestions: [],
  };
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "role"
  );
}

export async function freeKey(title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set((await db.select({ key: hireBlueprints.key }).from(hireBlueprints).where(sql`${hireBlueprints.key} like ${base + "%"}`)).map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
