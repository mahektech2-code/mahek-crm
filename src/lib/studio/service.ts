import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, studioBatches, studioDesigns, studioPeopleDates, studioPosters, studioPosterShares, studioReminderState, users, type StudioPoster } from "@/db/schema";
import { resolveScope } from "@/lib/access-control";
import { customerCaption, suggestedCaption, type TemplateCategory } from "./domain/caption";
import { festivalCalendarSchema, selectEntries, type CalendarEntry, type DatedEntry, type EntryDesigns, type FestivalCalendar } from "./domain/festival-calendar";
import { LANGUAGE_NAMES, type Language } from "./domain/language";
import { offersTo } from "./domain/audience";
import type { RecipientKind } from "./domain/recipient";
import { wordingForAudience } from "./domain/template-audience";
import { fillPlaceholders } from "./domain/copy";
import { upcomingShared, type SharedReminder } from "./domain/shared-reminder";
import { dueReminders, DEFAULT_REMINDER_PREFS, type Reminder, type ReminderCandidate, type ReminderState } from "./domain/reminder";
import { TEMPLATES_DIR } from "./paths";
import { getStudioRegistry } from "./registry-service";
import type { PosterRecipe } from "./render-service";
import type { LoadedTemplate } from "./templates/loader";
import type { TemplateRegistry } from "./templates/registry";

/* ---------------------------------------------------------------------------
 * The Studio's reads. Writes are in lib/actions/studio.ts.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------ designs */

export type DesignCard = {
  id: string;
  version: string;
  name: string;
  description: string;
  occasion: string;
  occasionLabel: string;
  occasionColor: string | null;
  category: TemplateCategory;
  languages: { code: Language; label: string }[];
  requiresProduct: boolean;
  /** Uploaded by somebody here, rather than shipped with the app. */
  custom: boolean;
  preview: string;
};

export const designPreviewUrl = (id: string, version?: string) => `/api/studio/designs/${encodeURIComponent(id)}/preview${version ? `?v=${encodeURIComponent(version)}` : ""}`;

export function designCard(registry: TemplateRegistry, t: LoadedTemplate, audience?: RecipientKind): DesignCard {
  const m = t.manifest;
  const occasion = registry.occasion(m.occasion);
  const langs = audience ? registry.languagesFor(t, audience) : m.languages;
  return {
    id: m.versionOf ?? m.id,
    version: m.version,
    name: m.name,
    description: m.description,
    occasion: m.occasion,
    occasionLabel: occasion?.label ?? m.occasion,
    occasionColor: occasion?.color ?? null,
    category: m.category,
    languages: langs.map((code) => ({ code, label: LANGUAGE_NAMES[code] })),
    requiresProduct: m.requires.includes("product"),
    custom: m.tags.includes("custom"),
    preview: designPreviewUrl(m.versionOf ?? m.id, m.version),
  };
}

/** The approved designs offered to an audience, festival-calendar order first. */
export async function designsFor(audience?: RecipientKind): Promise<DesignCard[]> {
  const registry = await getStudioRegistry();
  return registry.list(audience ? { audience } : undefined).map((t) => designCard(registry, t, audience));
}

export async function occasionsFor(audience?: RecipientKind) {
  const registry = await getStudioRegistry();
  return registry.occasionsWithTemplates(audience).map((o) => ({ id: o.id, label: o.label, color: o.color ?? null, date: o.date }));
}

export type WordingChoice = { id: string; label: string; text: string };

/** The approved wording for one design, language and audience, with the recipient's name already filled in. */
export async function wordingChoices(input: { templateId: string; language: Language; audience: RecipientKind; company: string; contact: string | null; product: string | null }): Promise<WordingChoice[]> {
  const registry = await getStudioRegistry();
  const t = registry.get(input.templateId);
  if (!t || !offersTo(t.manifest, input.audience)) return [];
  return wordingForAudience(t.manifest, t.copy[input.language] ?? [], input.audience).map((o) => ({
    id: o.id,
    label: o.label,
    text: fillPlaceholders(o.text, { company: input.company, contact: input.contact, product: input.product }),
  }));
}

/** What a design can take beyond the recipient: a message box, a typed number, a typed product. */
export function designInputs(t: LoadedTemplate) {
  const f = t.manifest.fields;
  return {
    hasGreeting: f.some((x) => x.type === "text" && x.source === "copy"),
    takesPhone: f.some((x) => x.key === "contact_phone"),
    takesTypedProduct: f.some((x) => (x.key === "product_name" || x.key === "product_line") && x.type === "text" && x.source === "poster"),
    showsProduct: f.some((x) => x.key === "product_name" || x.key === "product_line" || x.key === "product_image"),
    optionalProduct: f.some((x) => (x.key === "product_line" || x.key === "product_name") && x.optional === true),
  };
}

/* ------------------------------------------------------------------ posters */

/** The recipe a stored poster draws from. */
export function recipeOf(p: Pick<StudioPoster, "audience" | "recipient" | "senderName" | "templateId" | "templateVersion" | "language" | "variantId" | "showProduct" | "personal">): PosterRecipe {
  return {
    audience: p.audience as RecipientKind,
    recipient: p.recipient,
    senderName: p.senderName,
    templateId: p.templateId,
    templateVersion: p.templateVersion,
    language: p.language as Language,
    variantId: p.variantId,
    showProduct: p.showProduct,
    personal: p.personal ?? {},
  };
}

/**
 * MAY THIS PERSON SEE THIS POSTER: whoever made it, and whoever's scope takes
 * in the person who made it — a manager sees their team's. A poster somebody
 * may not see and one that does not exist answer identically.
 */
async function visibleCreatorIds(): Promise<{ userId: string; ids: string[] | null }> {
  const { user, scope } = await resolveScope();
  return { userId: user.id, ids: scope.userIds };
}

export type PosterRow = {
  id: string;
  createdAt: Date;
  createdByName: string;
  mine: boolean;
  customerId: string | null;
  audience: RecipientKind;
  company: string;
  contact: string | null;
  templateId: string;
  templateVersion: string;
  templateName: string;
  occasion: string;
  language: string;
  shareCount: number;
  lastSharedAt: Date | null;
  batchId: string | null;
};

const POSTER_ROW = {
  id: studioPosters.id,
  createdAt: studioPosters.createdAt,
  createdById: studioPosters.createdById,
  createdByName: users.name,
  customerId: studioPosters.customerId,
  audience: studioPosters.audience,
  recipient: studioPosters.recipient,
  templateId: studioPosters.templateId,
  templateVersion: studioPosters.templateVersion,
  templateName: studioPosters.templateName,
  occasion: studioPosters.occasion,
  language: studioPosters.language,
  shareCount: studioPosters.shareCount,
  lastSharedAt: studioPosters.lastSharedAt,
  batchId: studioPosters.batchId,
};

function posterRow(r: { [K in keyof typeof POSTER_ROW]: unknown }, me: string): PosterRow {
  const rec = r.recipient as StudioPoster["recipient"];
  return {
    id: String(r.id),
    createdAt: r.createdAt as Date,
    createdByName: String(r.createdByName ?? ""),
    mine: r.createdById === me,
    customerId: (r.customerId as string | null) ?? null,
    audience: r.audience as RecipientKind,
    company: rec.company,
    contact: rec.contact,
    templateId: String(r.templateId),
    templateVersion: String(r.templateVersion),
    templateName: String(r.templateName),
    occasion: String(r.occasion),
    language: String(r.language),
    shareCount: Number(r.shareCount ?? 0),
    lastSharedAt: (r.lastSharedAt as Date | null) ?? null,
    batchId: (r.batchId as string | null) ?? null,
  };
}

export const POSTER_PAGE = 30;

/** Posters in the asker's sight, newest first. `whose` narrows a manager's team view to their own. */
export async function listPosters(input: { whose: "mine" | "team"; customerId?: string | null; page?: number } = { whose: "mine" }) {
  const { userId, ids } = await visibleCreatorIds();
  const creators = input.whose === "mine" ? [userId] : ids;
  const where = and(isNull(studioPosters.removedAt), creators ? inArray(studioPosters.createdById, creators) : undefined, input.customerId ? eq(studioPosters.customerId, input.customerId) : undefined);
  const [{ n }] = await db.select({ n: count() }).from(studioPosters).where(where);
  const total = Number(n);
  const pageCount = Math.max(1, Math.ceil(total / POSTER_PAGE));
  const page = Math.min(Math.max(1, input.page ?? 1), pageCount);
  const rows = await db
    .select(POSTER_ROW)
    .from(studioPosters)
    .innerJoin(users, eq(users.id, studioPosters.createdById))
    .where(where)
    .orderBy(desc(studioPosters.createdAt), desc(studioPosters.id))
    .limit(POSTER_PAGE)
    .offset((page - 1) * POSTER_PAGE);
  return { rows: rows.map((r) => posterRow(r, userId)), total, page, pageCount, teamView: ids === null || (ids?.length ?? 0) > 1 };
}

/** One poster, in sight, with everything its page needs. */
export async function getPoster(id: string) {
  const { userId, ids } = await visibleCreatorIds();
  const [row] = await db
    .select({ poster: studioPosters, createdByName: users.name })
    .from(studioPosters)
    .innerJoin(users, eq(users.id, studioPosters.createdById))
    .where(and(eq(studioPosters.id, id), ids ? inArray(studioPosters.createdById, ids) : undefined))
    .limit(1);
  if (!row) return null;
  return { ...row.poster, createdByName: row.createdByName, mine: row.poster.createdById === userId };
}

/** The suggested message to send with a poster. English, like the standalone Studio's. */
export function captionFor(p: Pick<StudioPoster, "audience" | "recipient" | "senderName">, category: TemplateCategory): string | null {
  const user = { name: p.senderName ?? "", displayName: p.senderName ?? null };
  return p.audience === "customer" ? customerCaption(category, p.recipient, user) : suggestedCaption(category, { contact: p.recipient.contact, company: p.recipient.company, product: p.recipient.product }, user);
}

export async function posterShares(posterId: string) {
  return db
    .select({ id: studioPosterShares.id, channel: studioPosterShares.channel, format: studioPosterShares.format, at: studioPosterShares.createdAt, by: users.name })
    .from(studioPosterShares)
    .innerJoin(users, eq(users.id, studioPosterShares.userId))
    .where(eq(studioPosterShares.posterId, posterId))
    .orderBy(desc(studioPosterShares.createdAt))
    .limit(50);
}

/* ------------------------------------------------------------------ batches */

export async function listBatches() {
  const { userId, ids } = await visibleCreatorIds();
  const rows = await db
    .select({
      id: studioBatches.id,
      createdAt: studioBatches.createdAt,
      createdByName: users.name,
      createdById: studioBatches.createdById,
      templateName: studioBatches.templateName,
      language: studioBatches.language,
      audience: studioBatches.audience,
      requested: studioBatches.requested,
      skipped: studioBatches.skipped,
      made: sql<number>`(select count(*)::int from studio_posters p where p.batch_id = studio_batches.id)`,
    })
    .from(studioBatches)
    .innerJoin(users, eq(users.id, studioBatches.createdById))
    .where(ids ? inArray(studioBatches.createdById, ids) : undefined)
    .orderBy(desc(studioBatches.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...r, made: Number(r.made), mine: r.createdById === userId }));
}

export async function getBatch(id: string) {
  const { ids } = await visibleCreatorIds();
  const [batch] = await db
    .select({ batch: studioBatches, createdByName: users.name })
    .from(studioBatches)
    .innerJoin(users, eq(users.id, studioBatches.createdById))
    .where(and(eq(studioBatches.id, id), ids ? inArray(studioBatches.createdById, ids) : undefined))
    .limit(1);
  if (!batch) return null;
  const posters = await db.select().from(studioPosters).where(eq(studioPosters.batchId, id)).orderBy(studioPosters.createdAt, studioPosters.id);
  return { ...batch.batch, createdByName: batch.createdByName, posters };
}

/* ------------------------------------------------------------------ uploaded designs */

export async function myDesignDrafts(userId: string) {
  return db
    .select({ id: studioDesigns.id, name: studioDesigns.name, status: studioDesigns.status, canvas: studioDesigns.canvas, updatedAt: studioDesigns.updatedAt, approvedAt: studioDesigns.approvedAt })
    .from(studioDesigns)
    .where(and(eq(studioDesigns.createdById, userId), inArray(studioDesigns.status, ["draft", "approved"])))
    .orderBy(desc(studioDesigns.updatedAt));
}

export async function draftsAwaitingApproval() {
  return db
    .select({ id: studioDesigns.id, name: studioDesigns.name, canvas: studioDesigns.canvas, updatedAt: studioDesigns.updatedAt, createdByName: users.name })
    .from(studioDesigns)
    .innerJoin(users, eq(users.id, studioDesigns.createdById))
    .where(eq(studioDesigns.status, "draft"))
    .orderBy(desc(studioDesigns.updatedAt));
}

export async function approvedUploads() {
  return db
    .select({ id: studioDesigns.id, name: studioDesigns.name, approvedAt: studioDesigns.approvedAt, createdByName: users.name })
    .from(studioDesigns)
    .innerJoin(users, eq(users.id, studioDesigns.createdById))
    .where(eq(studioDesigns.status, "approved"))
    .orderBy(desc(studioDesigns.approvedAt));
}

export async function getDesignRow(id: string) {
  const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)).limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ dates */

let calendar: FestivalCalendar | null = null;

/** The festival calendar shipped beside the designs. A file that is missing or invalid is an error, never an empty calendar. */
export function festivalCalendar(): FestivalCalendar {
  if (calendar) return calendar;
  const file = path.join(TEMPLATES_DIR, "festival-calendar.json");
  const parsed = festivalCalendarSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  calendar = parsed.data;
  return calendar;
}

/** Approved designs linked to a festival through its occasion. */
export function designsForEntry(entry: Pick<CalendarEntry, "occasionId">, registry: TemplateRegistry): EntryDesigns {
  const none: EntryDesigns = { lead: 0, customer: 0, any: false, occasionId: null };
  if (!entry.occasionId || !registry.occasion(entry.occasionId)) return none;
  const lead = registry.list({ audience: "lead" }).filter((t) => t.manifest.occasion === entry.occasionId).length;
  const customer = registry.list({ audience: "customer" }).filter((t) => t.manifest.occasion === entry.occasionId).length;
  return { lead, customer, any: lead + customer > 0, occasionId: lead + customer > 0 ? entry.occasionId : null };
}

export type FestivalView = DatedEntry & { designs: EntryDesigns };

export async function upcomingFestivals(todayKey: string, view: "7" | "30" | "all" = "all"): Promise<FestivalView[]> {
  const registry = await getStudioRegistry();
  return selectEntries(festivalCalendar().entries, todayKey, { view }).map((e) => ({ ...e, designs: designsForEntry(e, registry) }));
}

export function asShared(r: typeof studioPeopleDates.$inferSelect, names: Map<string, string>, customerKind: Map<string, "lead" | "customer">): SharedReminder {
  const actor = (id: string | null) => (id ? { id, label: names.get(id) ?? "Someone" } : null);
  return {
    id: r.id,
    kind: r.kind as SharedReminder["kind"],
    personName: r.personName,
    company: r.company,
    date: r.date,
    note: r.note,
    leadDays: r.leadDays as SharedReminder["leadDays"],
    crmKind: r.customerId ? (customerKind.get(r.customerId) ?? null) : null,
    crmId: r.customerId,
    version: r.version,
    createdBy: actor(r.createdById)!,
    createdAt: r.createdAt.getTime(),
    updatedBy: actor(r.updatedById)!,
    updatedAt: r.updatedAt.getTime(),
    deletedAt: r.deletedAt ? r.deletedAt.getTime() : null,
    deletedBy: actor(r.deletedById),
  };
}

export async function peopleDates(): Promise<SharedReminder[]> {
  const rows = await db.select().from(studioPeopleDates).where(isNull(studioPeopleDates.deletedAt)).orderBy(studioPeopleDates.personName);
  const userIds = [...new Set(rows.flatMap((r) => [r.createdById, r.updatedById]))];
  const custIds = [...new Set(rows.flatMap((r) => (r.customerId ? [r.customerId] : [])))];
  const [names, kinds] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    custIds.length ? db.select({ id: customers.id, kind: customers.kind }).from(customers).where(inArray(customers.id, custIds)) : [],
  ]);
  const nameMap = new Map(names.map((n) => [n.id, n.name]));
  const kindMap = new Map(kinds.map((k) => [k.id, k.kind === "customer" ? ("customer" as const) : ("lead" as const)]));
  return rows.map((r) => asShared(r, nameMap, kindMap));
}

export async function upcomingPeople(todayKey: string, withinDays?: number) {
  return upcomingShared(await peopleDates(), todayKey, withinDays === undefined ? {} : { withinDays });
}

/* ------------------------------------------------------------------ reminders */

async function reminderState(userId: string): Promise<ReminderState> {
  const [row] = await db.select({ state: studioReminderState.state }).from(studioReminderState).where(eq(studioReminderState.userId, userId)).limit(1);
  return row?.state ?? { read: {}, dismissed: {} };
}

/** What is coming up for this person: festivals with a design, and the shared birthdays and anniversaries, inside their lead time. */
export async function dueFor(userId: string, todayKey: string): Promise<Reminder[]> {
  const registry = await getStudioRegistry();
  const festivals: ReminderCandidate[] = festivalCalendar().entries.map((e) => ({ key: `festival:${e.id}`, kind: "festival", title: e.label, date: e.date, hasDesign: designsForEntry(e, registry).any }));
  const { items } = await upcomingPeople(todayKey);
  const people: ReminderCandidate[] = items.map((u) => ({ key: `${u.reminder.kind}:${u.reminder.id}:${u.occurrence.date}`, kind: u.reminder.kind, title: `${u.reminder.personName}${u.reminder.company ? ` · ${u.reminder.company}` : ""}`, date: u.occurrence.date, hasDesign: false, leadDays: u.reminder.leadDays }));
  return dueReminders([...festivals, ...people], DEFAULT_REMINDER_PREFS, await reminderState(userId), todayKey);
}

export { reminderState };
