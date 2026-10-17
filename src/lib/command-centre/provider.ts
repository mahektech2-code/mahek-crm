import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";
import type {
  FigureDrawer,
  PeriodState,
  RecordView,
  Result,
  SectionPayload,
  TableDef,
  TablePage,
} from "./types";

/* ---------------------------------------------------------------------------
 * THE CONTRACT EVERY SECTION IMPLEMENTS.
 *
 * A provider reads its figures from the owning app's services and runs its
 * actions through the owning app's functions (PRD P12, P15). It never
 * computes a business figure of its own and never writes a table directly
 * where an owning action exists — the Command Centre is another door onto
 * the same code, so a figure or a decision here can never disagree with the
 * same thing in the CRM, Accounts or the Sales Dashboard.
 *
 * Every read is COMPANY-WIDE (PRD §5.3): providers pass no scope narrowing,
 * and where an owning service narrows by `resolveScope()`, the founder hat's
 * scope is `all` (`scopeForUser`).
 * ------------------------------------------------------------------------- */

export type Ctx = {
  period: PeriodState;
  userId: string;
};

export type TableQuery = { q: string; page: number; size: number };

export interface SectionProvider {
  /** Metrics, callouts, footnote, and the first page of every table. */
  section(ctx: Ctx): Promise<SectionPayload>;
  /** One page of one table, searched over the WHOLE set on the server. */
  tablePage(ctx: Ctx, table: string, query: TableQuery): Promise<TablePage>;
  /** The drawer behind a metric: definition, 12-period trend, records behind it. */
  figure(ctx: Ctx, metric: string): Promise<FigureDrawer>;
  /** One row's full record. */
  record(ctx: Ctx, table: string, id: string): Promise<RecordView>;
  /** Run a row action through the owning app's function. */
  act(ctx: Ctx, table: string, act: string, id: string, input: Record<string, string>): Promise<Result>;
}

export const PAGE_SIZES = [25, 50, 100] as const;

export function pageOf(query: Partial<TableQuery> | undefined): TableQuery {
  const size = PAGE_SIZES.includes(Number(query?.size) as 25) ? Number(query?.size) : 25;
  const page = Math.max(1, Math.floor(Number(query?.page) || 1));
  return { q: String(query?.q ?? "").slice(0, 120), page, size };
}

/** Paging helper for providers that assemble a list in memory from a service. */
export function slice<T>(all: T[], query: TableQuery, match: (row: T, q: string) => boolean) {
  const q = query.q.trim().toLowerCase();
  const matched = q.length >= 2 ? all.filter((r) => match(r, q)) : all;
  const pages = Math.max(1, Math.ceil(matched.length / query.size));
  const page = Math.min(query.page, pages);
  return {
    rows: matched.slice((page - 1) * query.size, page * query.size),
    count: matched.length,
    total: all.length,
    page,
  };
}

export function emptyPage(query: TableQuery): TablePage {
  return { rows: [], count: 0, total: 0, page: 1, size: query.size, q: query.q };
}

export function withPage(def: TableDef, page: TablePage) {
  return { ...def, page };
}

/* -------------------------------------------------------------- stamps */

const STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Sep 2026, 10:12 IST" — a stored instant, in the zone named (PRD P2). */
export function stampIST(at: Date | string | null | undefined): string {
  if (!at) return "—";
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = Object.fromEntries(STAMP.formatToParts(d).map((p) => [p.type, p.value]));
  return `${Number(parts.day)} ${MON[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} IST`;
}

export function hoursSince(at: Date | string | null | undefined): number {
  if (!at) return 0;
  const d = at instanceof Date ? at : new Date(at);
  return Math.max(0, (Date.now() - d.getTime()) / 3_600_000);
}

/* ------------------------------------------------- record history & notes */

const HAT_WORD: Record<string, string> = {
  crm: "CRM",
  accounts: "Accounts",
  sales: "Sales Dashboard",
  field: "Salesman App",
  founder: "Founder",
  hrms: "HRMS",
  admin: "Admin",
  enquiries: "Enquiries",
  reports: "Reports",
  people: "People",
};

/** Readable audit history for a record (PRD §22.5). */
export async function auditFor(
  entityType: string | string[],
  entityId: string,
  limit = 20,
): Promise<{ what: string; who: string }[]> {
  const types = Array.isArray(entityType) ? entityType : [entityType];
  const rows = await db
    .select({
      action: auditLog.action,
      at: auditLog.at,
      role: auditLog.actorRole,
      app: auditLog.actorApp,
      name: users.name,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(inArray(auditLog.entityType, types), eq(auditLog.entityId, entityId)))
    .orderBy(desc(auditLog.at))
    .limit(limit);
  return rows
    .filter((r) => r.action !== "founder.note")
    .map((r) => ({
      what: actionWords(r.action),
      who: [
        r.name ?? "System",
        r.app || r.role
          ? `${r.app ? HAT_WORD[r.app] ?? r.app : ""}${r.app && r.role ? " " : ""}${r.role ? r.role : ""} hat`.trim()
          : null,
        stampIST(r.at),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
}

/** "order.approve" → "Order approved" — never a code on the screen (§22.2). */
export function actionWords(action: string): string {
  const [thing, verb] = action.split(".");
  const T = (thing ?? action).replace(/_/g, " ");
  const V = (verb ?? "").replace(/_/g, " ");
  const past: Record<string, string> = {
    approve: "approved",
    decline: "declined",
    reject: "rejected",
    confirm: "confirmed",
    hold: "held",
    reverse: "reversed",
    create: "created",
    update: "changed",
    delete: "deleted",
    close: "closed",
    dismiss: "dismissed",
    assign: "assigned",
    reassign: "reassigned",
    resolve: "resolved",
    publish: "published",
    revise: "revised",
    record: "recorded",
    deactivate: "deactivated",
    reactivate: "reactivated",
    save: "saved",
    note: "noted",
    skip: "skipped",
    send: "sent",
    sent_api: "sent through the API",
    confirm_sent: "confirmed as sent",
  };
  const v = past[verb ?? ""] ?? V;
  const s = `${T} ${v}`.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Notes written from the Command Centre, kept as audited rows. */
export async function notesFor(kind: string, id: string): Promise<{ what: string; when: string }[]> {
  const rows = await db
    .select({ after: auditLog.afterState, at: auditLog.at, name: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.action, "founder.note"), eq(auditLog.entityType, kind), eq(auditLog.entityId, id)))
    .orderBy(desc(auditLog.at))
    .limit(50);
  return rows.map((r) => ({
    what: String((r.after as { note?: string } | null)?.note ?? ""),
    when: `${stampIST(r.at)} · ${r.name ?? "Someone"}, under the Founder hat`,
  }));
}

export async function addNote(userId: string, kind: string, id: string, note: string) {
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: userId,
    action: "founder.note",
    entityType: kind,
    entityId: id,
    actorRole: "admin",
    actorApp: "founder",
    afterState: { note } as never,
  });
}

/** Turn a thrown owning-app refusal into the Result the client shows. */
export function refusal(e: unknown): Result {
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, error: msg || "That did not go through." };
}

/** Owning actions return `{ ok, error, fieldErrors: [{field, message}] }` — normalise it. */
export function fromOwning(r: unknown, okMessage: string): Result {
  const x = r as
    | { ok?: boolean; error?: string; message?: string; fieldErrors?: { field: string; message: string }[] }
    | undefined;
  if (x && x.ok === false) {
    const fe: Record<string, string> = {};
    for (const f of x.fieldErrors ?? []) fe[f.field] = f.message;
    return { ok: false, error: x.error ?? "That did not go through.", fieldErrors: Object.keys(fe).length ? fe : undefined };
  }
  return { ok: true, message: x?.message ? `${okMessage} · ${x.message}` : okMessage };
}
