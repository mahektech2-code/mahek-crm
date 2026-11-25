import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  products,
  trainingAttemptCorrections,
  trainingAttempts,
  trainingEnrollments,
  trainingEvents,
  trainingModuleVersions,
  trainingModules,
  trainingTrackVersions,
  trainingTracks,
  users,
  type TrainingAnswer,
  type TrainingAttempt,
  type TrainingEnrollment,
  type TrainingModuleVersion,
} from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { notifyUsers } from "@/lib/notify";
import { canStartAttempt, drawAttempt, moduleProblems, moduleStates, progress, score, seedFrom, trackProblems, type AttemptLite, type EventLite, type ModuleProgress } from "./engine";
import { emptyModule, TRAINING_CATEGORIES, type ModuleDefinition, type TrackDefinition, type TrainingCategory } from "./types";

/* ---------------------------------------------------------------------------
 * TRAINING — reads and writes. The rules are `engine.ts`; this file fetches,
 * checks who is asking, and writes.
 *
 *  - a learner reads and writes ONLY their own enrolment (the user id is the
 *    session's, never a parameter they choose);
 *  - correct answers never leave the server — a question is served without
 *    its key, and the answer is marked here;
 *  - the deadline is the server's; an attempt past it is closed on what was
 *    answered the next time anything reads it;
 *  - nothing here deletes: a fail, a retake and a correction are all rows.
 * ------------------------------------------------------------------------- */

const tid = (p: string) => `${p}_${randomUUID()}`;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/** Somebody acting — the learner, a trainer, an author. */
export type Actor = { id: string; name: string };

/* ================================================================ modules */

export type ModuleRow = { id: string; key: string; title: string; category: string; active: boolean; published: TrainingModuleVersion | null; draft: TrainingModuleVersion | null; versions: number; learners: number };

export async function listModules(): Promise<ModuleRow[]> {
  const mods = await db.select().from(trainingModules).orderBy(asc(trainingModules.title));
  if (!mods.length) return [];
  const vs = await db.select().from(trainingModuleVersions).where(inArray(trainingModuleVersions.moduleId, mods.map((m) => m.id))).orderBy(desc(trainingModuleVersions.version));
  const learners = (await db.execute(sql`
    select a.module_key, count(distinct a.enrollment_id)::int as n from training_attempts a group by a.module_key`)) as unknown as { module_key: string; n: number }[];
  return mods.map((m) => {
    const mine = vs.filter((v) => v.moduleId === m.id);
    return {
      id: m.id,
      key: m.key,
      title: m.title,
      category: m.category,
      active: m.active,
      published: mine.find((v) => v.status === "published") ?? null,
      draft: mine.find((v) => v.status === "draft") ?? null,
      versions: mine.length,
      learners: learners.find((l) => l.module_key === m.key)?.n ?? 0,
    };
  });
}

export async function moduleDetail(id: string) {
  const [m] = await db.select().from(trainingModules).where(eq(trainingModules.id, id)).limit(1);
  if (!m) return null;
  const versions = await db.select().from(trainingModuleVersions).where(eq(trainingModuleVersions.moduleId, id)).orderBy(desc(trainingModuleVersions.version));
  const names = [...new Set(versions.map((v) => v.publishedById ?? v.createdById).filter((x): x is string => Boolean(x)))];
  const people = names.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, names)) : [];
  const tracks = (await db.execute(sql`
    select t.title from training_track_versions v join training_tracks t on t.id = v.track_id
     where v.status = 'published' and exists (select 1 from jsonb_array_elements(v.definition->'items') i where i->>'moduleKey' = ${m.key})`)) as unknown as { title: string }[];
  return { module: m, versions, people: Object.fromEntries(people.map((p) => [p.id, p.name])), tracks: tracks.map((t) => t.title) };
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

export async function createModule(actor: Actor, input: { key: string; title: string; category: string }): Promise<Result<{ id: string }>> {
  const key = input.key.trim().toLowerCase();
  if (!KEY_RE.test(key)) return { ok: false, error: "A key is lower-case letters, digits and dashes — “product-nano”.", code: "validation", fieldErrors: [{ field: "key", message: "Letters, digits, dashes" }] };
  if (!input.title.trim()) return { ok: false, error: "Give the module a title.", code: "validation", fieldErrors: [{ field: "title", message: "Required" }] };
  if (!(TRAINING_CATEGORIES as readonly string[]).includes(input.category)) return err("Pick a category.", "validation");
  const [dup] = await db.select({ id: trainingModules.id }).from(trainingModules).where(eq(trainingModules.key, key)).limit(1);
  if (dup) return err(`A module with the key “${key}” already exists.`, "duplicate");
  const id = tid("tmo");
  await db.transaction(async (tx) => {
    await tx.insert(trainingModules).values({ id, key, title: input.title.trim(), category: input.category as TrainingCategory, createdById: actor.id });
    await tx.insert(trainingModuleVersions).values({ id: tid("tmv"), moduleId: id, version: 1, status: "draft", definition: emptyModule(), createdById: actor.id });
  });
  return ok({ id }, "Module created as a draft.");
}

/** The draft to edit: the existing one, or a new version copied from the published one. */
async function draftFor(moduleId: string, actorId: string, x: Exec = db): Promise<TrainingModuleVersion | null> {
  const vs = await x.select().from(trainingModuleVersions).where(eq(trainingModuleVersions.moduleId, moduleId)).orderBy(desc(trainingModuleVersions.version));
  const draft = vs.find((v) => v.status === "draft");
  if (draft) return draft;
  const base = vs.find((v) => v.status === "published") ?? vs[0];
  if (!base && !vs.length) return null;
  const [row] = await x.insert(trainingModuleVersions).values({ id: tid("tmv"), moduleId, version: (vs[0]?.version ?? 0) + 1, status: "draft", definition: base?.definition ?? emptyModule(), createdById: actorId }).returning();
  return row;
}

export function cleanModule(d: ModuleDefinition): ModuleDefinition {
  const int = (n: unknown, lo: number, hi: number, dflt: number | null) => {
    const v = Math.round(Number(n));
    return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
  };
  return {
    content: (d.content ?? []).slice(0, 60),
    questions: (d.questions ?? []).slice(0, 300).map((q) => ({ ...q, text: q.text.trim(), tags: [...new Set((q.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8), options: q.options.map((o) => ({ key: o.key, text: o.text.trim() })).filter((o) => o.text) })),
    passMarkPercent: int(d.passMarkPercent, 1, 100, 80)!,
    questionsPerAttempt: d.questionsPerAttempt == null ? null : int(d.questionsPerAttempt, 1, 200, null),
    timerMinutes: d.timerMinutes == null ? null : int(d.timerMinutes, 1, 240, null),
    shuffleQuestions: Boolean(d.shuffleQuestions),
    shuffleOptions: Boolean(d.shuffleOptions),
    feedback: (["none", "after_each", "after_submit"] as const).includes(d.feedback) ? d.feedback : "after_submit",
    minStudyMinutes: int(d.minStudyMinutes, 0, 240, 0)!,
  };
}

export async function saveModuleDraft(actor: Actor, moduleId: string, input: { title?: string; category?: string; definition: ModuleDefinition }): Promise<Result<{ versionId: string; version: number }>> {
  const [m] = await db.select().from(trainingModules).where(eq(trainingModules.id, moduleId)).limit(1);
  if (!m) return err("That module does not exist.", "not_found");
  const def = cleanModule(input.definition);
  return db.transaction(async (tx) => {
    const d = await draftFor(moduleId, actor.id, tx);
    if (!d) return err("That module has no version to edit.", "not_found");
    await tx.update(trainingModuleVersions).set({ definition: def, updatedAt: new Date(), updatedById: actor.id }).where(and(eq(trainingModuleVersions.id, d.id), eq(trainingModuleVersions.status, "draft")));
    const patch: Partial<typeof trainingModules.$inferInsert> = {};
    if (input.title?.trim()) patch.title = input.title.trim();
    if (input.category && (TRAINING_CATEGORIES as readonly string[]).includes(input.category)) patch.category = input.category;
    if (Object.keys(patch).length) await tx.update(trainingModules).set({ ...patch, updatedAt: new Date(), updatedById: actor.id }).where(eq(trainingModules.id, moduleId));
    return ok({ versionId: d.id, version: d.version }, `Draft v${d.version} saved.`);
  });
}

export async function publishModule(actor: Actor, moduleId: string): Promise<Result<{ version: number }>> {
  const [d] = await db.select().from(trainingModuleVersions).where(and(eq(trainingModuleVersions.moduleId, moduleId), eq(trainingModuleVersions.status, "draft"))).limit(1);
  if (!d) return err("There is no draft to publish.", "rule_violation");
  const problems = moduleProblems(d.definition);
  if (problems.length) return { ok: false, error: problems[0], code: "rule_violation", detail: problems };
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(trainingModuleVersions).set({ status: "retired", updatedAt: now }).where(and(eq(trainingModuleVersions.moduleId, moduleId), eq(trainingModuleVersions.status, "published")));
    await tx.update(trainingModuleVersions).set({ status: "published", publishedAt: now, publishedById: actor.id, updatedAt: now }).where(eq(trainingModuleVersions.id, d.id));
  });
  return ok({ version: d.version }, `v${d.version} is published. New attempts use it; anybody who passed an earlier version keeps the pass.`);
}

/** Only a draft never published is deleted; a published version is history. */
export async function discardModuleDraft(moduleId: string): Promise<Result> {
  const [d] = await db.select().from(trainingModuleVersions).where(and(eq(trainingModuleVersions.moduleId, moduleId), eq(trainingModuleVersions.status, "draft"))).limit(1);
  if (!d) return err("There is no draft.", "rule_violation");
  const [used] = await db.select({ id: trainingAttempts.id }).from(trainingAttempts).where(eq(trainingAttempts.moduleVersionId, d.id)).limit(1);
  if (used) return err("Somebody has been tested on this version, so it stays.", "rule_violation");
  const [other] = await db.select({ id: trainingModuleVersions.id }).from(trainingModuleVersions).where(and(eq(trainingModuleVersions.moduleId, moduleId), sql`${trainingModuleVersions.id} <> ${d.id}`)).limit(1);
  if (!other) return err("A module’s only version cannot be discarded — deactivate the module instead.", "rule_violation");
  await db.delete(trainingModuleVersions).where(eq(trainingModuleVersions.id, d.id));
  return ok(undefined, "Draft discarded.");
}

/** Every question across modules, for the bank — from each module's draft if it has one, else its published version. */
export async function questionBank() {
  const mods = await listModules();
  return mods.flatMap((m) => {
    const v = m.draft ?? m.published;
    if (!v) return [];
    return v.definition.questions.map((q) => ({ moduleId: m.id, moduleKey: m.key, moduleTitle: m.title, version: v.version, editingDraft: Boolean(m.draft), question: q }));
  });
}

/** How often each question is answered right, across every submitted attempt. */
export async function questionRates(): Promise<Record<string, { right: number; total: number }>> {
  const rows = (await db.execute(sql`
    select a.module_key || ':' || (x->>'questionKey') as k,
           count(*) filter (where (x->>'correct')::boolean)::int as right,
           count(*)::int as total
      from training_attempts a, jsonb_array_elements(a.answers) x
     where a.submitted_at is not null
     group by 1`)) as unknown as { k: string; right: number; total: number }[];
  return Object.fromEntries(rows.map((r) => [r.k, { right: r.right, total: r.total }]));
}

/* ================================================================= tracks */

export async function listTracks() {
  const ts = await db.select().from(trainingTracks).orderBy(asc(trainingTracks.title));
  if (!ts.length) return [];
  const vs = await db.select().from(trainingTrackVersions).where(inArray(trainingTrackVersions.trackId, ts.map((t) => t.id))).orderBy(desc(trainingTrackVersions.version));
  const enrolled = (await db.execute(sql`
    select v.track_id, count(*)::int as n from training_enrollments e join training_track_versions v on v.id = e.track_version_id
     where e.status = 'active' group by v.track_id`)) as unknown as { track_id: string; n: number }[];
  return ts.map((t) => {
    const mine = vs.filter((v) => v.trackId === t.id);
    return { ...t, published: mine.find((v) => v.status === "published") ?? null, draft: mine.find((v) => v.status === "draft") ?? null, enrolled: enrolled.find((e) => e.track_id === t.id)?.n ?? 0 };
  });
}

export async function publishedTrackKeys(): Promise<Set<string>> {
  const rows = await db.select({ key: trainingTracks.key }).from(trainingTracks).innerJoin(trainingTrackVersions, eq(trainingTrackVersions.trackId, trainingTracks.id)).where(eq(trainingTrackVersions.status, "published"));
  return new Set(rows.map((r) => r.key));
}

async function publishedModuleKeys(x: Exec = db): Promise<Set<string>> {
  const rows = await x.select({ key: trainingModules.key }).from(trainingModules).innerJoin(trainingModuleVersions, eq(trainingModuleVersions.moduleId, trainingModules.id)).where(and(eq(trainingModuleVersions.status, "published"), eq(trainingModules.active, true)));
  return new Set(rows.map((r) => r.key));
}

export async function createTrack(actor: Actor, input: { key: string; title: string }): Promise<Result<{ id: string }>> {
  const key = input.key.trim().toLowerCase();
  if (!KEY_RE.test(key)) return { ok: false, error: "A key is lower-case letters, digits and dashes.", code: "validation", fieldErrors: [{ field: "key", message: "Letters, digits, dashes" }] };
  if (!input.title.trim()) return { ok: false, error: "Give the track a title.", code: "validation", fieldErrors: [{ field: "title", message: "Required" }] };
  const [dup] = await db.select({ id: trainingTracks.id }).from(trainingTracks).where(eq(trainingTracks.key, key)).limit(1);
  if (dup) return err(`A track with the key “${key}” already exists.`, "duplicate");
  const id = tid("ttr");
  await db.transaction(async (tx) => {
    await tx.insert(trainingTracks).values({ id, key, title: input.title.trim(), createdById: actor.id });
    await tx.insert(trainingTrackVersions).values({ id: tid("ttv"), trackId: id, version: 1, status: "draft", definition: { designations: [], sequential: true, completeWithinDays: 30, items: [] }, createdById: actor.id });
  });
  return ok({ id }, "Track created as a draft.");
}

export async function saveTrackDraft(actor: Actor, trackId: string, input: { title?: string; definition: TrackDefinition }): Promise<Result<{ version: number }>> {
  const def: TrackDefinition = {
    designations: [...new Set((input.definition.designations ?? []).map((d) => d.trim()).filter(Boolean))].slice(0, 20),
    sequential: Boolean(input.definition.sequential),
    completeWithinDays: input.definition.completeWithinDays == null ? null : Math.max(1, Math.min(365, Math.round(Number(input.definition.completeWithinDays)) || 30)),
    items: (input.definition.items ?? []).slice(0, 80).map((i) => ({ moduleKey: i.moduleKey, required: Boolean(i.required), after: i.after == null ? null : [...new Set(i.after)] })),
  };
  return db.transaction(async (tx) => {
    const vs = await tx.select().from(trainingTrackVersions).where(eq(trainingTrackVersions.trackId, trackId)).orderBy(desc(trainingTrackVersions.version));
    if (!vs.length) return err("That track does not exist.", "not_found");
    let d = vs.find((v) => v.status === "draft");
    if (!d) [d] = await tx.insert(trainingTrackVersions).values({ id: tid("ttv"), trackId, version: vs[0].version + 1, status: "draft", definition: def, createdById: actor.id }).returning();
    else await tx.update(trainingTrackVersions).set({ definition: def, updatedAt: new Date(), updatedById: actor.id }).where(eq(trainingTrackVersions.id, d.id));
    if (input.title?.trim()) await tx.update(trainingTracks).set({ title: input.title.trim(), updatedAt: new Date() }).where(eq(trainingTracks.id, trackId));
    return ok({ version: d.version }, `Draft v${d.version} saved.`);
  });
}

export async function publishTrack(actor: Actor, trackId: string): Promise<Result<{ version: number }>> {
  const [d] = await db.select().from(trainingTrackVersions).where(and(eq(trainingTrackVersions.trackId, trackId), eq(trainingTrackVersions.status, "draft"))).limit(1);
  if (!d) return err("There is no draft to publish.", "rule_violation");
  const problems = trackProblems(d.definition, await publishedModuleKeys());
  if (problems.length) return { ok: false, error: problems[0], code: "rule_violation", detail: problems };
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(trainingTrackVersions).set({ status: "retired", updatedAt: now }).where(and(eq(trainingTrackVersions.trackId, trackId), eq(trainingTrackVersions.status, "published")));
    await tx.update(trainingTrackVersions).set({ status: "published", publishedAt: now, publishedById: actor.id, updatedAt: now }).where(eq(trainingTrackVersions.id, d.id));
  });
  return ok({ version: d.version }, `v${d.version} is published. People already enrolled stay on the version they started.`);
}

/* ============================================================= enrolment */

/** Enrol somebody on a track's published version. Idempotent per application. */
export async function enroll(x: Exec, input: { userId: string; trackKey: string; applicationId?: string | null; trainerId?: string | null; assignedById: string | null; todayYmd: string }): Promise<Result<{ enrollmentId: string }>> {
  const [tv] = await x
    .select({ id: trainingTrackVersions.id, def: trainingTrackVersions.definition })
    .from(trainingTrackVersions)
    .innerJoin(trainingTracks, eq(trainingTracks.id, trainingTrackVersions.trackId))
    .where(and(eq(trainingTracks.key, input.trackKey), eq(trainingTrackVersions.status, "published")))
    .limit(1);
  if (!tv) return err(`The track “${input.trackKey}” has no published version.`, "rule_violation");
  const existing = await x.select({ id: trainingEnrollments.id }).from(trainingEnrollments).where(and(eq(trainingEnrollments.userId, input.userId), eq(trainingEnrollments.trackVersionId, tv.id), eq(trainingEnrollments.status, "active"))).limit(1);
  if (existing[0]) return ok({ enrollmentId: existing[0].id }, "Already enrolled.");
  const days = tv.def.completeWithinDays;
  const due = days ? new Date(Date.parse(`${input.todayYmd}T12:00:00+05:30`) + days * 86_400_000).toISOString().slice(0, 10) : null;
  const id = tid("ten");
  await x.insert(trainingEnrollments).values({ id, userId: input.userId, applicationId: input.applicationId ?? null, trackVersionId: tv.id, trainerId: input.trainerId ?? null, assignedById: input.assignedById, dueOn: due });
  return ok({ enrollmentId: id }, "Enrolled.");
}

/* ============================================================ learner view */

async function attemptsWithCorrections(enrollmentIds: string[]): Promise<TrainingAttempt[]> {
  if (!enrollmentIds.length) return [];
  const rows = await db.select().from(trainingAttempts).where(inArray(trainingAttempts.enrollmentId, enrollmentIds)).orderBy(asc(trainingAttempts.attemptNo));
  if (!rows.length) return rows;
  const fixes = await db.select().from(trainingAttemptCorrections).where(inArray(trainingAttemptCorrections.attemptId, rows.map((r) => r.id))).orderBy(asc(trainingAttemptCorrections.at));
  /* A correction is read OVER the attempt — the attempt row itself never changes. */
  return rows.map((r) => {
    const f = fixes.filter((x) => x.attemptId === r.id).pop();
    return f ? { ...r, scorePercent: f.scorePercent, result: f.result } : r;
  });
}

const lite = (a: TrainingAttempt): AttemptLite => ({ moduleKey: a.moduleKey, attemptNo: a.attemptNo, startedAt: a.startedAt.toISOString(), submittedAt: a.submittedAt?.toISOString() ?? null, deadlineAt: a.deadlineAt?.toISOString() ?? null, result: (a.result as "passed" | "failed" | null) ?? null, scorePercent: a.scorePercent });

/** The published version of each module, by key. */
async function liveModules(keys: string[]) {
  if (!keys.length) return new Map<string, { id: string; title: string; category: string; version: TrainingModuleVersion }>();
  const rows = await db
    .select({ m: trainingModules, v: trainingModuleVersions })
    .from(trainingModules)
    .innerJoin(trainingModuleVersions, eq(trainingModuleVersions.moduleId, trainingModules.id))
    .where(and(inArray(trainingModules.key, keys), eq(trainingModuleVersions.status, "published")));
  return new Map(rows.map((r) => [r.m.key, { id: r.m.id, title: r.m.title, category: r.m.category, version: r.v }]));
}

export type EnrollmentView = {
  enrollment: TrainingEnrollment;
  track: { key: string; title: string; version: number; def: TrackDefinition };
  modules: (ModuleProgress & { title: string; category: string; n: number })[];
  summary: ReturnType<typeof progress>;
  trainerName: string | null;
};

/** One enrolment, every module's state. Closes any attempt past its deadline first. */
export async function enrollmentView(enrollmentId: string, nowMs: number): Promise<EnrollmentView | null> {
  const [e] = await db.select().from(trainingEnrollments).where(eq(trainingEnrollments.id, enrollmentId)).limit(1);
  if (!e) return null;
  await closeExpired(e.id, nowMs);
  const [tv] = await db.select({ v: trainingTrackVersions, t: trainingTracks }).from(trainingTrackVersions).innerJoin(trainingTracks, eq(trainingTracks.id, trainingTrackVersions.trackId)).where(eq(trainingTrackVersions.id, e.trackVersionId)).limit(1);
  if (!tv) return null;
  const def = tv.v.definition;
  const keys = def.items.map((i) => i.moduleKey);
  const [mods, attempts, events] = await Promise.all([
    liveModules(keys),
    attemptsWithCorrections([e.id]),
    db.select().from(trainingEvents).where(eq(trainingEvents.enrollmentId, e.id)),
  ]);
  const minStudy = Object.fromEntries(keys.map((k) => [k, mods.get(k)?.version.definition.minStudyMinutes ?? 0]));
  const states = moduleStates(def, attempts.map(lite), events.map((x): EventLite => ({ moduleKey: x.moduleKey, kind: x.kind as EventLite["kind"], seconds: x.seconds, at: x.at.toISOString() })), minStudy, nowMs);
  const [tr] = e.trainerId ? await db.select({ name: users.name }).from(users).where(eq(users.id, e.trainerId)).limit(1) : [];
  return {
    enrollment: e,
    track: { key: tv.t.key, title: tv.t.title, version: tv.v.version, def },
    modules: states.map((s, i) => ({ ...s, title: mods.get(s.moduleKey)?.title ?? s.moduleKey, category: mods.get(s.moduleKey)?.category ?? "other", n: i + 1 })),
    summary: progress(states),
    trainerName: tr?.name ?? null,
  };
}

export async function enrollmentsForUser(userId: string) {
  return db.select().from(trainingEnrollments).where(and(eq(trainingEnrollments.userId, userId), inArray(trainingEnrollments.status, ["active", "completed"]))).orderBy(desc(trainingEnrollments.assignedAt));
}

export async function enrollmentForApplication(applicationId: string) {
  const [e] = await db.select().from(trainingEnrollments).where(and(eq(trainingEnrollments.applicationId, applicationId), inArray(trainingEnrollments.status, ["active", "completed"]))).orderBy(desc(trainingEnrollments.assignedAt)).limit(1);
  return e ?? null;
}

/** Is this enrolment the person's own? Every learner write starts here. */
async function ownEnrollment(userId: string, enrollmentId: string) {
  const [e] = await db.select().from(trainingEnrollments).where(and(eq(trainingEnrollments.id, enrollmentId), eq(trainingEnrollments.userId, userId))).limit(1);
  return e ?? null;
}

export type ProductFact = { name: string; packSize: string | null; packing: string | null; cansPerBox: number; pricePaise: number | null };

/** The live catalogue behind a product-facts block. Read every time, so the price list never drifts. */
export async function productFacts(match: string): Promise<ProductFact[]> {
  const m = match.trim();
  if (m.length < 2) return [];
  const rows = await db
    .select({ name: products.name, packSize: products.packSize, packing: products.packing, cansPerBox: products.cansPerBox, pricePaise: products.sellingPricePaise })
    .from(products)
    .where(and(eq(products.active, true), sql`${products.name} ilike ${"%" + m.replace(/[%_]/g, "") + "%"}`))
    .orderBy(asc(products.displayOrder), asc(products.name))
    .limit(40);
  return rows;
}

/** A module as a learner reads it: content and rules, never the questions' answers. */
export async function moduleForLearner(userId: string, enrollmentId: string, moduleKey: string, nowMs: number) {
  const e = await ownEnrollment(userId, enrollmentId);
  if (!e) return null;
  const view = await enrollmentView(e.id, nowMs);
  const p = view?.modules.find((m) => m.moduleKey === moduleKey);
  if (!view || !p) return null;
  const live = (await liveModules([moduleKey])).get(moduleKey);
  if (!live) return null;
  const d = live.version.definition;
  const facts: Record<string, ProductFact[]> = {};
  for (const b of d.content) if (b.kind === "product_facts") facts[b.key] = await productFacts(b.match);
  const usable = d.questions.filter((q) => q.active && q.approved).length;
  return {
    view,
    progress: p,
    title: live.title,
    category: live.category,
    version: live.version.version,
    content: d.content,
    facts,
    rules: { passMark: d.passMarkPercent, timerMinutes: d.timerMinutes, questions: d.questionsPerAttempt ? Math.min(d.questionsPerAttempt, usable) : usable, minStudyMinutes: d.minStudyMinutes, feedback: d.feedback },
    canStart: canStartAttempt(p, d.minStudyMinutes),
  };
}

const STUDY_CAP_SECONDS = 15 * 60;

/** A learner's study time, sent by the reader every so often. Capped per beat so a left-open tab cannot bank hours. */
export async function recordStudy(userId: string, enrollmentId: string, moduleKey: string, seconds: number, nowMs: number): Promise<Result> {
  const e = await ownEnrollment(userId, enrollmentId);
  if (!e || e.status !== "active") return err("That training is not yours, or it is finished.", "not_found");
  const view = await enrollmentView(e.id, nowMs);
  const p = view?.modules.find((m) => m.moduleKey === moduleKey);
  if (!p) return err("That module is not in your track.", "not_found");
  if (p.state === "locked") return err(p.why, "rule_violation");
  const s = Math.max(0, Math.min(STUDY_CAP_SECONDS, Math.round(seconds)));
  if (!s) return ok(undefined);
  await db.insert(trainingEvents).values({ id: tid("tev"), enrollmentId: e.id, moduleKey, kind: "studied", seconds: s, actorId: userId });
  return ok(undefined);
}

/* ================================================================ attempts */

export async function startAttempt(userId: string, enrollmentId: string, moduleKey: string, nowMs: number): Promise<Result<{ attemptId: string }>> {
  const e = await ownEnrollment(userId, enrollmentId);
  if (!e || e.status !== "active") return err("That training is not yours, or it is finished.", "not_found");
  const view = await enrollmentView(e.id, nowMs);
  const p = view?.modules.find((m) => m.moduleKey === moduleKey);
  if (!view || !p) return err("That module is not in your track.", "not_found");
  if (p.state === "assessment_pending") {
    const [open] = await db.select({ id: trainingAttempts.id }).from(trainingAttempts).where(and(eq(trainingAttempts.enrollmentId, e.id), eq(trainingAttempts.moduleKey, moduleKey), isNull(trainingAttempts.submittedAt))).limit(1);
    if (open) return ok({ attemptId: open.id }, "Carry on where you left off.");
  }
  const live = (await liveModules([moduleKey])).get(moduleKey);
  if (!live) return err("That module has no published version.", "rule_violation");
  const d = live.version.definition;
  const gate = canStartAttempt(p, d.minStudyMinutes);
  if (!gate.ok) return err(gate.why, "rule_violation");
  const [{ n }] = (await db.execute(sql`select coalesce(max(attempt_no), 0)::int as n from training_attempts where enrollment_id = ${e.id} and module_key = ${moduleKey}`)) as unknown as { n: number }[];
  const id = tid("tat");
  const items = drawAttempt(d, seedFrom(id));
  if (!items.length) return err("This module has no questions to ask yet.", "rule_violation");
  const startedAt = new Date(nowMs);
  await db.insert(trainingAttempts).values({
    id,
    enrollmentId: e.id,
    moduleKey,
    moduleVersionId: live.version.id,
    attemptNo: n + 1,
    startedAt,
    deadlineAt: d.timerMinutes ? new Date(nowMs + d.timerMinutes * 60_000) : null,
    items,
    totalQuestions: items.length,
    passMark: d.passMarkPercent,
    trainerId: e.trainerId,
  });
  return ok({ attemptId: id });
}

async function ownAttempt(userId: string, attemptId: string) {
  const [r] = await db
    .select({ a: trainingAttempts, e: trainingEnrollments, v: trainingModuleVersions })
    .from(trainingAttempts)
    .innerJoin(trainingEnrollments, eq(trainingEnrollments.id, trainingAttempts.enrollmentId))
    .innerJoin(trainingModuleVersions, eq(trainingModuleVersions.id, trainingAttempts.moduleVersionId))
    .where(and(eq(trainingAttempts.id, attemptId), eq(trainingEnrollments.userId, userId)))
    .limit(1);
  return r ?? null;
}

const expired = (a: Pick<TrainingAttempt, "deadlineAt" | "submittedAt">, nowMs: number) => !a.submittedAt && a.deadlineAt != null && a.deadlineAt.getTime() <= nowMs;

export type QuestionView = {
  attemptId: string;
  moduleKey: string;
  attemptNo: number;
  index: number;
  total: number;
  deadlineAt: string | null;
  question: { key: string; text: string; options: { key: string; text: string }[] };
  chosen: string | null;
  /** Only in after-each mode, once answered. */
  feedback: { correct: boolean; correctKey: string; explanation: string } | null;
  answered: number;
  submitted: boolean;
};

/** One question of an attempt, served without its answer. */
export async function attemptQuestion(userId: string, attemptId: string, index: number, nowMs: number): Promise<Result<QuestionView>> {
  const r = await ownAttempt(userId, attemptId);
  if (!r) return err("That test is not yours.", "not_found");
  if (expired(r.a, nowMs)) {
    await submitAttempt(userId, attemptId, nowMs);
    return err("Time ran out. The test was submitted with the answers you had given.", "rule_violation");
  }
  const items = r.a.items;
  const i = Math.max(0, Math.min(items.length - 1, Math.round(index)));
  const it = items[i];
  const q = r.v.definition.questions.find((x) => x.key === it.questionKey);
  if (!q) return err("That question is missing from the module.", "not_found");
  const ans = r.a.answers.find((x) => x.questionKey === q.key) ?? null;
  const showFeedback = r.v.definition.feedback === "after_each" && ans?.optionKey != null;
  return ok({
    attemptId,
    moduleKey: r.a.moduleKey,
    attemptNo: r.a.attemptNo,
    index: i,
    total: items.length,
    deadlineAt: r.a.deadlineAt?.toISOString() ?? null,
    question: { key: q.key, text: q.text, options: it.optionOrder.map((k) => q.options.find((o) => o.key === k)).filter((o): o is { key: string; text: string } => Boolean(o)) },
    chosen: ans?.optionKey ?? null,
    feedback: showFeedback ? { correct: ans!.correct === true, correctKey: q.correctKey, explanation: q.explanation } : null,
    answered: r.a.answers.filter((x) => x.optionKey != null).length,
    submitted: Boolean(r.a.submittedAt),
  });
}

/** Save one answer. In after-each mode an answer, once its feedback is shown, cannot be changed. */
export async function answerQuestion(userId: string, attemptId: string, questionKey: string, optionKey: string, nowMs: number): Promise<Result<{ correct: boolean | null }>> {
  const r = await ownAttempt(userId, attemptId);
  if (!r) return err("That test is not yours.", "not_found");
  if (r.a.submittedAt) return err("This test is already submitted.", "rule_violation");
  if (expired(r.a, nowMs)) {
    await submitAttempt(userId, attemptId, nowMs);
    return err("Time ran out. The test was submitted with the answers you had given.", "rule_violation");
  }
  if (!r.a.items.some((x) => x.questionKey === questionKey)) return err("That question is not in this test.", "validation");
  const q = r.v.definition.questions.find((x) => x.key === questionKey);
  if (!q || !q.options.some((o) => o.key === optionKey)) return err("That is not one of the options.", "validation");
  const prior = r.a.answers.find((x) => x.questionKey === questionKey);
  if (prior?.optionKey && r.v.definition.feedback === "after_each") return err("The answer to this question is already shown, so it stays as given.", "rule_violation");
  const correct = optionKey === q.correctKey;
  const next: TrainingAnswer[] = [...r.a.answers.filter((x) => x.questionKey !== questionKey), { questionKey, optionKey, correct, at: new Date(nowMs).toISOString() }];
  /* The trigger allows this only while the attempt is unsubmitted. */
  await db.update(trainingAttempts).set({ answers: next }).where(and(eq(trainingAttempts.id, attemptId), isNull(trainingAttempts.submittedAt)));
  return ok({ correct: r.v.definition.feedback === "after_each" ? correct : null });
}

export type AttemptResult = { attemptId: string; moduleKey: string; attemptNo: number; scorePercent: number; correct: number; total: number; passMark: number; result: "passed" | "failed"; weakTags: { tag: string; missed: number }[]; review: { text: string; chosen: string | null; correctText: string; correct: boolean; explanation: string }[] | null; trackCompleted: boolean };

/** Score and close an attempt. Called by the learner, or by anything that finds one past its deadline. */
export async function submitAttempt(userId: string, attemptId: string, nowMs: number): Promise<Result<AttemptResult>> {
  const r = await ownAttempt(userId, attemptId);
  if (!r) return err("That test is not yours.", "not_found");
  return closeAttempt(r.a, r.v, r.e, nowMs);
}

async function closeAttempt(a: TrainingAttempt, v: TrainingModuleVersion, e: TrainingEnrollment, nowMs: number): Promise<Result<AttemptResult>> {
  const d = v.definition;
  const correct = a.items.filter((it) => a.answers.find((x) => x.questionKey === it.questionKey)?.correct).length;
  const s = score(correct, a.items.length, a.passMark);
  if (!a.submittedAt) {
    const done = await db
      .update(trainingAttempts)
      .set({ submittedAt: new Date(nowMs), correctAnswers: correct, scorePercent: s.percent, result: s.result })
      .where(and(eq(trainingAttempts.id, a.id), isNull(trainingAttempts.submittedAt)))
      .returning({ id: trainingAttempts.id });
    if (done.length) await afterSubmit(a, e, s.result, s.percent, nowMs);
  }
  const missed = new Map<string, number>();
  for (const it of a.items) {
    const q = d.questions.find((x) => x.key === it.questionKey);
    if (!q || a.answers.find((x) => x.questionKey === it.questionKey)?.correct) continue;
    for (const t of q.tags) missed.set(t, (missed.get(t) ?? 0) + 1);
  }
  const showReview = d.feedback !== "none";
  const [fresh] = await db.select({ status: trainingEnrollments.status }).from(trainingEnrollments).where(eq(trainingEnrollments.id, e.id)).limit(1);
  return ok({
    attemptId: a.id,
    moduleKey: a.moduleKey,
    attemptNo: a.attemptNo,
    scorePercent: s.percent,
    correct,
    total: a.items.length,
    passMark: a.passMark,
    result: s.result,
    weakTags: [...missed.entries()].map(([tag, n]) => ({ tag, missed: n })).sort((x, y) => y.missed - x.missed),
    review: showReview
      ? a.items.map((it) => {
          const q = d.questions.find((x) => x.key === it.questionKey)!;
          const ans = a.answers.find((x) => x.questionKey === it.questionKey);
          return { text: q.text, chosen: q.options.find((o) => o.key === ans?.optionKey)?.text ?? null, correctText: q.options.find((o) => o.key === q.correctKey)?.text ?? "", correct: Boolean(ans?.correct), explanation: q.explanation };
        })
      : null,
    trackCompleted: fresh?.status === "completed",
  });
}

/** Any open attempt on this enrolment past its deadline is closed on what was answered. */
async function closeExpired(enrollmentId: string, nowMs: number) {
  const open = await db
    .select({ a: trainingAttempts, v: trainingModuleVersions, e: trainingEnrollments })
    .from(trainingAttempts)
    .innerJoin(trainingModuleVersions, eq(trainingModuleVersions.id, trainingAttempts.moduleVersionId))
    .innerJoin(trainingEnrollments, eq(trainingEnrollments.id, trainingAttempts.enrollmentId))
    .where(and(eq(trainingAttempts.enrollmentId, enrollmentId), isNull(trainingAttempts.submittedAt), sql`${trainingAttempts.deadlineAt} <= ${new Date(nowMs).toISOString()}::timestamptz`));
  for (const r of open) await closeAttempt(r.a, r.v, r.e, nowMs);
}

/** After a submit: tell the trainer about a fail; close the enrolment when everything required is passed. */
async function afterSubmit(a: TrainingAttempt, e: TrainingEnrollment, result: "passed" | "failed", percent: number, nowMs: number) {
  const [learner] = await db.select({ name: users.name }).from(users).where(eq(users.id, e.userId)).limit(1);
  const title = (await liveModules([a.moduleKey])).get(a.moduleKey)?.title ?? a.moduleKey;
  if (result === "failed" && e.trainerId)
    await notifyUsers([{ userId: e.trainerId, title: `${learner?.name ?? "A learner"} needs retraining on ${title}`, body: `Scored ${percent}% against a pass mark of ${a.passMark}%. Review the module with them and sign it off to open the retake.`, href: `/hire/train/retakes?enrollment=${e.id}&module=${encodeURIComponent(a.moduleKey)}` }]).catch(() => []);
  if (result !== "passed") return;
  const view = await enrollmentView(e.id, nowMs);
  if (!view || view.summary.passed < view.summary.required) return;
  const now = new Date(nowMs);
  const moved = await db.update(trainingEnrollments).set({ status: "completed", completedAt: now }).where(and(eq(trainingEnrollments.id, e.id), eq(trainingEnrollments.status, "active"))).returning({ id: trainingEnrollments.id });
  if (moved.length && e.applicationId) {
    const { onTrainingCompleted } = await import("@/lib/hire/services/training-status");
    await onTrainingCompleted(e.applicationId, { id: e.userId, name: learner?.name ?? "Learner" });
  }
}

/* ================================================================ trainers */

export type RetakeRow = {
  enrollmentId: string;
  userId: string;
  name: string;
  trackTitle: string;
  moduleKey: string;
  moduleTitle: string;
  attemptId: string;
  attemptNo: number;
  scorePercent: number;
  passMark: number;
  failedAt: string;
  weak: string[];
  state: "retraining_required" | "retake_open" | "passed_on_retake";
  trainerId: string | null;
  signedOffWhy: string | null;
};

/** Every failed module still waiting on somebody, and the recent retakes that passed. */
export async function retakeQueue(opts: { trainerId?: string | null; nowMs: number }): Promise<RetakeRow[]> {
  const rows = (await db.execute(sql`
    select e.id as enrollment_id, e.user_id, u.name, t.title as track_title, e.trainer_id,
           a.id as attempt_id, a.module_key, a.attempt_no, a.score_percent, a.pass_mark, a.submitted_at, a.items, a.answers, a.module_version_id,
           (select v.definition from training_module_versions v where v.id = a.module_version_id) as def,
           (select m.title from training_modules m where m.key = a.module_key) as module_title,
           exists (select 1 from training_attempts p where p.enrollment_id = e.id and p.module_key = a.module_key and p.result = 'passed') as now_passed,
           (select ev.note from training_events ev where ev.enrollment_id = e.id and ev.module_key = a.module_key and ev.kind = 'retraining_signed_off' and ev.at > a.submitted_at order by ev.at desc limit 1) as signed_note
      from training_attempts a
      join training_enrollments e on e.id = a.enrollment_id
      join users u on u.id = e.user_id
      join training_track_versions tv on tv.id = e.track_version_id
      join training_tracks t on t.id = tv.track_id
     where a.result = 'failed' and e.status <> 'withdrawn'
       ${opts.trainerId ? sql`and e.trainer_id = ${opts.trainerId}` : sql``}
       and a.attempt_no = (select max(x.attempt_no) from training_attempts x where x.enrollment_id = a.enrollment_id and x.module_key = a.module_key and x.result = 'failed')
       and a.submitted_at > now() - interval '90 days'
     order by a.submitted_at desc`)) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const def = r.def as ModuleDefinition;
    const items = r.items as { questionKey: string }[];
    const answers = r.answers as TrainingAnswer[];
    const weak = new Map<string, number>();
    for (const it of items) {
      if (answers.find((x) => x.questionKey === it.questionKey)?.correct) continue;
      for (const t of def.questions.find((q) => q.key === it.questionKey)?.tags ?? []) weak.set(t, (weak.get(t) ?? 0) + 1);
    }
    return {
      enrollmentId: String(r.enrollment_id),
      userId: String(r.user_id),
      name: String(r.name),
      trackTitle: String(r.track_title),
      moduleKey: String(r.module_key),
      moduleTitle: String(r.module_title ?? r.module_key),
      attemptId: String(r.attempt_id),
      attemptNo: Number(r.attempt_no),
      scorePercent: Number(r.score_percent),
      passMark: Number(r.pass_mark),
      failedAt: new Date(r.submitted_at as string).toISOString(),
      weak: [...weak.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
      state: r.now_passed ? "passed_on_retake" : r.signed_note != null ? "retake_open" : "retraining_required",
      trainerId: (r.trainer_id as string) ?? null,
      signedOffWhy: (r.signed_note as string) ?? null,
    };
  });
}

/** A failed attempt in full, for the trainer — every question, what was chosen, what was right. */
export async function attemptDetail(attemptId: string) {
  const [r] = await db
    .select({ a: trainingAttempts, v: trainingModuleVersions, e: trainingEnrollments, name: users.name })
    .from(trainingAttempts)
    .innerJoin(trainingModuleVersions, eq(trainingModuleVersions.id, trainingAttempts.moduleVersionId))
    .innerJoin(trainingEnrollments, eq(trainingEnrollments.id, trainingAttempts.enrollmentId))
    .innerJoin(users, eq(users.id, trainingEnrollments.userId))
    .where(eq(trainingAttempts.id, attemptId))
    .limit(1);
  if (!r) return null;
  const fixes = await db.select().from(trainingAttemptCorrections).where(eq(trainingAttemptCorrections.attemptId, attemptId)).orderBy(asc(trainingAttemptCorrections.at));
  const studiedSince = r.a.submittedAt
    ? (((await db.execute(sql`select coalesce(sum(seconds), 0)::int as s from training_events where enrollment_id = ${r.e.id} and module_key = ${r.a.moduleKey} and kind = 'studied' and at > ${r.a.submittedAt.toISOString()}::timestamptz`)) as unknown as { s: number }[])[0]?.s ?? 0)
    : 0;
  const [title] = await db.select({ title: trainingModules.title }).from(trainingModules).where(eq(trainingModules.key, r.a.moduleKey)).limit(1);
  return {
    attempt: r.a,
    learner: r.name,
    enrollmentId: r.e.id,
    moduleTitle: title?.title ?? r.a.moduleKey,
    moduleVersion: r.v.version,
    minStudyMinutes: r.v.definition.minStudyMinutes,
    studiedSinceSeconds: studiedSince,
    corrections: fixes,
    questions: r.a.items.map((it, i) => {
      const q = r.v.definition.questions.find((x) => x.key === it.questionKey);
      const ans = r.a.answers.find((x) => x.questionKey === it.questionKey);
      return { n: i + 1, text: q?.text ?? it.questionKey, chosen: q?.options.find((o) => o.key === ans?.optionKey)?.text ?? null, correctText: q?.options.find((o) => o.key === q.correctKey)?.text ?? "", correct: Boolean(ans?.correct), tags: q?.tags ?? [] };
    }),
  };
}

export const SIGN_OFF_MIN = 10;

/** PRD §18.5 — the trainer has reviewed the module with the learner. Only after this can a retake open. */
export async function signOffRetraining(actor: Actor, enrollmentId: string, moduleKey: string, note: string, nowMs: number): Promise<Result> {
  const n = note.trim();
  if (n.length < SIGN_OFF_MIN) return { ok: false, error: `Say what was reviewed — at least ${SIGN_OFF_MIN} characters. It is kept on the record.`, code: "validation", fieldErrors: [{ field: "note", message: "Required" }] };
  const view = await enrollmentView(enrollmentId, nowMs);
  const p = view?.modules.find((m) => m.moduleKey === moduleKey);
  if (!view || !p) return err("That module is not in this person’s track.", "not_found");
  if (p.state !== "retraining_required") return err(p.state === "retake_open" ? "Already signed off — the retake is open." : "There is no failed attempt waiting for a review.", "rule_violation");
  const [last] = await db.select({ submittedAt: trainingAttempts.submittedAt }).from(trainingAttempts).where(and(eq(trainingAttempts.enrollmentId, enrollmentId), eq(trainingAttempts.moduleKey, moduleKey), eq(trainingAttempts.result, "failed"))).orderBy(desc(trainingAttempts.attemptNo)).limit(1);
  const already = last?.submittedAt
    ? await db.select({ id: trainingEvents.id }).from(trainingEvents).where(and(eq(trainingEvents.enrollmentId, enrollmentId), eq(trainingEvents.moduleKey, moduleKey), eq(trainingEvents.kind, "retraining_signed_off"), sql`${trainingEvents.at} > ${last.submittedAt.toISOString()}::timestamptz`)).limit(1)
    : [];
  if (already.length) return err("Already signed off. The learner studies the module again and the retake opens.", "rule_violation");
  await db.insert(trainingEvents).values({ id: tid("tev"), enrollmentId, moduleKey, kind: "retraining_signed_off", note: n, actorId: actor.id, at: new Date(nowMs) });
  await notifyUsers([{ userId: view.enrollment.userId, title: `${view.modules.find((m) => m.moduleKey === moduleKey)?.title ?? moduleKey}: retake opening`, body: `${actor.name} signed off your review. Read the module again and the retake opens.`, href: `/learn/${view.enrollment.id}/${encodeURIComponent(moduleKey)}` }]).catch(() => []);
  return ok(undefined, "Signed off. The retake opens once they have studied the module again.");
}

export const CORRECTION_MIN = 20;

/** PRD §21 — the authorised correction workflow. The attempt is untouched; this row is read over it. */
export async function correctAttempt(actor: Actor, attemptId: string, input: { scorePercent: number; reason: string }, nowMs: number): Promise<Result> {
  const why = input.reason.trim();
  if (why.length < CORRECTION_MIN) return { ok: false, error: `A correction needs a reason of at least ${CORRECTION_MIN} characters.`, code: "validation", fieldErrors: [{ field: "reason", message: "Required" }] };
  const pct = Math.round(Number(input.scorePercent) * 10) / 10;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, error: "A score is between 0 and 100.", code: "validation", fieldErrors: [{ field: "score", message: "0–100" }] };
  const [a] = await db.select().from(trainingAttempts).where(eq(trainingAttempts.id, attemptId)).limit(1);
  if (!a || !a.submittedAt) return err("Only a submitted attempt can be corrected.", "rule_violation");
  const result = pct >= a.passMark ? "passed" : "failed";
  await db.insert(trainingAttemptCorrections).values({ id: tid("tac"), attemptId, scorePercent: pct, result, reason: why, byId: actor.id, at: new Date(nowMs) });
  const [e] = await db.select().from(trainingEnrollments).where(eq(trainingEnrollments.id, a.enrollmentId)).limit(1);
  if (e && result === "passed") {
    const view = await enrollmentView(e.id, nowMs);
    if (view && view.summary.passed >= view.summary.required && e.status === "active") {
      await db.update(trainingEnrollments).set({ status: "completed", completedAt: new Date(nowMs) }).where(eq(trainingEnrollments.id, e.id));
      if (e.applicationId) {
        const { onTrainingCompleted } = await import("@/lib/hire/services/training-status");
        await onTrainingCompleted(e.applicationId, actor);
      }
    }
  }
  return ok(undefined, `Corrected to ${pct}% (${result}). The original attempt stays on the record.`);
}

/* ================================================================ insights */

export async function trainingInsights(nowMs: number) {
  const perModule = (await db.execute(sql`
    with firsts as (
      select a.module_key, a.result from training_attempts a
       where a.submitted_at is not null and a.attempt_no = 1)
    select m.key, m.title,
           (select count(*)::int from training_attempts a where a.module_key = m.key and a.submitted_at is not null) as attempts,
           (select round(avg(a.score_percent)::numeric, 1)::float from training_attempts a where a.module_key = m.key and a.submitted_at is not null) as avg_score,
           (select count(*)::int from training_attempts a where a.module_key = m.key and a.submitted_at is not null and a.attempt_no > 1) as retakes,
           (select count(*)::int from firsts f where f.module_key = m.key) as first_n,
           (select count(*)::int from firsts f where f.module_key = m.key and f.result = 'passed') as first_pass
      from training_modules m where m.active
     order by m.title`)) as unknown as { key: string; title: string; attempts: number; avg_score: number | null; retakes: number; first_n: number; first_pass: number }[];
  const gaps = (await db.execute(sql`
    select tag, count(*) filter (where not coalesce((x->>'correct')::boolean, false))::int as wrong, count(*)::int as total
      from training_attempts a
      join training_module_versions v on v.id = a.module_version_id,
           jsonb_array_elements(a.answers) x,
           jsonb_array_elements(v.definition->'questions') q,
           jsonb_array_elements_text(q->'tags') tag
     where a.submitted_at is not null and q->>'key' = x->>'questionKey'
     group by tag having count(*) >= 3
     order by 2 desc limit 12`)) as unknown as { tag: string; wrong: number; total: number }[];
  const people = (await db.execute(sql`
    select e.id, u.name, e.status, e.assigned_at, e.due_on, e.completed_at, t.title as track
      from training_enrollments e join users u on u.id = e.user_id
      join training_track_versions tv on tv.id = e.track_version_id join training_tracks t on t.id = tv.track_id
     where e.status <> 'withdrawn' order by e.assigned_at desc limit 200`)) as unknown as { id: string; name: string; status: string; assigned_at: string; due_on: string | null; completed_at: string | null; track: string }[];
  const views = await Promise.all(people.filter((p) => p.status === "active").map((p) => enrollmentView(p.id, nowMs)));
  const firstN = perModule.reduce((n, m) => n + m.first_n, 0);
  const firstPass = perModule.reduce((n, m) => n + m.first_pass, 0);
  const completed = people.filter((p) => p.status === "completed");
  const retakesAll = perModule.reduce((n, m) => n + m.retakes, 0);
  return {
    perModule,
    gaps,
    people: people.map((p) => {
      const v = views.find((x) => x?.enrollment.id === p.id);
      return { ...p, passed: v?.summary.passed ?? null, required: v?.summary.required ?? null, retraining: v?.modules.some((m) => m.state === "retraining_required") ?? false, overdue: p.status === "active" && p.due_on != null && p.due_on < new Date(nowMs).toISOString().slice(0, 10) };
    }),
    totals: {
      active: people.filter((p) => p.status === "active").length,
      completed: completed.length,
      firstAttemptPassRate: firstN ? Math.round((firstPass / firstN) * 100) : null,
      firstAttempts: firstN,
      retakesPerCompletion: completed.length ? Math.round((retakesAll / completed.length) * 10) / 10 : null,
      overdue: people.filter((p) => p.status === "active" && p.due_on != null && p.due_on < new Date(nowMs).toISOString().slice(0, 10)).length,
    },
  };
}
