"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireActIn, requireSection, founderAccess, NotAllowedHere } from "@/lib/command-centre/access";
import { readPeriodState } from "@/lib/command-centre/period";
import { providerFor } from "@/lib/command-centre/registry";
import { addNote, pageOf, refusal, type Ctx } from "@/lib/command-centre/provider";
import { companyFigure } from "@/lib/command-centre/company";
import { inboxFor, handOn, snooze, clearMark } from "@/lib/command-centre/inbox";
import { globalSearch, searchRecord, type SearchKind } from "@/lib/command-centre/search";
import { quickForm, quickRun } from "@/lib/command-centre/quick";
import { ask } from "@/lib/command-centre/ask";
import type {
  FigureDrawer,
  FormSpec,
  RecordView,
  Result,
  SearchHit,
  SectionKey,
  TablePage,
  ViewAs,
} from "@/lib/command-centre/types";
import { isSectionKey } from "@/lib/command-centre/types";

/* ---------------------------------------------------------------------------
 * Every door the Command Centre's shell calls. Each one checks, on the
 * server, that the caller holds the Founder app and the section's module —
 * and, before anything is written, that their level may act there (PRD §5.4).
 * Writes go through the owning app's own actions inside the providers.
 * ------------------------------------------------------------------------- */

type PeriodIn = { key: string; from?: string; to?: string };

async function ctxFor(period: PeriodIn, userId: string): Promise<Ctx> {
  return { period: await readPeriodState(period.key, { from: period.from, to: period.to }), userId };
}

function guardSection(s: unknown): SectionKey {
  if (!isSectionKey(s)) throw new NotAllowedHere("No such section.");
  return s;
}

export async function tablePageAction(
  section: SectionKey,
  table: string,
  period: PeriodIn,
  q: string,
  page: number,
  size: number,
): Promise<Result<TablePage>> {
  try {
    const { user } = await requireSection(guardSection(section));
    const ctx = await ctxFor(period, user.id);
    const provider = await providerFor(section);
    return { ok: true, data: await provider.tablePage(ctx, table, pageOf({ q, page, size })) };
  } catch (e) {
    return refusal(e) as Result<TablePage>;
  }
}

export async function figureAction(section: SectionKey, metric: string, period: PeriodIn): Promise<Result<FigureDrawer>> {
  try {
    const { user } = await requireSection(guardSection(section));
    const ctx = await ctxFor(period, user.id);
    const data = section === "company" ? await companyFigure(ctx.period, metric) : await (await providerFor(section)).figure(ctx, metric);
    return { ok: true, data };
  } catch (e) {
    return refusal(e) as Result<FigureDrawer>;
  }
}

export async function recordAction(section: SectionKey, table: string, id: string, period: PeriodIn): Promise<Result<RecordView>> {
  try {
    const { user } = await requireSection(guardSection(section));
    const ctx = await ctxFor(period, user.id);
    if (table === "search") {
      const kind = ({ customers: "customer", people: "staff", sales: "order", money: "bill", prices: "pricelist", enquiries: "enquiry" } as Record<string, SearchKind>)[section];
      if (!kind) throw new Error("No such record.");
      return { ok: true, data: await searchRecord(kind, id) };
    }
    return { ok: true, data: await (await providerFor(section)).record(ctx, table, id) };
  } catch (e) {
    return refusal(e) as Result<RecordView>;
  }
}

export async function runAction(
  section: SectionKey,
  table: string,
  act: string,
  id: string,
  input: Record<string, string>,
  period: PeriodIn,
): Promise<Result> {
  try {
    const { user } = await requireActIn(guardSection(section));
    const ctx = await ctxFor(period, user.id);
    const r = await (await providerFor(section)).act(ctx, table, act, id, input);
    if (r.ok) revalidatePath("/founder");
    return r;
  } catch (e) {
    return refusal(e);
  }
}

export async function addNoteAction(kind: string, id: string, note: string): Promise<Result> {
  try {
    const { user } = await founderAccess();
    const text = note.trim();
    if (!text) return { ok: false, error: "Write the note first", fieldErrors: { n: "Note is needed" } };
    if (text.length > 4000) return { ok: false, error: "Keep the note under 4,000 characters", fieldErrors: { n: "Too long" } };
    await addNote(user.id, kind, id, text);
    return { ok: true, message: "Note added" };
  } catch (e) {
    return refusal(e);
  }
}

export async function searchAction(q: string): Promise<SearchHit[]> {
  const { allowed } = await founderAccess();
  const hits = await globalSearch(q);
  return hits.filter((h) => allowed.includes(h.ref.section) || allowed.includes("company"));
}

/** Search options for a person, customer or product field. */
export async function optionsAction(kind: string, q: string): Promise<{ v: string; l: string }[]> {
  await founderAccess();
  const term = q.trim();
  const like = `%${term.replace(/[%_]/g, "")}%`;
  if (kind === "product") {
    if (term.length < 2) return [];
    const rows = await db.execute<{ id: string; name: string }>(sql`
      select id, name from products where active and (name ilike ${like} or similarity(name, ${term}) > 0.25)
       order by similarity(name, ${term}) desc limit 12
    `);
    return rows.map((r) => ({ v: r.id, l: r.name }));
  }
  if (kind === "staff" || kind === "caller" || kind === "salesman") {
    const app = kind === "caller" ? "crm" : kind === "salesman" ? "field" : null;
    const rows = await db.execute<{ id: string; name: string; apps: string | null }>(sql`
      select u.id, u.name, (select string_agg(a.app::text, ', ') from app_access a where a.user_id = u.id) as apps
        from users u
       where u.active ${term ? sql`and u.name ilike ${like}` : sql``}
         ${app ? sql`and exists (select 1 from app_access a where a.user_id = u.id and a.app = ${app})` : sql``}
       order by u.name limit 20
    `);
    return rows.map((r) => ({ v: r.id, l: `${r.name}${r.apps ? ` · ${r.apps}` : ""}` }));
  }
  if (term.length < 2) return [];
  const digits = term.replace(/\D/g, "");
  const rows = await db.execute<{ id: string; name: string; city: string | null; kind: string }>(sql`
    select c.id, c.name, c.city, c.kind::text as kind from customers c
     where (c.name ilike ${like} or c.city ilike ${like}
            ${digits.length >= 4 ? sql`or regexp_replace(coalesce(c.phone,''), '\\D', '', 'g') like ${`%${digits}%`}` : sql``})
       ${kind === "customer" ? sql`and c.kind = 'customer'` : kind === "lead" ? sql`and c.kind = 'lead'` : sql``}
     order by (c.name ilike ${term.replace(/[%_]/g, "") + "%"}) desc, c.name limit 15
  `);
  return rows.map((r) => ({ v: r.id, l: `${r.name} · ${r.city ?? "no city"}${r.kind === "lead" ? " · lead" : ""}` }));
}

export async function quickFormAction(index: number, period: PeriodIn): Promise<Result<FormSpec>> {
  try {
    const { user } = await founderAccess();
    return { ok: true, data: await quickForm(await ctxFor(period, user.id), index) };
  } catch (e) {
    return refusal(e) as Result<FormSpec>;
  }
}

export async function quickRunAction(index: number, input: Record<string, string>, period: PeriodIn): Promise<Result> {
  try {
    const { user, level } = await founderAccess();
    if (level === "associate" && index !== 5 && index !== 6) {
      return { ok: false, error: "Your access to the Command Centre is read-only here." };
    }
    const r = await quickRun(await ctxFor(period, user.id), index, input);
    if (r.ok) revalidatePath("/founder");
    return r;
  } catch (e) {
    return refusal(e);
  }
}

export async function askAction(question: string, period: PeriodIn) {
  const { user } = await founderAccess();
  const ctx = await ctxFor(period, user.id);
  try {
    return { ok: true as const, data: await ask(ctx.period, user.id, question) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "That could not be answered." };
  }
}

export async function viewAsAction(section: SectionKey, userId: string): Promise<Result<ViewAs>> {
  try {
    await requireSection(guardSection(section));
    const { viewAsPerson } = await import("@/lib/command-centre/view-as");
    const kind = section === "calling" ? "caller" : section === "field" ? "salesman" : "auto";
    return { ok: true, data: await viewAsPerson(userId, kind) };
  } catch (e) {
    return refusal(e) as Result<ViewAs>;
  }
}

/* ---------------------------------------------------------------- inbox */

export async function handOnAction(itemId: string, toUserId: string, note: string): Promise<Result> {
  try {
    const { user } = await requireSection("inbox");
    if (!toUserId) return { ok: false, error: "Pick who to hand it to", fieldErrors: { to: "Hand to is needed" } };
    if (toUserId === user.id) return { ok: false, error: "That is you", fieldErrors: { to: "Pick somebody else" } };
    const item = (await inboxFor(user.id)).find((i) => i.id === itemId);
    if (!item) return { ok: false, error: "That item has cleared on its own since you opened it." };
    const [to] = await db.execute<{ name: string }>(sql`select name from users where id = ${toUserId} and active`);
    if (!to) return { ok: false, error: "That person cannot sign in", fieldErrors: { to: "Pick somebody active" } };
    await handOn(user.id, user.name, item, toUserId, note.trim());
    revalidatePath("/founder");
    return { ok: true, message: `Handed to ${to.name} · it stays in Handed on until it clears` };
  } catch (e) {
    return refusal(e);
  }
}

export async function snoozeAction(itemId: string, until: string, why: string): Promise<Result> {
  try {
    const { user } = await requireSection("inbox");
    const fe: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) fe.until = "Until is needed";
    if (!why.trim()) fe.why = "Why is needed";
    if (Object.keys(fe).length) return { ok: false, error: "Not snoozed yet", fieldErrors: fe };
    await snooze(user.id, itemId, until, why.trim());
    revalidatePath("/founder");
    return { ok: true, message: `Snoozed until ${until}` };
  } catch (e) {
    return refusal(e);
  }
}

export async function clearMarkAction(itemId: string, what: "take-back" | "wake"): Promise<Result> {
  try {
    const { user } = await requireSection("inbox");
    await clearMark(user.id, itemId);
    revalidatePath("/founder");
    return { ok: true, message: what === "take-back" ? "Taken back · it is in Needs you again" : "Woken · it is in Needs you again" };
  } catch (e) {
    return refusal(e);
  }
}
